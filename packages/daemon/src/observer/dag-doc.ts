import { readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { decodeDagRunRecord, readDagEvents, type DagRunRecordV1 } from "@omo-daemonic/store"
import { isMissing } from "./jsonl-cursor"
import type { DocChange, TranscriptDoc, TranscriptSnapshot } from "./transcript-doc"

const TERMINAL_RUN_STATES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"])
const ASSISTANT_PREFIX = "assistant: "

export type DagEvent = Readonly<Record<string, unknown>>

export interface NodeActivity {
  readonly nodeId: string
  readonly taskId: string
  readonly turns: number
  readonly lastTool: string | null
  readonly lastAssistant: string | null
}

export type DagOp =
  | { readonly op: "run.set"; readonly run: DagRunRecordV1 | null }
  | { readonly op: "event.add"; readonly events: readonly DagEvent[] }
  | { readonly op: "node.activity"; readonly activity: NodeActivity }

export interface DagSnapshot {
  readonly run: DagRunRecordV1 | null
  readonly events: readonly DagEvent[]
  readonly activity: readonly NodeActivity[]
  readonly invalidEvents: number
  readonly unknownEvents: number
}

function signature(path: string): string {
  try {
    const info = statSync(path)
    return `${info.ino}:${info.size}:${info.mtimeMs}`
  } catch (error) {
    if (isMissing(error)) return "missing"
    throw error
  }
}

function seqOf(event: DagEvent): number {
  return typeof event.seq === "number" ? event.seq : 0
}

function activityOf(nodeId: string, taskId: string, snapshot: TranscriptSnapshot): NodeActivity {
  const turns = snapshot.turns.toReversed()
  const lastTool = turns.find((turn) => turn.calls.length > 0)?.calls.at(-1)?.name ?? null
  const lines = snapshot.mode === "events" ? snapshot.events : snapshot.turns.flatMap((turn) => turn.lines)
  const lastAssistant = lines.findLast((line) => line.startsWith(ASSISTANT_PREFIX))?.slice(ASSISTANT_PREFIX.length) ?? null
  return { nodeId, taskId, turns: snapshot.turns.length, lastTool, lastAssistant }
}

/**
 * `dag:<projectId>:<runId>`: the run record and its event journal from the
 * store, plus per-node live activity (turn count, latest tool call, last
 * assistant line) from the transcript doc of each node's attached task.
 */
export class DagDoc {
  readonly #tasks = new Map<string, TranscriptDoc>()
  readonly #activity = new Map<string, NodeActivity>()
  #runSignature = ""
  #eventsSignature = ""
  #run: DagRunRecordV1 | null = null
  #events: readonly DagEvent[] = []
  #invalidEvents = 0
  #unknownEvents = 0
  #started = false

  constructor(readonly stateDir: string, readonly runId: string, readonly taskDoc: (taskId: string) => TranscriptDoc) {}

  get active(): boolean {
    return this.#run !== null && !TERMINAL_RUN_STATES.has(this.#run.status)
  }

  poll(): DocChange<DagOp> | null {
    const ops: DagOp[] = []
    const runPath = join(this.stateDir, "dag", "runs", `${this.runId}.json`)
    const runSignature = signature(runPath)
    if (runSignature !== this.#runSignature) {
      const run = runSignature === "missing" ? null : this.#readRun(runPath)
      if (run !== undefined) {
        this.#runSignature = runSignature
        if (JSON.stringify(run) !== JSON.stringify(this.#run)) ops.push({ op: "run.set", run })
        this.#run = run
      }
    }
    const eventsSignature = signature(join(this.stateDir, "dag", "events", `${this.runId}.jsonl`))
    if (eventsSignature !== this.#eventsSignature) {
      this.#eventsSignature = eventsSignature
      const read = readDagEvents(this.stateDir, this.runId)
      const lastSeq = this.#events.reduce((max, event) => Math.max(max, seqOf(event)), 0)
      const rewound = read.events.length > 0 && Math.max(...read.events.map(seqOf)) < lastSeq
      const added = rewound ? read.events : read.events.filter((event) => seqOf(event) > lastSeq)
      this.#events = rewound ? read.events : [...this.#events, ...added]
      this.#invalidEvents = read.invalidEvents
      this.#unknownEvents = read.unknownEvents
      if (this.#started && rewound) return { reset: "rotated", ops: [] }
      if (added.length > 0) ops.push({ op: "event.add", events: added })
    }
    for (const [nodeId, taskId] of this.#attachments()) {
      const activity = activityOf(nodeId, taskId, this.#taskSnapshot(taskId))
      if (JSON.stringify(activity) === JSON.stringify(this.#activity.get(nodeId))) continue
      this.#activity.set(nodeId, activity)
      ops.push({ op: "node.activity", activity })
    }
    if (!this.#started) {
      this.#started = true
      return null
    }
    return ops.length === 0 ? null : { ops }
  }

  snapshot(): DagSnapshot {
    return {
      run: this.#run,
      events: this.#events,
      activity: [...this.#activity.values()],
      invalidEvents: this.#invalidEvents,
      unknownEvents: this.#unknownEvents,
    }
  }

  /** The decoded record, null when it does not decode, undefined while the file is mid-write (retried next poll). */
  #readRun(path: string): DagRunRecordV1 | null | undefined {
    let value: unknown
    try {
      value = JSON.parse(readFileSync(path, "utf8"))
    } catch (error) {
      if (error instanceof SyntaxError || isMissing(error)) return undefined
      throw error
    }
    return decodeDagRunRecord(value) ?? null
  }

  /** Node id to attached task id: the run record's `taskId`, overridden by later `dag.node.task-attached` events. */
  #attachments(): ReadonlyMap<string, string> {
    const attached = new Map<string, string>()
    for (const node of this.#run?.nodes ?? []) if (node.taskId !== undefined) attached.set(node.id, node.taskId)
    for (const event of this.#events) {
      if (event.type === "dag.node.task-attached" && typeof event.nodeId === "string" && typeof event.taskId === "string") {
        attached.set(event.nodeId, event.taskId)
      }
    }
    return attached
  }

  #taskSnapshot(taskId: string): TranscriptSnapshot {
    let doc = this.#tasks.get(taskId)
    if (doc === undefined) {
      doc = this.taskDoc(taskId)
      this.#tasks.set(taskId, doc)
    }
    doc.poll()
    return doc.snapshot(Number.MAX_SAFE_INTEGER)
  }
}
