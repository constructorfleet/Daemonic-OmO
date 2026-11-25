import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { acquireDaemonLock, DaemonAlreadyRunningError } from "../../src/scheduler/daemon-lock"

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function shortHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "o17-"))
  roots.push(root)
  return root
}

describe("single daemon lock", () => {
  test("a second instance on the same home exits with already running", async () => {
    const home = await shortHome()
    const first = await acquireDaemonLock(home)
    try {
      await expect(acquireDaemonLock(home)).rejects.toBeInstanceOf(DaemonAlreadyRunningError)
      await expect(acquireDaemonLock(home)).rejects.toThrow("already running")
    } finally {
      first.release()
    }
  })

  test("an unconnectable stale socket path is removed and rebound", async () => {
    const home = await shortHome()
    await writeFile(join(home, "daemon.sock"), "")
    const lock = await acquireDaemonLock(home)
    expect(lock.socketPath).toBe(join(home, "daemon.sock"))
    lock.release()
  })
})
