import { readdirSync, statSync, type Dirent } from "node:fs"
import { join } from "node:path"
import { readSessionHeader } from "@omo-daemonic/store"
import { isMissing } from "./jsonl-cursor"

const SAFE_ID = /^[A-Za-z0-9_-]+$/

export function isSafeId(value: string): boolean {
  return SAFE_ID.test(value)
}

/**
 * The root session file the viewer reads for `sessionId` (store `findRootSessionFile`,
 * which the store package does not export): the newest `sessions/<folder>/*_<id>.jsonl`,
 * else the legacy `sessions/<id>.jsonl`, rejected when its header names another session.
 */
export function rootSessionFile(agentDir: string, sessionId: string): string | undefined {
  if (!isSafeId(sessionId)) return undefined
  const sessionsDir = join(agentDir, "sessions")
  let folders: Dirent[]
  try {
    folders = readdirSync(sessionsDir, { withFileTypes: true })
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
  const nested = folders.flatMap((folder) => {
    if (!folder.isDirectory()) return []
    const path = join(sessionsDir, folder.name)
    return readdirSync(path).filter((name) => name.endsWith(`_${sessionId}.jsonl`)).map((name) => join(path, name))
  })
  const file = nested.length > 0
    ? nested.toSorted((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
    : legacyFile(join(sessionsDir, `${sessionId}.jsonl`))
  if (file === undefined) return undefined
  const header = readSessionHeader(file)
  return header !== undefined && header.id !== sessionId ? undefined : file
}

function legacyFile(path: string): string | undefined {
  try {
    return statSync(path).isFile() ? path : undefined
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

/** A child task's session files as the viewer reads them: sorted by name, only the first and last when there are more than two. */
export function childSessionFiles(stateDir: string, taskId: string): readonly string[] {
  if (!isSafeId(taskId)) return []
  const sessionDir = join(stateDir, "children", taskId, "sessions", taskId)
  let names: string[]
  try {
    names = readdirSync(sessionDir).filter((name) => name.endsWith(".jsonl")).sort()
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }
  const chosen = names.length > 2 ? [names[0], names.at(-1)] : names
  return chosen.flatMap((name) => name === undefined ? [] : [join(sessionDir, name)])
}

export function taskEventLog(stateDir: string, taskId: string): string | undefined {
  return isSafeId(taskId) ? join(stateDir, "logs", `${taskId}.jsonl`) : undefined
}
