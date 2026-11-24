import test from "node:test"
import assert from "node:assert/strict"

import {
  createBudgetTracker,
  decideLease,
  isReadOnlyTool,
  newBudgetState,
  normalizeMinutes,
  parseBudgetState,
  removeMutatingTools,
  touchBudgetState,
} from "./session-budget-core.mjs"

function trackerAt(now) {
  return createBudgetTracker({ now: () => now.value, minutes: 180 })
}

test("starts once and reports no warning before the first threshold", () => {
  const now = { value: 0 }
  const budget = trackerAt(now)
  budget.start("session-1")
  now.value = 119 * 60 * 1000
  const status = budget.check("session-1")
  assert.equal(status.started, true)
  assert.equal(status.level, 0)
  assert.equal(status.message, undefined)
  assert.equal(status.blocked, false)
})

test("warns at 60, 30, and 15 remaining minutes", () => {
  const now = { value: 0 }
  const budget = trackerAt(now)
  budget.start("session-1")

  now.value = 120 * 60 * 1000
  assert.equal(budget.check("session-1").level, 120)
  assert.match(budget.check("session-1").message, /60 minutes remain/)

  now.value = 150 * 60 * 1000
  assert.equal(budget.check("session-1").level, 150)
  assert.match(budget.check("session-1").message, /30 minutes remain/)

  now.value = 165 * 60 * 1000
  assert.equal(budget.check("session-1").level, 165)
  assert.match(budget.check("session-1").message, /15 minutes remain/)
})

test("blocks at 180 minutes and after", () => {
  const now = { value: 0 }
  const budget = trackerAt(now)
  budget.start("session-1")

  now.value = 180 * 60 * 1000
  const atLimit = budget.check("session-1")
  assert.equal(atLimit.level, 180)
  assert.equal(atLimit.blocked, true)

  now.value = 240 * 60 * 1000
  assert.equal(budget.check("session-1").blocked, true)
})

test("does not reset an existing session clock", () => {
  const now = { value: 0 }
  const budget = trackerAt(now)
  budget.start("session-1")
  now.value = 60 * 60 * 1000
  budget.start("session-1")
  assert.equal(budget.remainingMs("session-1"), 120 * 60 * 1000)
})

test("tracks sessions independently", () => {
  const now = { value: 0 }
  const budget = trackerAt(now)
  budget.start("session-1")
  now.value = 30 * 60 * 1000
  budget.start("session-2")
  assert.equal(budget.check("session-1").remainingMinutes, 150)
  assert.equal(budget.check("session-2").remainingMinutes, 180)
})

test("forget removes the clock", () => {
  const budget = trackerAt({ value: 0 })
  budget.start("session-1")
  budget.forget("session-1")
  assert.equal(budget.check("session-1").started, false)
  assert.equal(budget.remainingMs("session-1"), undefined)
})

test("clamps configured minutes to the 180-minute maximum", () => {
  assert.equal(normalizeMinutes(240), 180)
  assert.equal(normalizeMinutes(180.7), 180)
  assert.equal(normalizeMinutes(30), 30)
  assert.equal(normalizeMinutes(Number.NaN), 180)
  assert.equal(normalizeMinutes("not-a-number"), 180)
})

test("allows only explicit read-only tools after the budget", () => {
  for (const tool of ["read", "grep", "glob", "list", "webfetch", "websearch", "skill"]) {
    assert.equal(isReadOnlyTool(tool), true, tool)
  }
  for (const tool of ["bash", "shell", "edit", "write", "patch", "task", "subagent", "write_file", "custom"]) {
    assert.equal(isReadOnlyTool(tool), false, tool)
  }
})

test("removes every non-read-only tool from a request", () => {
  const tools = { read: {}, grep: {}, bash: {}, shell: {}, custom: {}, subagent: {} }
  removeMutatingTools(tools)
  assert.deepEqual(Object.keys(tools).sort(), ["grep", "read"])
})

test("creates and parses a worktree budget state", () => {
  const now = Date.parse("2026-11-23T12:00:00Z")
  const state = newBudgetState("session-1", now, 180, 2)
  const parsed = parseBudgetState(JSON.stringify(state), now)

  assert.equal(parsed.ok, true)
  assert.equal(parsed.sessionId, "session-1")
  assert.equal(parsed.startedAt, now)
  assert.equal(parsed.expiresAt, now + 180 * 60 * 1000)
  assert.deepEqual(parsed.prs, [])
  assert.equal(parsed.prsExhausted, false)
  assert.equal(parsed.expired, false)
})

test("parses an expired or PR-exhausted budget", () => {
  const started = Date.parse("2026-11-23T12:00:00Z")
  const state = {
    session_id: "session-1",
    started_at: new Date(started).toISOString(),
    expires_at: new Date(started + 60 * 60 * 1000).toISOString(),
    minutes: 60,
    max_prs: 2,
    prs: [101, 102],
  }
  const parsed = parseBudgetState(JSON.stringify(state), started + 2 * 60 * 60 * 1000)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.expired, true)
  assert.equal(parsed.prsExhausted, true)
})

test("rejects malformed worktree budgets", () => {
  for (const raw of [
    "not json",
    "[]",
    JSON.stringify({ session_id: "s" }),
    JSON.stringify({
      session_id: "s",
      started_at: "2026-11-23T12:00:00Z",
      expires_at: "2026-11-23T11:00:00Z",
      minutes: 180,
      max_prs: 2,
      prs: [],
    }),
    JSON.stringify({
      session_id: "s",
      started_at: "2026-11-23T12:00:00Z",
      expires_at: "2026-11-23T15:00:00Z",
      minutes: 180,
      max_prs: 2,
      prs: ["bad"],
    }),
  ]) {
    assert.equal(parseBudgetState(raw).ok, false, raw)
  }
})

