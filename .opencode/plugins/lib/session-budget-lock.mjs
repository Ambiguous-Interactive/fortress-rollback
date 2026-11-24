import { mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import path from "node:path"

export const LOCK_STALE_MS = 10_000
export const LOCK_HEARTBEAT_MS = 1_000
export const LOCK_TIMEOUT_MS = 5_000

const defaultSleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

const modifiedAt = async (ownerPath, lockPath) => {
  try {
    return (await stat(ownerPath)).mtimeMs
  } catch {
    try {
      return (await stat(lockPath)).mtimeMs
    } catch {
      return undefined
    }
  }
}

export async function withBudgetLock(
  lockPath,
  callback,
  {
    staleMs = LOCK_STALE_MS,
    heartbeatMs = LOCK_HEARTBEAT_MS,
    timeoutMs = LOCK_TIMEOUT_MS,
    now = Date.now,
    sleep = defaultSleep,
    token = randomUUID(),
  } = {},
) {
  const ownerPath = path.join(lockPath, "owner")
  await mkdir(path.dirname(lockPath), { recursive: true })
  const deadline = now() + timeoutMs
  for (;;) {
    if (now() >= deadline) throw new Error("timed out waiting for the worktree budget")
    try {
      await mkdir(lockPath)
      break
    } catch (error) {
      if (error?.code !== "EEXIST") throw error
      const modified = await modifiedAt(ownerPath, lockPath)
      if (modified === undefined) {
        await sleep(25)
        continue
      }
      if (now() - modified > staleMs) {
        let observedOwner
        try {
          observedOwner = await readFile(ownerPath, "utf8")
        } catch {
          observedOwner = undefined
        }
        // Rename before removal so two reapers cannot delete a fresh lock that
        // a winner created between the stat and the unlink.
        const stale = `${lockPath}.stale.${token}`
        try {
          await rename(lockPath, stale)
        } catch {
          await sleep(25)
          continue
        }
        let renamedOwner
        let renamedModified
        try {
          renamedOwner = await readFile(path.join(stale, "owner"), "utf8")
          renamedModified = (await stat(path.join(stale, "owner"))).mtimeMs
        } catch {
          renamedOwner = undefined
          renamedModified = undefined
        }
        if (
          renamedOwner !== observedOwner ||
          (renamedModified !== undefined && now() - renamedModified <= staleMs)
        ) {
          // A heartbeat or a fresh owner replaced the stale lock between our
          // stat and rename. Put it back instead of entering the critical section.
          await rename(stale, lockPath).catch(() => {})
          await sleep(25)
          continue
        }
        await rm(stale, { recursive: true, force: true }).catch(() => {})
        continue
      }
      if (now() >= deadline) throw new Error("timed out waiting for the worktree budget")
      await sleep(25)
    }
  }

  try {
    await writeFile(ownerPath, token, { encoding: "utf8", mode: 0o600 })
  } catch (error) {
    await rm(lockPath, { recursive: true, force: true }).catch(() => {})
    throw error
  }

  let released = false
  const heartbeat = setInterval(() => {
    if (released) return
    void utimes(ownerPath, new Date(), new Date()).catch(() => {})
  }, heartbeatMs)
  heartbeat.unref?.()
  const fence = async () => {
    try {
      const current = await readFile(ownerPath, "utf8")
      if (current !== token) throw new Error("the worktree budget lock was lost")
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new Error("the worktree budget lock was lost")
      }
      throw error
    }
  }
  try {
    return await callback({ fence })
  } finally {
    released = true
    clearInterval(heartbeat)
    try {
      const current = await readFile(ownerPath, "utf8")
      if (current === token) {
        await rm(lockPath, { recursive: true, force: true })
      }
      // A reaped or replaced lock belongs to another owner; leave it.
    } catch {
      // The lock disappeared before release; nothing to clean up.
    }
  }
}
