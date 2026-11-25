import { readFileSync } from "node:fs"
import { join } from "node:path"

export type TaskStoreIndexEntry = {
  readonly firstSeen?: string
  readonly lastSeen?: string
}
export type TaskStoreIndex = {
  readonly stores: Readonly<Record<string, TaskStoreIndexEntry>>
  readonly invalidRecords: number
}

export function readTaskStoreIndex(agentDir: string): TaskStoreIndex {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(agentDir, "rpc", "task-stores.json"), "utf8"))
    if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.stores)) return { stores: {}, invalidRecords: 1 }
    const stores: Record<string, TaskStoreIndexEntry> = {}
    let invalidRecords = 0
    for (const [path, entry] of Object.entries(parsed.stores)) {
      if (!isRecord(entry) || !isTimestamp(entry.first_seen) || !isTimestamp(entry.last_seen)) {
        invalidRecords += 1
        continue
      }
      stores[path] = { firstSeen: entry.first_seen, lastSeen: entry.last_seen }
    }
    return { stores, invalidRecords }
  } catch (error) {
    if (isMissing(error)) return { stores: {}, invalidRecords: 0 }
    if (error instanceof SyntaxError) return { stores: {}, invalidRecords: 1 }
    throw error
  }
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")
}
