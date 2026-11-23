import test from "node:test"
import assert from "node:assert/strict"

import {
  createBudgetTracker,
  isReadOnlyTool,
  normalizeMinutes,
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
