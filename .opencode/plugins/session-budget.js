import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"

import { Plugin } from "@opencode/plugin"

import { withBudgetLock } from "./lib/session-budget-lock.mjs"
import {
  createBudgetTracker,
  decideLease,
  isReadOnlyTool,
  newBudgetState,
  parseBudgetState,
  removeMutatingTools,
  touchBudgetState,
} from "./lib/session-budget-core.mjs"

const TOUCH_INTERVAL_MS = 30_000
const MAX_PARENT_DEPTH = 10

export default Plugin.define({
  id: "fortress.session-budget",
  async setup(ctx) {
    const requestedMinutes = Number(ctx.options?.minutes ?? 180)
    const directory = ctx.location?.directory ?? process.cwd()
    const budgetPath = path.join(directory, "progress", ".session-budget.json")
    const lockPath = `${budgetPath}.lock`
    if (Number.isFinite(requestedMinutes) && requestedMinutes > 180) {
      console.error("[session-budget] minutes capped at 180")
    }

    const registrations = []
    const timers = new Map()
    const trackers = new Map()
    const leaseStarts = new Map()
    const armed = new Set()
    const lastLevel = new Map()
    const lastNotice = new Map()
    const lastTouch = new Map()
    const busySessions = new Set()
    const rootCache = new Map()
    const controller = new AbortController()
    let activityKnown = false
    let toolGuardAvailable = false

    const clearTimer = (sessionID) => {
      const timer = timers.get(sessionID)
      if (timer !== undefined) clearTimeout(timer)
      timers.delete(sessionID)
    }

    const arm = (sessionID, state) => {
      if (armed.has(sessionID) && timers.has(sessionID)) return
      armed.add(sessionID)
      const remaining = state.expiresAt - Date.now()
      const timer = setTimeout(async () => {
        try {
          await ctx.session.interrupt({ sessionID, resume: false })
        } catch (error) {
          console.error("[session-budget] failed to interrupt:", error)
        }
      }, Math.max(0, remaining))
      timer.unref?.()
      timers.set(sessionID, timer)
    }

    const notifyOnce = (event, key, text) => {
      if (lastNotice.get(event.sessionID) === key) return
      lastNotice.set(event.sessionID, key)
      event.system.push({ type: "text", text })
    }

    const rootSessionID = async (sessionID) => {
      const cached = rootCache.get(sessionID)
      if (cached !== undefined) return cached
      let current = sessionID
      let resolved = false
      for (let depth = 0; depth < MAX_PARENT_DEPTH; depth += 1) {
        const known = rootCache.get(current)
        if (known !== undefined) {
          current = known
          resolved = true
          break
        }
        try {
          const session = await ctx.session.get({ sessionID: current })
          const info = session?.data ?? session
          const parentID = info?.parentID
          if (typeof parentID !== "string" || parentID.length === 0) {
            resolved = true
            break
          }
          current = parentID
        } catch {
          // Do not cache a partial resolution. A later call retries, and the
          // caller fails closed until the hierarchy is known.
          return undefined
        }
      }
      if (!resolved) return undefined
      rootCache.set(sessionID, current)
      return current
    }

    const ownerActive = async (ownerID) => {
      if (busySessions.has(ownerID)) return true
      let unresolved = false
      for (const sessionID of busySessions) {
        const root = await rootSessionID(sessionID)
        if (root === undefined) {
          unresolved = true
          continue
        }
        if (root === ownerID) return true
      }
      if (unresolved) return undefined
      if (!activityKnown) return undefined
      return false
    }

    const withTimeout = (promise, milliseconds, message) =>
      Promise.race([
        promise,
        new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new Error(message)), milliseconds)
          timer.unref?.()
        }),
      ])

    try {
      if (typeof ctx.session.active === "function") {
        const active = await withTimeout(
          ctx.session.active(),
          2_000,
          "session activity lookup timed out",
        )
        const data = active?.data ?? active ?? {}
        for (const sessionID of Object.keys(data)) busySessions.add(sessionID)
        activityKnown = true
      }
    } catch {
      activityKnown = false
    }

    const readBudget = async () => {
      try {
        return parseBudgetState(await readFile(budgetPath, "utf8"))
      } catch (error) {
        if (error?.code === "ENOENT") return { ok: false, missing: true }
        console.error("[session-budget] failed to read the worktree budget:", error)
        return { ok: false, reason: "the worktree budget cannot be read" }
      }
    }

    const writeBudget = async (state, fence) => {
      await mkdir(path.dirname(budgetPath), { recursive: true })
      const temporary = `${budgetPath}.${process.pid}.${Date.now()}.tmp`
      try {
        await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        })
        if (fence !== undefined) await fence()
        await rename(temporary, budgetPath)
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => {})
        throw error
      }
    }

    const trackerFor = (ownerID, state) => {
      const existing = trackers.get(ownerID)
      if (existing !== undefined && existing.expiresAt === state.expiresAt) {
        return existing.tracker
      }
      const tracker = createBudgetTracker({ minutes: state.minutes })
      tracker.restore(ownerID, state.startedAt)
      trackers.set(ownerID, { expiresAt: state.expiresAt, tracker })
      return tracker
    }

    const ready = (state, { rotated = false, previousSessionId } = {}) => ({
      ok: true,
      state,
      ownerId: state.sessionId,
      tracker: trackerFor(state.sessionId, state),
      rotated,
      previousSessionId,
    })

    const ensureBudget = async (sessionID) => {
      const ownerID = await rootSessionID(sessionID)
      if (ownerID === undefined) {
        return { ok: false, reason: "the session hierarchy cannot be resolved" }
      }
      try {
        return await withBudgetLock(lockPath, async ({ fence }) => {
          const existing = await readBudget()
          if (!existing.ok && !existing.missing) {
            return { ok: false, reason: existing.reason ?? "the worktree budget is malformed" }
          }
          if (existing.missing) {
            const state = newBudgetState(ownerID, Date.now(), requestedMinutes, 2)
            await writeBudget(state, fence)
            return ready(parseBudgetState(JSON.stringify(state)))
          }
          const decision = decideLease(existing, ownerID, {
            ownerActive: await ownerActive(existing.sessionId),
            now: Date.now(),
          })
          if (decision.action === "block") {
            return {
              ok: false,
              blocked: true,
              state: existing,
              ownerId: existing.sessionId,
              reason: decision.reason,
            }
          }
          if (decision.action === "rotate") {
            const state = newBudgetState(ownerID, Date.now(), existing.minutes, existing.maxPrs)
            await writeBudget(state, fence)
            console.error(
              `[session-budget] lease handed off from ${existing.sessionId} to ${ownerID} (${decision.reason})`,
            )
            return ready(parseBudgetState(JSON.stringify(state)), {
              rotated: true,
              previousSessionId: existing.sessionId,
            })
          }
          let current = existing
          const last = lastTouch.get(existing.sessionId) ?? 0
          if (Date.now() - last >= TOUCH_INTERVAL_MS) {
            const touched = touchBudgetState(existing, Date.now())
            await writeBudget(touched, fence)
            lastTouch.set(existing.sessionId, Date.now())
            current = parseBudgetState(JSON.stringify(touched))
          }
          return ready(current)
        })
      } catch (error) {
        console.error("[session-budget] failed to update the worktree budget:", error)
        return { ok: false, reason: "the worktree budget cannot be updated" }
      }
    }

    const startSession = async (sessionID) => {
      const state = await ensureBudget(sessionID)
      if (!state.ok) return state
      if (leaseStarts.get(sessionID) !== state.state.startedAt) {
        clearTimer(sessionID)
        armed.delete(sessionID)
        lastLevel.delete(sessionID)
        lastNotice.delete(sessionID)
        leaseStarts.set(sessionID, state.state.startedAt)
      }
      arm(sessionID, state.state)
      if (state.state.expired) {
        return {
          ...state,
          ok: false,
          expired: true,
          reason: "the 3-hour session budget is expired",
        }
      }
      return state
    }

    try {
      registrations.push(
        await ctx.session.hook("prompt", async (event) => {
          if (typeof event.sessionID !== "string") return
          if (!toolGuardAvailable) {
            throw new Error(
              "session-budget tool guard is unavailable; refusing to start an unguarded session",
            )
          }
          // Budget state never rejects a prompt. The context and tool hooks
          // remove mutating tools so read-only inspection stays available.
          await startSession(event.sessionID)
        }),
      )
      registrations.push(
        await ctx.session.hook("context", async (event) => {
          if (typeof event.sessionID !== "string") return
          if (!toolGuardAvailable) {
            removeMutatingTools(event.tools)
            notifyOnce(
              event,
              "guard-unavailable",
              "SESSION BUDGET: the tool guard is unavailable; mutating tools are removed from this request.",
            )
            return
          }
          const current = await startSession(event.sessionID)
          if (!current.ok) {
            removeMutatingTools(event.tools)
            const text = current.expired
              ? "SESSION BUDGET: the 3-hour budget is expired; only read-only inspection is allowed. Start a new chat to begin a new budget."
              : current.blocked
                ? `SESSION BUDGET: ${current.reason}; only read-only inspection is allowed until that chat is idle.`
                : `SESSION BUDGET: ${current.reason}; mutating tools are removed.`
            notifyOnce(event, `blocked:${current.reason}`, text)
            return
          }
          if (current.rotated) {
            const text = current.previousSessionId
              ? `SESSION BUDGET: took over the session lease from idle session ${current.previousSessionId}; the 3-hour clock starts now.`
              : "SESSION BUDGET: this session owns the session lease; the 3-hour clock starts now."
            notifyOnce(event, "lease-owned", text)
          }
          const status = current.tracker.check(current.ownerId)
          if (status.blocked) {
            removeMutatingTools(event.tools)
            notifyOnce(
              event,
              "expired",
              "SESSION BUDGET: the 3-hour budget is expired; only read-only inspection is allowed. Start a new chat to begin a new budget.",
            )
          }
          if (current.state.prsExhausted) {
            notifyOnce(
              event,
              "prs-exhausted",
              "SESSION BUDGET: the 2-PR budget is exhausted; finish the claimed PR and do not open another.",
            )
          }
          if (status.message === undefined) return
          if (status.level <= (lastLevel.get(event.sessionID) ?? 0)) return
          lastLevel.set(event.sessionID, status.level)
          event.system.push({ type: "text", text: status.message })
        }),
      )
    } catch (error) {
      for (const registration of registrations) await registration.dispose()
      throw error
    }

    try {
      registrations.push(
        await ctx.tool.hook("execute.before", async (event) => {
          if (typeof event.sessionID !== "string") return
          const current = await startSession(event.sessionID)
          if (!current.ok) {
            if (isReadOnlyTool(event.tool)) return
            const reason = current.expired
              ? "the 3-hour session budget is expired"
              : current.reason
            throw new Error(
              `SESSION BUDGET: ${reason}; only read-only inspection is allowed. Start a new chat to begin a new budget.`,
            )
          }
          if (current.tracker.check(current.ownerId).blocked) {
            if (isReadOnlyTool(event.tool)) return
            throw new Error(
              "SESSION BUDGET: the 3-hour session budget is expired; only read-only inspection is allowed. Start a new chat to begin a new budget.",
            )
          }
        }),
      )
      toolGuardAvailable = true
    } catch (error) {
      console.error("[session-budget] tool guard unavailable; prompts will be refused:", error)
    }

    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          types: ["session.status"],
          signal: controller.signal,
        })) {
          const { sessionID, status } = event.data
          if (status.type === "idle") busySessions.delete(sessionID)
          else busySessions.add(sessionID)
        }
      } catch (error) {
        activityKnown = false
        if (!controller.signal.aborted) {
          console.error("[session-budget] session activity subscription failed:", error)
        }
      }
    })()

    return async () => {
      controller.abort()
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      for (const registration of registrations) await registration.dispose()
      registrations.length = 0
      trackers.clear()
      leaseStarts.clear()
      armed.clear()
      lastLevel.clear()
      lastNotice.clear()
      lastTouch.clear()
      busySessions.clear()
      rootCache.clear()
    }
  },
})
