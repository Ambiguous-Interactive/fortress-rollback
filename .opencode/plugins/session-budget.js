import { Plugin } from "@opencode/plugin"

import { createBudgetTracker, isReadOnlyTool } from "./lib/session-budget-core.mjs"

const STORAGE_PREFIX = "session-budget:start:"

export default Plugin.define({
  id: "fortress.session-budget",
  async setup(ctx) {
    const requestedMinutes = Number(ctx.options?.minutes ?? 180)
    const budget = createBudgetTracker({ minutes: requestedMinutes })
    if (Number.isFinite(requestedMinutes) && requestedMinutes > 180) {
      console.error("[session-budget] minutes capped at 180")
    }
    const registrations = []
    const timers = new Map()
    const armed = new Set()
    const lastLevel = new Map()

    const clearTimer = (sessionID) => {
      const timer = timers.get(sessionID)
      if (timer !== undefined) clearTimeout(timer)
      timers.delete(sessionID)
    }

    const arm = (sessionID) => {
      if (armed.has(sessionID)) return
      const remaining = budget.remainingMs(sessionID)
      if (remaining === undefined) return
      armed.add(sessionID)
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

    const startSession = async (sessionID) => {
      if (budget.startedAt(sessionID) !== undefined) {
        arm(sessionID)
        return
      }
      let stored
      try {
        stored = await ctx.storage?.get(`${STORAGE_PREFIX}${sessionID}`)
      } catch (error) {
        console.error("[session-budget] failed to read the stored start:", error)
      }
      if (typeof stored === "number" && Number.isFinite(stored)) {
        budget.restore(sessionID, stored)
      } else {
        budget.start(sessionID)
        try {
          await ctx.storage?.set(`${STORAGE_PREFIX}${sessionID}`, budget.startedAt(sessionID))
        } catch (error) {
          console.error("[session-budget] failed to persist the start:", error)
        }
      }
      arm(sessionID)
    }

    try {
      registrations.push(
        await ctx.session.hook("prompt", async (event) => {
          if (typeof event.sessionID !== "string") return
          await startSession(event.sessionID)
        }),
      )
      registrations.push(
        await ctx.session.hook("context", async (event) => {
          if (typeof event.sessionID !== "string") return
          await startSession(event.sessionID)
          const status = budget.check(event.sessionID)
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
          await startSession(event.sessionID)
          const status = budget.check(event.sessionID)
          if (!status.blocked) return
          if (isReadOnlyTool(event.tool)) return
          throw new Error(
            `${status.message} Only read-only inspection is allowed; end the session and hand off.`,
          )
        }),
      )
    } catch (error) {
      console.error("[session-budget] tool guard unavailable:", error)
    }

    return async () => {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      for (const registration of registrations) await registration.dispose()
      registrations.length = 0
      armed.clear()
      lastLevel.clear()
    }
  },
})
