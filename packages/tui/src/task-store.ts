import { createHash } from "node:crypto"
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readdirSync, readSync, realpathSync, statSync, type Dirent } from "node:fs"
import { homedir } from "node:os"
import { basename, join, resolve } from "node:path"

import { decodeTaskRecord, type TaskRecord } from "./state.js"
import {
  buildEventDocument,
  buildTranscriptDocument,
  parseEventErrors,
  parseEventTranscript,
  parseSessionTurns,
  type TranscriptDocument,
} from "./transcript.js"

const MAX_RECORD_BYTES = 256 * 1024
const DEFAULT_MAX_TRANSCRIPT_BYTES = 4 * 1024 * 1024

export interface TranscriptReadOptions {
  readonly maxBytes?: number
}

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

  const agentDir = resolveAgentDir(options)
  const projectName = basename(project).replace(/[^\p{L}\p{N}._-]/gu, "_") || "root"
  const hash = createHash("sha256").update(project).digest("hex").slice(0, 12)
  return join(agentDir, "projects", `${projectName}-${hash}`, "senpi-task")
}

export function resolveAgentDir(options: Pick<StoreOptions, "agentDir" | "env"> = {}): string {
  if (options.agentDir !== undefined) return resolve(options.agentDir)
  const env = options.env ?? process.env
  const agentDir = firstNonEmpty(
    env.OMO_CODING_AGENT_DIR,
    env.SENPI_CODING_AGENT_DIR,
    env.PI_CODING_AGENT_DIR,
  ) ?? join(env.HOME ?? env.USERPROFILE ?? homedir(), ".omo", "agent")
  return resolve(agentDir)
}

export function loadTaskRecords(stateDir: string): TaskStoreSnapshot {
  let files: string[]
  try {
    files = readdirSync(join(stateDir, "tasks")).filter((file) => file.endsWith(".json")).sort()
  } catch (error) {
    if (isMissing(error)) return { records: [], invalidRecords: 0 }
    throw error
  }

  const records: TaskRecord[] = []
  let invalidRecords = 0
  for (const file of files) {
    try {
      const path = join(stateDir, "tasks", file)
      if (statSync(path).size > MAX_RECORD_BYTES) {
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

export function readTaskDocument(
  stateDir: string,
  taskId: string,
  options: TranscriptReadOptions = {},
): TranscriptDocument {
  if (!isSafeId(taskId)) return buildEventDocument([])
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_TRANSCRIPT_BYTES
  const eventText = readTail(join(stateDir, "logs", `${taskId}.jsonl`), maxBytes) ?? ""
  const sessionText = readChildSessionText(stateDir, taskId, maxBytes)
  if (sessionText === undefined) return buildEventDocument(parseEventTranscript(eventText))
  const turns = parseSessionTurns(sessionText)
  const document = buildTranscriptDocument(turns)
  if (document.lines.length === 0) return buildEventDocument(parseEventTranscript(eventText))
  return buildTranscriptDocument(turns, parseEventErrors(eventText))
}

export function readRootDocument(
  agentDir: string,
  sessionId: string,
  options: TranscriptReadOptions = {},
): TranscriptDocument {
  if (!isSafeId(sessionId)) return buildEventDocument([])
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_TRANSCRIPT_BYTES
  const files = findRootSessionFiles(agentDir, sessionId)
  if (files.length === 0) return buildTranscriptDocument([])
  const chosen = files.length > 2 ? [files[0]!, files[files.length - 1]!] : files
  const texts = chosen
    .map((file) => readTail(file, maxBytes))
    .filter((text): text is string => text !== undefined)
  return buildTranscriptDocument(parseSessionTurns(texts.join("")))
}

/**
 * Root sessions live under `sessions/<encoded-project>/<timestamp>_<sessionId>.jsonl`.
 * Older stores kept them flat at `sessions/<sessionId>.jsonl`, so check both.
 */
function findRootSessionFiles(agentDir: string, sessionId: string): readonly string[] {
  const sessionsDir = join(agentDir, "sessions")
  const files: string[] = []
  const flat = join(sessionsDir, `${sessionId}.jsonl`)
  if (existsSync(flat)) files.push(flat)
  let entries: Dirent[]
  try {
    entries = readdirSync(sessionsDir, { withFileTypes: true })
  } catch (error) {
    if (isMissing(error)) return files
    throw error
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const directory = join(sessionsDir, entry.name)
    let names: string[]
    try {
      names = readdirSync(directory)
    } catch {
      continue
    }
    for (const name of names) {
      if (name === `${sessionId}.jsonl` || name.endsWith(`_${sessionId}.jsonl`)) {
        files.push(join(directory, name))
      }
    }
  }
  return files.sort()
}

function readChildSessionText(stateDir: string, taskId: string, maxBytes: number): string | undefined {
  const sessionDir = join(stateDir, "children", taskId, "sessions", taskId)
  let files: string[]
  try {
    files = readdirSync(sessionDir).filter((file) => file.endsWith(".jsonl")).sort()
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
  const chosen = files.length > 2 ? [files[0], files.at(-1)] : files
  const texts = chosen
    .map((file) => readTail(join(sessionDir, file!), maxBytes))
    .filter((text): text is string => text !== undefined)
  return texts.length === 0 ? undefined : texts.join("")
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

function isSafeId(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value)
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
