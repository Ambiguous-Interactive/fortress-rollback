import test from "node:test"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { withBudgetLock } from "./session-budget-lock.mjs"

const sleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

const exists = async (target) => {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

const setup = async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "fortress-lock-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, lockPath: path.join(root, "budget.lock") }
}

test("acquires and releases the budget lock directory", async (t) => {
  const { lockPath } = await setup(t)

  const result = await withBudgetLock(lockPath, async () => {
    assert.equal(await readFile(path.join(lockPath, "owner"), "utf8").then((value) => value.length > 0), true)
    return "ok"
  })

  assert.equal(result, "ok")
  assert.equal(await exists(lockPath), false)
})

test("releases the lock when the callback throws", async (t) => {
  const { lockPath } = await setup(t)

  await assert.rejects(
    withBudgetLock(lockPath, async () => {
      throw new Error("boom")
    }),
    /boom/,
  )

  assert.equal(await exists(lockPath), false)
})

test("does not steal a live lock owned by another session", async (t) => {
  const { lockPath } = await setup(t)
  await mkdir(lockPath)
  const ownerPath = path.join(lockPath, "owner")
  await writeFile(ownerPath, "other", "utf8")

  await assert.rejects(
    withBudgetLock(lockPath, async () => "no", {
      timeoutMs: 100,
      sleep,
    }),
    /timed out/,
  )

  assert.equal(await readFile(ownerPath, "utf8"), "other")
})

test("reaps a stale lock after a crash", async (t) => {
  const { lockPath } = await setup(t)
  await mkdir(lockPath)
  const ownerPath = path.join(lockPath, "owner")
  await writeFile(ownerPath, "stale", "utf8")
  const old = new Date(Date.now() - 120_000)
  await utimes(ownerPath, old, old)

  const result = await withBudgetLock(lockPath, async () => "recovered", {
    staleMs: 50,
  })

  assert.equal(result, "recovered")
  assert.equal(await exists(lockPath), false)
})

test("heartbeat keeps a live lock from being reaped", async (t) => {
  const { lockPath } = await setup(t)

  const holder = withBudgetLock(
    lockPath,
    async () => {
      await sleep(300)
      return "holder"
    },
    { staleMs: 100, heartbeatMs: 20 },
  )
  await sleep(50)

  await assert.rejects(
    withBudgetLock(lockPath, async () => "second", {
      staleMs: 100,
      heartbeatMs: 20,
      timeoutMs: 100,
      sleep,
    }),
    /timed out/,
  )

  assert.equal(await holder, "holder")
  assert.equal(await exists(lockPath), false)
})
