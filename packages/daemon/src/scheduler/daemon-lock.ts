import { mkdir, unlink } from "node:fs/promises"
import { join } from "node:path"

export class DaemonAlreadyRunningError extends Error {
  readonly name = "DaemonAlreadyRunningError"

  constructor(readonly socketPath: string) {
    super(`already running: daemon socket is active at ${socketPath}`)
  }
}

export interface DaemonLock {
  readonly socketPath: string
  release(): void
}

function isAddressInUse(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EADDRINUSE"
}

async function canConnect(socketPath: string): Promise<boolean> {
  try {
    await Bun.connect({
      unix: socketPath,
      socket: {
        data(socket) {
          socket.end()
        },
        open(socket) {
          socket.end()
        },
        error(socket) {
          socket.end()
        },
      },
    })
    return true
  } catch (error) {
    if (error instanceof Error && "code" in error &&
      (error.code === "ECONNREFUSED" || error.code === "ENOENT" || error.code === "ENOTSOCK")) return false
    throw error
  }
}

/** Binds `<home>/daemon.sock`; a live owner blocks startup, while a dead socket is removed and retried once. */
export async function acquireDaemonLock(home: string): Promise<DaemonLock> {
  await mkdir(home, { recursive: true, mode: 0o700 })
  const socketPath = join(home, "daemon.sock")
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const server = Bun.listen({ unix: socketPath, socket: { data() {} } })
      return {
        socketPath,
        release() {
          server.stop(true)
        },
      }
    } catch (error) {
      if (!isAddressInUse(error)) throw error
      if (await canConnect(socketPath)) throw new DaemonAlreadyRunningError(socketPath)
      await unlink(socketPath)
    }
  }
  throw new DaemonAlreadyRunningError(socketPath)
}
