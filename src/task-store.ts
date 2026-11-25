import { createHash } from "node:crypto"
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readdirSync, readSync, realpathSync, statSync, type Dirent } from "node:fs"
import { homedir } from "node:os"
import { basename, join, resolve } from "node:path"

import { decodeDagRun, type DagRunRecord } from "./dag.js"
import { decodeTaskRecord, type TaskRecord } from "./state.js"
import { parseTerminals } from "./terminals.js"
import {
  buildEventDocument,
  buildTranscriptDocument,
  parseEventErrors,
  parseEventTranscript,
  parseSessionTurns,
  type TranscriptDocument,
} from "./transcript.js"

const MAX_RECORD_BYTES = 256 * 1024
const MAX_RUN_BYTES = 512 * 1024
const ACTIVITY_TAIL_BYTES = 8 * 1024
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

export interface DagStoreSnapshot {
  readonly runs: readonly DagRunRecord[]
  readonly invalidRuns: number
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

export function loadDagRuns(stateDir: string): DagStoreSnapshot {
  let files: string[]
  try {
    files = readdirSync(join(stateDir, "dag", "runs")).filter((file) => file.endsWith(".json")).sort()
  } catch (error) {
    if (isMissing(error)) return { runs: [], invalidRuns: 0 }
    throw error
  }

  const runs: DagRunRecord[] = []
  let invalidRuns = 0
  for (const file of files) {
    try {
      const path = join(stateDir, "dag", "runs", file)
      if (statSync(path).size > MAX_RUN_BYTES) {
        invalidRuns += 1
        continue
      }
      const value: unknown = JSON.parse(readFileSync(path, "utf8"))
      const run = decodeDagRun(value)
      if (run === undefined) invalidRuns += 1
      else runs.push(run)
    } catch {
      invalidRuns += 1
    }
  }
  return { runs, invalidRuns }
}

/**
 * The live activity channel is not journaled, so the newest assistant message in the task
 * event log is the closest on-disk proxy. A bounded tail keeps refresh cheap.
 */
export function readTaskActivity(stateDir: string, taskId: string, maxBytes = ACTIVITY_TAIL_BYTES): string | undefined {
  if (!isSafeId(taskId)) return undefined
  const text = readTail(join(stateDir, "logs", `${taskId}.jsonl`), maxBytes)
  if (text === undefined) return undefined
  let activity: string | undefined
  for (const line of text.split("\n")) {
    if (!line.includes("assistant_message")) continue
    try {
      const value: unknown = JSON.parse(line)
      if (typeof value !== "object" || value === null) continue
      const type = (value as { type?: unknown }).type
      const payload = (value as { payload?: unknown }).payload
      if (type !== "assistant_message" || typeof payload !== "object" || payload === null) continue
      const message = (payload as { text?: unknown }).text
      if (typeof message !== "string") continue
      const normalized = normalizeActivity(message)
      if (normalized !== undefined) activity = normalized
    } catch {
      // A tail can start mid-record; ignore the torn line and keep the rest.
    }
  }
  return activity
}

function normalizeActivity(text: string): string | undefined {
  const normalized = text.replace(/\s+/gu, " ").trim()
  return normalized.length === 0 ? undefined : normalized
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
  if (document.lines.length === 0) return withTerminals(buildEventDocument(parseEventTranscript(eventText)), sessionText)
  return withTerminals(buildTranscriptDocument(turns, parseEventErrors(eventText)), sessionText)
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
  const text = texts.join("")
  return withTerminals(buildTranscriptDocument(parseSessionTurns(text)), text)
}

function withTerminals(document: TranscriptDocument, text: string): TranscriptDocument {
  if (text.length === 0) return document
  const terminals = parseTerminals(text)
  return terminals.items.length === 0 && terminals.sessionState === undefined ? document : { ...document, terminals }
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
