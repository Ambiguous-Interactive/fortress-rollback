import test from "node:test"
import assert from "node:assert/strict"

import {
  createBudgetTracker,
  isReadOnlyTool,
  newBudgetState,
  normalizeMinutes,
  parseBudgetState,
  removeMutatingTools,
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