test("reuses the lease for the owning session", () => {
  const now = { value: 60 * 60 * 1000 }
  const state = parseBudgetState(
    JSON.stringify(newBudgetState("session-1", 0, 180, 2)),
    now.value,
  )

  assert.deepEqual(
    decideLease(state, "session-1", { ownerActive: true, now: now.value }),
    { action: "reuse" },
  )
})

test("takes over an expired lease from another session", () => {
  const state = parseBudgetState(
    JSON.stringify(newBudgetState("session-1", 0, 180, 2)),
    181 * 60 * 1000,
  )

  const decision = decideLease(state, "session-2", {
    ownerActive: true,
    now: 181 * 60 * 1000,
  })

  assert.equal(decision.action, "rotate")
  assert.equal(decision.reason, "expired")
})

test("takes over the lease when the owning session is idle", () => {
  const now = 60 * 60 * 1000
  const state = parseBudgetState(
    JSON.stringify(newBudgetState("session-1", 0, 180, 2)),
    now,
  )

  const decision = decideLease(state, "session-2", { ownerActive: false, now })

  assert.equal(decision.action, "rotate")
  assert.equal(decision.reason, "idle")
})

test("blocks takeover while the owning session is active", () => {
  const now = 60 * 60 * 1000
  const state = parseBudgetState(
    JSON.stringify(newBudgetState("session-1", 0, 180, 2)),
    now,
  )

  const decision = decideLease(state, "session-2", { ownerActive: true, now })

  assert.equal(decision.action, "block")
  assert.match(decision.reason, /active/)
})

test("blocks takeover of a recently active lease when owner activity is unknown", () => {
  const now = 60 * 60 * 1000
  const state = {
    ...newBudgetState("session-1", 0, 180, 2),
    updated_at: new Date(now - 60 * 1000).toISOString(),
  }
  const parsed = parseBudgetState(JSON.stringify(state), now)

  const decision = decideLease(parsed, "session-2", { now })

  assert.equal(decision.action, "block")
  assert.match(decision.reason, /recent activity/)
})

test("takes over a stale lease when owner activity is unknown", () => {
  const now = 60 * 60 * 1000
  const state = parseBudgetState(
    JSON.stringify(newBudgetState("session-1", 0, 180, 2)),
    now,
  )

  const decision = decideLease(state, "session-2", {
    now,
    handoffMs: 5 * 60 * 1000,
  })

  assert.equal(decision.action, "rotate")
  assert.equal(decision.reason, "stale")
})

test("touches activity without moving the deadline", () => {
  const started = Date.parse("2026-11-23T12:00:00Z")
  const state = parseBudgetState(
    JSON.stringify(newBudgetState("session-1", started, 180, 2)),
    started + 60 * 60 * 1000,
  )

  const touched = touchBudgetState(state, started + 60 * 60 * 1000)

  assert.equal(touched.updated_at, "2026-11-23T13:00:00.000Z")
  assert.equal(touched.started_at, "2026-11-23T12:00:00.000Z")
  assert.equal(touched.expires_at, "2026-11-23T15:00:00.000Z")
})

test("parses updated_at and reports idle time", () => {
  const started = Date.parse("2026-11-23T12:00:00Z")
  const state = {
    ...newBudgetState("session-1", started, 180, 2),
    updated_at: new Date(started + 30 * 60 * 1000).toISOString(),
  }
  const now = started + 45 * 60 * 1000
  const parsed = parseBudgetState(JSON.stringify(state), now)

  assert.equal(parsed.ok, true)
  assert.equal(parsed.updatedAt, started + 30 * 60 * 1000)
  assert.equal(parsed.idleMs, 15 * 60 * 1000)
})

test("rejects a present non-array prs field", () => {
  const state = newBudgetState("session-1", 0, 180, 2)
  state.prs = { 0: 101, 1: 102 }

  const parsed = parseBudgetState(JSON.stringify(state), 0)

  assert.equal(parsed.ok, false)
  assert.match(parsed.reason, /PR list/)
})

test("rejects updated_at before the session start", () => {
  const started = Date.parse("2026-11-23T12:00:00Z")
  const state = {
    ...newBudgetState("session-1", started, 180, 2),
    updated_at: new Date(started - 1000).toISOString(),
  }

  const parsed = parseBudgetState(JSON.stringify(state), started)

  assert.equal(parsed.ok, false)
  assert.match(parsed.reason, /updated_at/)
})

test("rejects updated_at in the future", () => {
  const started = Date.parse("2026-11-23T12:00:00Z")
  const now = started + 60 * 1000
  const state = {
    ...newBudgetState("session-1", started, 180, 2),
    updated_at: new Date(now + 10 * 60 * 1000).toISOString(),
  }

  const parsed = parseBudgetState(JSON.stringify(state), now)

  assert.equal(parsed.ok, false)
  assert.match(parsed.reason, /updated_at/)
})

test("restores a persisted original start without moving the deadline", () => {
  const now = { value: 170 * 60 * 1000 }
  const budget = createBudgetTracker({ now: () => now.value, minutes: 180 })
  budget.restore("session-1", 0)
  assert.equal(budget.startedAt("session-1"), 0)
  assert.equal(budget.remainingMs("session-1"), 10 * 60 * 1000)
  assert.equal(budget.check("session-1").level, 165)
  budget.restore("session-1", 99 * 60 * 1000)
  assert.equal(budget.startedAt("session-1"), 0)
})
