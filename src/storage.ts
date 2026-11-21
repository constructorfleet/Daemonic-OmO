import { createHash } from "node:crypto"
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readdirSync, readSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join, resolve } from "node:path"

import { decodeTaskRecord, type TaskRecord } from "./state.js"
import { parseEventTranscript, parseSessionTranscript } from "./transcript.js"

const MAX_TRANSCRIPT_BYTES = 512 * 1024

export interface StoreOptions {
  readonly stateDir?: string
  readonly agentDir?: string
  readonly env?: Readonly<Record<string, string | undefined>>
}

export interface TaskStoreSnapshot {
  readonly records: readonly TaskRecord[]
  readonly invalidRecords: number
}

export function resolveTaskStateDir(projectDir: string, options: StoreOptions = {}): string {
  if (options.stateDir !== undefined) return resolve(options.stateDir)
  const project = canonicalProjectPath(projectDir)
  const legacy = join(project, ".omo", "senpi-task")
  if (legacyStoreHasRecords(legacy)) return legacy

  const env = options.env ?? process.env
  const agentDir = options.agentDir ?? firstNonEmpty(
    env.OMO_CODING_AGENT_DIR,
    env.SENPI_CODING_AGENT_DIR,
    env.PI_CODING_AGENT_DIR,
  ) ?? join(env.HOME ?? env.USERPROFILE ?? homedir(), ".omo", "agent")
  const projectName = basename(project).replace(/[^\p{L}\p{N}._-]/gu, "_") || "root"
  const hash = createHash("sha256").update(project).digest("hex").slice(0, 12)
  return join(agentDir, "projects", `${projectName}-${hash}`, "senpi-task")
}

export function loadTaskRecords(stateDir: string): TaskStoreSnapshot {
  const tasksDir = join(stateDir, "tasks")
  let files: string[]
  try {
    files = readdirSync(tasksDir).filter((file) => file.endsWith(".json")).sort()
  } catch (error) {
    if (isMissing(error)) return { records: [], invalidRecords: 0 }
    throw error
  }

  const records: TaskRecord[] = []
  let invalidRecords = 0
  for (const file of files) {
    try {
      const path = join(tasksDir, file)
      if (statSync(path).size > MAX_TRANSCRIPT_BYTES) {
        invalidRecords += 1
        continue
      }
      const value: unknown = JSON.parse(readFileSync(path, "utf8"))
      const record = decodeTaskRecord(value)
      if (record === undefined) invalidRecords += 1
      else records.push(record)
    } catch {
      invalidRecords += 1
    }
  }
  return { records, invalidRecords }
}

export function readTaskTranscript(stateDir: string, taskId: string): readonly string[] {
  if (!/^[A-Za-z0-9_-]+$/.test(taskId)) return []
  const eventPath = join(stateDir, "logs", `${taskId}.jsonl`)
  const eventLog = parseEventTranscript(readTail(eventPath, MAX_TRANSCRIPT_BYTES) ?? "")
  if (eventLog.length > 0) return eventLog

  const sessionDir = join(stateDir, "children", taskId, "sessions", taskId)
  let files: string[]
  try {
    files = readdirSync(sessionDir).filter((file) => file.endsWith(".jsonl")).sort()
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }
  const chosen = files.length > 2 ? [files[0], files.at(-1)] : files
  return chosen.flatMap((file) => parseSessionTranscript(readTail(join(sessionDir, file!), MAX_TRANSCRIPT_BYTES) ?? ""))
}

function readTail(path: string, maxBytes: number): string | undefined {
  let fd: number
  try {
    fd = openSync(path, "r")
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
  try {
    const size = fstatSync(fd).size
    const start = Math.max(0, size - maxBytes)
    const buffer = Buffer.alloc(Math.min(size, maxBytes))
    const bytesRead = readSync(fd, buffer, 0, buffer.length, start)
    let text = buffer.subarray(0, bytesRead).toString("utf8")
    if (start > 0) {
      const firstNewline = text.indexOf("\n")
      text = firstNewline < 0 ? "" : text.slice(firstNewline + 1)
    }
    if (size > 0 && !text.endsWith("\n")) {
      const finalNewline = text.lastIndexOf("\n")
      text = finalNewline < 0 ? "" : text.slice(0, finalNewline + 1)
    }
    return text
  } finally {
    closeSync(fd)
  }
}

function legacyStoreHasRecords(path: string): boolean {
  if (!existsSync(path)) return false
  if (existsSync(join(path, ".in-project"))) return true
  try {
    return readdirSync(join(path, "tasks")).some((file) => file.endsWith(".json"))
  } catch {
    return false
  }
}

function canonicalProjectPath(projectDir: string): string {
  const absolute = resolve(projectDir)
  try {
    return realpathSync.native(absolute)
  } catch {
    return absolute
  }
}

function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  return values.map((value) => value?.trim()).find((value) => value !== undefined && value.length > 0)
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")
}
