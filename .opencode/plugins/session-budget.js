import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

import { Plugin } from "@opencode/plugin"

import {
  createBudgetTracker,
  isReadOnlyTool,
  newBudgetState,
  parseBudgetState,
  removeMutatingTools,
} from "./lib/session-budget-core.mjs"

export default Plugin.define({
  id: "fortress.session-budget",
  async setup(ctx) {
    const requestedMinutes = Number(ctx.options?.minutes ?? 180)
    const directory = ctx.location?.directory ?? process.cwd()
    const budgetPath = path.join(directory, "progress", ".session-budget.json")
    if (Number.isFinite(requestedMinutes) && requestedMinutes > 180) {
      console.error("[session-budget] minutes capped at 180")
    }

    const registrations = []
    const timers = new Map()
    const trackers = new Map()
    const leaseStarts = new Map()
    const armed = new Set()
    const lastLevel = new Map()
    let toolGuardAvailable = false

    const clearTimer = (sessionID) => {
      const timer = timers.get(sessionID)
      if (timer !== undefined) clearTimeout(timer)
      timers.delete(sessionID)
    }

    const arm = (sessionID, state) => {
      if (armed.has(sessionID)) return
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

    const readBudget = async () => {
      try {
        return parseBudgetState(await readFile(budgetPath, "utf8"))
      } catch (error) {
        if (error?.code === "ENOENT") return { ok: false, missing: true }
        console.error("[session-budget] failed to read the worktree budget:", error)
        return { ok: false, reason: "the worktree budget cannot be read" }
      }
    }

    const ensureBudget = async (sessionID) => {
      const existing = await readBudget()
      if (existing.ok || !existing.missing) return existing
      const state = newBudgetState(sessionID, Date.now(), requestedMinutes, 2)
      try {
        await mkdir(path.dirname(budgetPath), { recursive: true })
        await writeFile(budgetPath, `${JSON.stringify(state, null, 2)}\n`, {
          encoding: "utf8",
          flag: "wx",
        })
      } catch (error) {
        if (error?.code !== "EEXIST") {
          console.error("[session-budget] failed to create the worktree budget:", error)
          return { ok: false, reason: "the worktree budget cannot be created" }
        }
      }
      return readBudget()
    }

    const trackerFor = (sessionID, state) => {
      const existing = trackers.get(sessionID)
      if (existing !== undefined && existing.expiresAt === state.expiresAt) {
        return existing.tracker
      }
      const tracker = createBudgetTracker({ minutes: state.minutes })
      tracker.restore(sessionID, state.startedAt)
      trackers.set(sessionID, { expiresAt: state.expiresAt, tracker })
      return tracker
    }

    const startSession = async (sessionID) => {
      const state = await ensureBudget(sessionID)
      if (!state.ok) return { ok: false, reason: state.reason ?? "budget unavailable" }
      if (leaseStarts.get(sessionID) !== state.startedAt) {
        clearTimer(sessionID)
        armed.delete(sessionID)
        lastLevel.delete(sessionID)
        leaseStarts.set(sessionID, state.startedAt)
      }
      const tracker = trackerFor(sessionID, state)
      arm(sessionID, state)
      if (state.expired) {
        return { ok: false, reason: "the 3-hour session budget is expired" }
      }
      if (state.prsExhausted) {
        return { ok: false, reason: "the 2-PR session budget is exhausted" }
      }
      return { ok: true, state, tracker }
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
          const ready = await startSession(event.sessionID)
          if (!ready.ok) {
            throw new Error(`session-budget: ${ready.reason}; start a fresh session`)
          }
        }),
      )
      registrations.push(
        await ctx.session.hook("context", async (event) => {
          if (typeof event.sessionID !== "string") return
          if (!toolGuardAvailable) {
            removeMutatingTools(event.tools)
            event.system.push({
              type: "text",
              text: "SESSION BUDGET: the tool guard is unavailable; mutating tools are removed from this request.",
            })
            return
          }
          const ready = await startSession(event.sessionID)
          if (!ready.ok) {
            removeMutatingTools(event.tools)
            event.system.push({
              type: "text",
              text: `SESSION BUDGET: ${ready.reason}; mutating tools are removed until a fresh session starts.`,
            })
            return
          }
          const status = ready.tracker.check(event.sessionID)
          if (status.blocked || ready.state.prsExhausted) {
            removeMutatingTools(event.tools)
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
          const ready = await startSession(event.sessionID)
          if (!ready.ok) {
            if (isReadOnlyTool(event.tool)) return
            throw new Error(
              `SESSION BUDGET: ${ready.reason}; only read-only inspection is allowed until a fresh session starts.`,
            )
          }
          const status = ready.tracker.check(event.sessionID)
          if (!status.blocked && !ready.state.prsExhausted) return
          if (isReadOnlyTool(event.tool)) return
          const reason = ready.state.prsExhausted
            ? "the 2-PR session budget is exhausted"
            : "the 3-hour session budget is expired"
          throw new Error(
            `SESSION BUDGET: ${reason}; only read-only inspection is allowed.`,
          )
        }),
      )
      toolGuardAvailable = true
    } catch (error) {
      console.error("[session-budget] tool guard unavailable; prompts will be refused:", error)
    }

    return async () => {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      for (const registration of registrations) await registration.dispose()
      registrations.length = 0
      trackers.clear()
      leaseStarts.clear()
      armed.clear()
      lastLevel.clear()
    }
  },
})
