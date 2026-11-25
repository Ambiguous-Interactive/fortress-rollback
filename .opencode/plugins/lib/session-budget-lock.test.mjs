import test from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises"
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

test("fence rejects a writer after the lock is moved", async (t) => {
  const { lockPath } = await setup(t)
  const moved = `${lockPath}.moved`

  await withBudgetLock(lockPath, async ({ fence }) => {
    await rename(lockPath, moved)
    await assert.rejects(fence(), /lock was lost/)
  })

  await rm(moved, { recursive: true, force: true })
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

test("does not steal a lock directory whose owner is not published yet", async (t) => {
  const { lockPath } = await setup(t)
  // A winner between `mkdir(lockPath)` and publishing `owner` owns the lock.
  // A contender must wait rather than publish itself into that directory.
  await mkdir(lockPath)
  let entered = false

  await assert.rejects(
    withBudgetLock(
      lockPath,
      async () => {
        entered = true
        return "stolen"
      },
      { timeoutMs: 120, sleep },
    ),
    /timed out/,
  )

  assert.equal(entered, false)
  assert.equal(await exists(path.join(lockPath, "owner")), false)
})

test("retries when the held directory is released while waiting", async (t) => {
  const { lockPath } = await setup(t)
  const ownerPath = path.join(lockPath, "owner")
  await mkdir(lockPath)
  await writeFile(ownerPath, "other", "utf8")
  let removed = false

  // The holder releases exactly while the contender is waiting, which is the
  // production race that surfaced as a phantom "budget cannot be updated".
  const releaseDuringSleep = async () => {
    if (removed) return
    removed = true
    await rm(lockPath, { recursive: true, force: true })
  }

  const result = await withBudgetLock(
    lockPath,
    async ({ fence }) => {
      await fence()
      return "acquired"
    },
    { sleep: releaseDuringSleep },
  )

  assert.equal(result, "acquired")
  assert.equal(await exists(lockPath), false)
})

const STRESS_CHILD = `
const { withBudgetLock } = await import(process.argv[1])
const { readFile, writeFile } = await import("node:fs/promises")
const [lockPath, statePath, iterations] = process.argv.slice(2)
for (let index = 0; index < Number(iterations); index += 1) {
  await withBudgetLock(lockPath, async ({ fence }) => {
    const value = Number(await readFile(statePath, "utf8"))
    await new Promise((resolve) => setImmediate(resolve))
    await fence()
    await writeFile(statePath, String(value + 1))
  })
}
`

const runStressChild = (moduleUrl, lockPath, statePath, iterations) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        STRESS_CHILD,
        moduleUrl,
        lockPath,
        statePath,
        String(iterations),
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    )
    let stderr = ""
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk) => {
      stderr += chunk
    })
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) resolve()
      else reject(new Error(`stress child exited ${code}: ${stderr}`))
    })
  })

test("serializes read-modify-write across processes", async (t) => {
  const { root, lockPath } = await setup(t)
  const statePath = path.join(root, "state")
  await writeFile(statePath, "0")
  const moduleUrl = new URL("./session-budget-lock.mjs", import.meta.url).href

  await Promise.all(
    Array.from({ length: 4 }, () => runStressChild(moduleUrl, lockPath, statePath, 25)),
  )

  assert.equal(await readFile(statePath, "utf8"), "100")
})
