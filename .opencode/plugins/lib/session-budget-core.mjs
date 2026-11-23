const DEFAULT_MINUTES = 180
const MAX_MINUTES = 180
const READ_ONLY_TOOLS = new Set([
  "read",
  "grep",
  "glob",
  "list",
  "webfetch",
  "websearch",
  "skill",
])
const WARNINGS = [
  { level: 120, remainingMinutes: 60, action: "stop starting new work and finish the current step" },
  { level: 150, remainingMinutes: 30, action: "run full validation and open or update the PR" },
  { level: 165, remainingMinutes: 15, action: "write the handoff and sync the worktree" },
  { level: 180, remainingMinutes: 0, action: "stop; the session budget is exhausted" },
]

export function isReadOnlyTool(tool) {
  return typeof tool === "string" && READ_ONLY_TOOLS.has(tool)
}

export function removeMutatingTools(tools) {
  if (tools === undefined || tools === null) return
  for (const name of Object.keys(tools)) {
    if (!isReadOnlyTool(name)) delete tools[name]
  }
}

export function normalizeMinutes(value) {
  const requested = Number(value)
  if (!Number.isFinite(requested)) return DEFAULT_MINUTES
  return Math.min(MAX_MINUTES, Math.max(1, requested))
}

export function createBudgetTracker({
  now = Date.now,
  minutes = DEFAULT_MINUTES,
  warnings = WARNINGS,
} = {}) {
  const budgetMs = normalizeMinutes(minutes) * 60 * 1000
  const starts = new Map()

  function start(sessionID, at = now()) {
    if (typeof sessionID !== "string" || sessionID.length === 0) return undefined
    if (!starts.has(sessionID)) starts.set(sessionID, at)
    return starts.get(sessionID)
  }

  function restore(sessionID, startedAt) {
    if (typeof sessionID !== "string" || sessionID.length === 0) return
    if (!Number.isFinite(startedAt)) return
    if (!starts.has(sessionID)) starts.set(sessionID, startedAt)
  }

  function startedAt(sessionID) {
    return starts.get(sessionID)
  }

  function remainingMs(sessionID) {
    const started = starts.get(sessionID)
    if (started === undefined) return undefined
    return budgetMs - (now() - started)
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

  return { start, restore, startedAt, remainingMs, check, forget, budgetMs }
}

export { DEFAULT_MINUTES, MAX_MINUTES, READ_ONLY_TOOLS, WARNINGS }
