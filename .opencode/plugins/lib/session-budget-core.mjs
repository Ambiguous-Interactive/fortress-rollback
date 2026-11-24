const DEFAULT_MINUTES = 180
const MAX_MINUTES = 180
const DEFAULT_MAX_PRS = 2
const MAX_PRS = 2
const DEFAULT_HANDOFF_MS = 5 * 60 * 1000
const CLOCK_SKEW_MS = 60 * 1000
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

export function newBudgetState(
  sessionId,
  now = Date.now(),
  minutes = DEFAULT_MINUTES,
  maxPrs = DEFAULT_MAX_PRS,
) {
  const safeMinutes = normalizeMinutes(minutes)
  const safeMaxPrs = Math.min(MAX_PRS, Math.max(1, Number(maxPrs) || DEFAULT_MAX_PRS))
  const startedAt = new Date(now)
  const expiresAt = new Date(now + safeMinutes * 60 * 1000)
  return {
    session_id: sessionId,
    started_at: startedAt.toISOString(),
    expires_at: expiresAt.toISOString(),
    updated_at: startedAt.toISOString(),
    minutes: safeMinutes,
    max_prs: safeMaxPrs,
    prs: [],
  }
}

export function parseBudgetState(raw, now = Date.now()) {
  let state
  try {
    state = JSON.parse(raw)
  } catch {
    return { ok: false, reason: "session budget is not valid JSON" }
  }
  if (state === null || typeof state !== "object" || Array.isArray(state)) {
    return { ok: false, reason: "session budget must be a JSON object" }
  }
  const sessionId = state.session_id
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return { ok: false, reason: "session budget is missing its session id" }
  }
  const startedAt = Date.parse(state.started_at)
  const expiresAt = Date.parse(state.expires_at)
  if (!Number.isFinite(startedAt) || !Number.isFinite(expiresAt)) {
    return { ok: false, reason: "session budget has invalid timestamps" }
  }
  if (expiresAt <= startedAt) {
    return { ok: false, reason: "session budget expiry precedes its start" }
  }
  const minutes = Number.isInteger(state.minutes) ? state.minutes : DEFAULT_MINUTES
  if (minutes < 1 || minutes > MAX_MINUTES) {
    return { ok: false, reason: "session budget minutes are out of range" }
  }
  const maxPrs = Number.isInteger(state.max_prs) ? state.max_prs : DEFAULT_MAX_PRS
  if (maxPrs < 1 || maxPrs > MAX_PRS) {
    return { ok: false, reason: "session budget max_prs is out of range" }
  }
  if (state.prs !== undefined && !Array.isArray(state.prs)) {
    return { ok: false, reason: "session budget PR list is malformed" }
  }
  const rawPrs = state.prs ?? []
  if (!rawPrs.every((number) => Number.isInteger(number) && number > 0)) {
    return { ok: false, reason: "session budget PR list is malformed" }
  }
  let updatedAt = startedAt
  if (state.updated_at !== undefined) {
    updatedAt = Date.parse(state.updated_at)
    if (!Number.isFinite(updatedAt)) {
      return { ok: false, reason: "session budget updated_at is invalid" }
    }
    if (updatedAt < startedAt) {
      return { ok: false, reason: "session budget updated_at precedes its start" }
    }
    if (updatedAt > now + CLOCK_SKEW_MS) {
      return { ok: false, reason: "session budget updated_at is in the future" }
    }
  }
  const prs = [...new Set(rawPrs)].sort((left, right) => left - right)
  return {
    ok: true,
    sessionId,
    startedAt,
    expiresAt,
    updatedAt,
    idleMs: Math.max(0, now - updatedAt),
    minutes,
    maxPrs,
    prs,
    expired: now >= expiresAt,
    prsExhausted: prs.length >= maxPrs,
  }
}

export function decideLease(
  state,
  sessionId,
  { ownerActive, now = Date.now(), handoffMs = DEFAULT_HANDOFF_MS } = {},
) {
  if (state === undefined || state === null || state.ok !== true) {
    return {
      action: "block",
      reason: state?.reason ?? "the session budget is unavailable",
    }
  }
  if (state.sessionId === sessionId) return { action: "reuse" }
  if (state.expired) return { action: "rotate", reason: "expired" }
  if (ownerActive === true) {
    return { action: "block", reason: "another session is active" }
  }
  if (ownerActive === false) return { action: "rotate", reason: "idle" }
  if (now - state.updatedAt >= handoffMs) {
    return { action: "rotate", reason: "stale" }
  }
  return { action: "block", reason: "the owning session has recent activity" }
}

export function touchBudgetState(state, now = Date.now()) {
  return {
    session_id: state.sessionId,
    started_at: new Date(state.startedAt).toISOString(),
    expires_at: new Date(state.expiresAt).toISOString(),
    updated_at: new Date(now).toISOString(),
    minutes: state.minutes,
    max_prs: state.maxPrs,
    prs: [...state.prs],
  }
}

export function normalizeMinutes(value) {
  const requested = Number(value)
  if (!Number.isFinite(requested)) return DEFAULT_MINUTES
  return Math.min(MAX_MINUTES, Math.max(1, Math.trunc(requested)))
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

export {
  DEFAULT_HANDOFF_MS,
  DEFAULT_MAX_PRS,
  DEFAULT_MINUTES,
  MAX_MINUTES,
  MAX_PRS,
  READ_ONLY_TOOLS,
  WARNINGS,
}
