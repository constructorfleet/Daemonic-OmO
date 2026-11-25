import { readFileSync, readdirSync, statSync, type Dirent } from "node:fs"
import { join } from "node:path"

import { decodeDagRun, type DagNodeRecord, type DagRunRecord } from "./dag.js"
import { FileCursor } from "./tail-reader.js"

const MAX_RUN_BYTES = 512 * 1024
const EVENT_TYPES = new Set([
  "dag.run.created", "dag.run.started", "dag.run.paused", "dag.run.resumed", "dag.run.completed",
  "dag.run.failed", "dag.run.cancelled", "dag.wave.started", "dag.wave.completed", "dag.node.transitioned",
  "dag.node.task-attached", "dag.node.reused", "dag.node.retried", "dag.node.steered",
  "dag.definition.amended", "dag.diagnostic.added", "dag.stream.overflow", "dag.guidance.added",
  "dag.guidance.edited", "dag.guidance.removed", "dag.guidance.dispatching", "dag.guidance.delivered",
  "dag.node.cancel_requested", "dag.node.retry-staged", "dag.node.pause-recovered", "dag.node.pause-lost",
])

export type DagStoreNode = DagNodeRecord & {
  readonly prompt?: string
  readonly lastError?: Readonly<Record<string, unknown>>
}
export type DagRunRecordV1 = Omit<DagRunRecord, "nodes"> & {
  readonly runKey?: string
  readonly parentSessionId?: string
  readonly generation?: number
  readonly updatedAt?: string
  readonly startedAt?: string
  readonly completedAt?: string
  readonly nodes: readonly DagStoreNode[]
  readonly edges: readonly { readonly from: string; readonly to: string }[]
  readonly criticalPath: readonly string[]
  readonly bottlenecks: readonly Readonly<Record<string, unknown>>[]
  readonly diagnostics: readonly Readonly<Record<string, unknown>>[]
  readonly amendHistory: readonly Readonly<Record<string, unknown>>[]
}
export type DagStoreSnapshot = {
  readonly runs: readonly DagRunRecordV1[]
  readonly invalidRuns: number
}
export type DagEventSnapshot = {
  readonly events: readonly Readonly<Record<string, unknown>>[]
  readonly invalidEvents: number
  readonly unknownEvents: number
}

export function decodeDagRunRecord(value: unknown): DagRunRecordV1 | undefined {
  if (!isRecord(value) || (value.schemaVersion !== undefined && value.schemaVersion !== 1)) return undefined
  const decoded = decodeDagRun(value)
  if (decoded === undefined) return undefined
  const nodes = decoded.nodes.map((node) => {
    const raw = Array.isArray(value.nodes) ? value.nodes.find((entry) => isRecord(entry) && entry.id === node.id) : undefined
    if (!isRecord(raw)) return node
    return {
      ...node,
      ...(text(raw.prompt) === undefined ? {} : { prompt: text(raw.prompt) }),
      ...(isRecord(raw.lastError) ? { lastError: raw.lastError } : {}),
    }
  })
  const edges = arrayOfRecords(value.edges)
    .filter((edge): edge is Readonly<Record<string, unknown>> & { readonly from: string; readonly to: string } =>
      typeof edge.from === "string" && typeof edge.to === "string")
    .map(({ from, to }) => ({ from, to }))
  return {
    ...decoded,
    ...(text(value.runKey) === undefined ? {} : { runKey: text(value.runKey) }),
    ...(text(value.parentSessionId) === undefined ? {} : { parentSessionId: text(value.parentSessionId) }),
    ...(number(value.generation) === undefined ? {} : { generation: number(value.generation) }),
    ...(text(value.updatedAt) === undefined ? {} : { updatedAt: text(value.updatedAt) }),
    ...(text(value.startedAt) === undefined ? {} : { startedAt: text(value.startedAt) }),
    ...(text(value.completedAt) === undefined ? {} : { completedAt: text(value.completedAt) }),
    nodes,
    edges,
    criticalPath: strings(value.criticalPath),
    bottlenecks: arrayOfRecords(value.bottlenecks),
    diagnostics: arrayOfRecords(value.diagnostics),
    amendHistory: arrayOfRecords(value.amendHistory),
  }
}

export function loadDagRuns(stateDir: string): DagStoreSnapshot {
  const directory = join(stateDir, "dag", "runs")
  let files: Dirent[]
  try {
    files = readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
  } catch (error) {
    if (isMissing(error)) return { runs: [], invalidRuns: 0 }
    throw error
  }
  const runs: DagRunRecordV1[] = []
  let invalidRuns = 0
  for (const file of files.toSorted((a, b) => a.name.localeCompare(b.name))) {
    try {
      const path = join(directory, file.name)
      if (statSync(path).size > MAX_RUN_BYTES) {
        invalidRuns += 1
        continue
      }
      const record = decodeDagRunRecord(JSON.parse(readFileSync(path, "utf8")))
      if (record === undefined) invalidRuns += 1
      else runs.push(record)
    } catch {
      invalidRuns += 1
    }
  }
  return { runs, invalidRuns }
}

export function readDagEvents(stateDir: string, runId: string): DagEventSnapshot {
  if (!isSafeSegment(runId)) return { events: [], invalidEvents: 0, unknownEvents: 0 }
  const path = join(stateDir, "dag", "events", `${runId}.jsonl`)
  const cursor = new FileCursor(path)
  const tail = cursor.read()
  const events: Readonly<Record<string, unknown>>[] = []
  let invalidEvents = 0
  let unknownEvents = 0
  for (const line of tail.lines) {
    try {
      const event: unknown = JSON.parse(line)
      if (!isRecord(event) || event.schemaVersion !== 1 || event.runId !== runId ||
        !Number.isSafeInteger(event.seq) || typeof event.at !== "string" ||
        (event.lane !== "boundary" && event.lane !== "activity") || typeof event.type !== "string") {
        invalidEvents += 1
      } else if (!EVENT_TYPES.has(event.type)) {
        unknownEvents += 1
      } else {
        events.push(event)
      }
    } catch {
      invalidEvents += 1
    }
  }
  return { events, invalidEvents: invalidEvents + tail.oversizedLines, unknownEvents }
}

function arrayOfRecords(value: unknown): readonly Readonly<Record<string, unknown>>[] {
  return Array.isArray(value) ? value.filter(isRecord) : []
}
function strings(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined
}
function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
function isSafeSegment(value: string): boolean {
  return value.length > 0 && value !== "." && value !== ".." && !value.includes("/") && !value.includes("\\")
}
function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")
}
