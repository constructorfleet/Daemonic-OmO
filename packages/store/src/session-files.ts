import { closeSync, openSync, readdirSync, readSync, statSync, type Dirent } from "node:fs"
import { join } from "node:path"

export interface SessionHeader {
  readonly id: string
  readonly cwd: string
  readonly version: number
}

export function findRootSessionFile(agentDir: string, sessionId: string): string | undefined {
  const sessionsDir = join(agentDir, "sessions")
  let directories: Dirent[]
  try {
    directories = readdirSync(sessionsDir, { withFileTypes: true })
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }

  const nestedFiles = directories.flatMap((directory) => {
    if (!directory.isDirectory()) return []
    const path = join(sessionsDir, directory.name)
    return readdirSync(path)
      .filter((name) => name.endsWith(`_${sessionId}.jsonl`))
      .map((name) => join(path, name))
  })
  if (nestedFiles.length > 0) {
    return nestedFiles.toSorted((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
  }

  const legacyFile = join(sessionsDir, `${sessionId}.jsonl`)
  try {
    return statSync(legacyFile).isFile() ? legacyFile : undefined
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

export function readSessionHeader(path: string): SessionHeader | undefined {
  const descriptor = openSync(path, "r")
  try {
    const buffer = Buffer.alloc(64 * 1024)
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0)
    const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0]
    if (firstLine === undefined || firstLine.length === 0) return undefined
    let entry: unknown
    try {
      entry = JSON.parse(firstLine)
    } catch (error) {
      if (error instanceof SyntaxError) return undefined
      throw error
    }
    if (!isRecord(entry) || entry.type !== "session") return undefined
    if (typeof entry.id !== "string" || typeof entry.cwd !== "string") return undefined
    if (typeof entry.version !== "number" || !Number.isFinite(entry.version)) return undefined
    return { id: entry.id, cwd: entry.cwd, version: entry.version }
  } finally {
    closeSync(descriptor)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")
}
