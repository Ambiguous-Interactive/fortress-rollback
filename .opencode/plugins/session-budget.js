import { Plugin } from "@opencode/plugin"

import { createBudgetTracker } from "./lib/session-budget-core.mjs"

const MUTATING_TOOLS = new Set(["bash", "edit", "write", "patch", "task"])

export default Plugin.define({
  id: "fortress.session-budget",
  async setup(ctx) {
    const configuredMinutes = Number(ctx.options?.minutes ?? 180)
    const budget = createBudgetTracker({ minutes: configuredMinutes })
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

    try {
      registrations.push(
        await ctx.session.hook("prompt", (event) => {
          if (typeof event.sessionID !== "string") return
          budget.start(event.sessionID)
          arm(event.sessionID)
        }),
      )
      registrations.push(
        await ctx.session.hook("context", (event) => {
          if (typeof event.sessionID !== "string") return
          const status = budget.check(event.sessionID)
          if (status.message === undefined) return
          if (status.level <= (lastLevel.get(event.sessionID) ?? 0)) return
          lastLevel.set(event.sessionID, status.level)
          event.system.push({ type: "text", text: status.message })
        }),
      )
      registrations.push(
        await ctx.tool.hook("execute.before", (event) => {
          if (typeof event.sessionID !== "string") return
          const status = budget.check(event.sessionID)
          if (!status.blocked) return
          if (!MUTATING_TOOLS.has(event.tool)) return
          throw new Error(
            `${status.message} Read-only inspection is still allowed; end the session and hand off.`,
          )
        }),
      )
    } catch (error) {
      for (const registration of registrations) await registration.dispose()
      throw error
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
