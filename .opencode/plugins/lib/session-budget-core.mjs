const DEFAULT_MINUTES = 180
const WARNINGS = [
  { level: 120, remainingMinutes: 60, action: "stop starting new work and finish the current step" },
  { level: 150, remainingMinutes: 30, action: "run full validation and open or update the PR" },
  { level: 165, remainingMinutes: 15, action: "write the handoff and sync the worktree" },
  { level: 180, remainingMinutes: 0, action: "stop; the session budget is exhausted" },
]

export function createBudgetTracker({
  now = Date.now,
  minutes = DEFAULT_MINUTES,
  warnings = WARNINGS,
} = {}) {
  const budgetMs = Math.max(1, Number(minutes) || DEFAULT_MINUTES) * 60 * 1000
  const starts = new Map()

  function start(sessionID) {
    if (typeof sessionID !== "string" || sessionID.length === 0) return
    if (!starts.has(sessionID)) starts.set(sessionID, now())
  }

  function remainingMs(sessionID) {
    const startedAt = starts.get(sessionID)
    if (startedAt === undefined) return undefined
    return budgetMs - (now() - startedAt)
  }

  function check(sessionID) {
    const remaining = remainingMs(sessionID)
    if (remaining === undefined) return { started: false, level: 0, message: undefined, blocked: false }
    const remainingMinutes = remaining / 60000
    const warning = [...warnings]
      .sort((left, right) => left.remainingMinutes - right.remainingMinutes)
      .find((candidate) => remainingMinutes <= candidate.remainingMinutes)
    const rounded = Math.max(0, Math.ceil(remainingMinutes))
    return {
      started: true,
      remainingMinutes,
      level: warning?.level ?? 0,
      blocked: remaining <= 0,
      message: warning
        ? `SESSION BUDGET: ${rounded} minutes remain. ${warning.action}.`
        : undefined,
    }
  }

  function forget(sessionID) {
    starts.delete(sessionID)
  }

  return { start, remainingMs, check, forget, budgetMs }
}

export { DEFAULT_MINUTES, WARNINGS }
