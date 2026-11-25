import { basename } from "node:path"
import { formatTurnBody, parseEventErrors, parseEventTranscript, parseSessionTurns, type TodoState } from "@omo-daemonic/store"
import type { LimitsConfig } from "../config/types"
import type { ImageCache, StoredImage } from "./images"
import { JsonlCursor, readLines, type CursorRead } from "./jsonl-cursor"
import { TurnLog, type ImageRef, type ResultSummary, type TurnSummary } from "./turn-log"

export type DocResetReason = "rotated" | "truncated" | "missing" | "window"

export interface DocChange<Op> {
  /** Set when the document was rebuilt or lost its file; subscribers need a fresh snapshot. */
  readonly reset?: DocResetReason
  readonly ops: readonly Op[]
}

export type TranscriptOp =
  | { readonly op: "turn.add"; readonly turn: TurnSummary }
  | { readonly op: "turn.patch"; readonly turnId: string; readonly results: readonly ResultSummary[]; readonly lines: readonly string[]; readonly byteEnd: number }
  | { readonly op: "todo.set"; readonly todo: TodoState | null }
  | { readonly op: "error.add"; readonly text: string }
  | { readonly op: "event.add"; readonly lines: readonly string[] }

/** `files` is re-evaluated every poll; `eventLog` makes this a task document with the viewer's event-log fallback. */
export interface TranscriptSource {
  readonly files: () => readonly string[]
  readonly eventLog?: string
}

export interface TranscriptOptions {
  readonly readBytes: number
  readonly images: ImageCache
  readonly limits: Pick<LimitsConfig, "observerMaxTurns" | "observerMaxEventLines" | "observerMaxOlderTurns">
}

export interface TranscriptSnapshot {
  /** "events" mirrors the viewer showing the task event log when the session yields no lines. */
  readonly mode: "session" | "events"
  readonly turns: readonly TurnSummary[]
  readonly hasOlder: boolean
  readonly todo: TodoState | null
  readonly errors: readonly string[]
  readonly events: readonly string[]
  readonly gone: boolean
}

export interface TurnBody {
  readonly turnId: string
  readonly lines: readonly string[]
  readonly images: readonly ImageRef[]
}

interface FileState {
  readonly path: string
  readonly name: string
  readonly cursor: JsonlCursor
  started: boolean
  windowStart: number
}

interface Located {
  readonly id: string
  readonly path: string
  readonly byteStart: number
  readonly byteEnd: number
  readonly results: readonly ResultSummary[]
}

/**
 * One session (root) or child-task transcript, read incrementally from tail
 * cursors and kept as turn summaries; bodies are range-read on demand and
 * never cached.
 */
export class TranscriptDoc {
  readonly #source: TranscriptSource
  readonly #options: TranscriptOptions
  readonly #older = new Map<string, Located>()
  #files: FileState[] = []
  #events: JsonlCursor | undefined
  #log: TurnLog
  #errors: string[] = []
  #eventLines: string[] = []
  #todo = "null"
  #mode: TranscriptSnapshot["mode"] = "session"
  #gone = false
  #started = false

  constructor(source: TranscriptSource, options: TranscriptOptions) {
    this.#source = source
    this.#options = options
    this.#log = this.#freshLog()
  }

  /** Reads what changed since the last poll. The first poll bootstraps and returns null. */
  poll(): DocChange<TranscriptOp> | null {
    if (!this.#started) {
      this.#rebuild()
      this.#started = true
      return null
    }
    const files = this.#source.files()
    const known = this.#files.map((file) => file.path)
    if (files.length > 0 && !sameList(files, known)) {
      if (!sameList(files.slice(0, known.length), known)) return this.#reset("window")
      for (const path of files.slice(known.length)) this.#files.push(this.#fileState(path))
    }
    const ops: TranscriptOp[] = []
    for (const file of this.#files) {
      const read = file.cursor.read()
      if (read.reset === "missing") {
        this.#gone = true
        return { reset: "missing", ops: [] }
      }
      if (read.reset !== undefined || (read.bootstrap && file.started)) return this.#reset(read.reset ?? "rotated")
      this.#applySession(file, read, ops)
    }
    const events = this.#events?.read()
    if (events !== undefined) {
      if (events.reset !== undefined) return this.#reset(events.reset)
      this.#applyEvents(events, ops)
    }
    const mode = this.#currentMode()
    if (mode !== this.#mode) {
      this.#mode = mode
      return { reset: "window", ops: [] }
    }
    const todo = JSON.stringify(this.#log.todo ?? null)
    if (todo !== this.#todo) {
      this.#todo = todo
      ops.push({ op: "todo.set", todo: this.#log.todo ?? null })
    }
    const visible = this.#mode === "events" ? ops.filter((op) => op.op === "event.add") : ops.filter((op) => op.op !== "event.add")
    return visible.length === 0 ? null : { ops: visible }
  }

  snapshot(limit: number): TranscriptSnapshot {
    const turns = this.#log.turns
    return {
      mode: this.#mode,
      turns: turns.slice(-limit),
      hasOlder: turns.length > limit || this.#log.evicted || this.#files.some((file) => file.windowStart > 0),
      todo: this.#log.todo ?? null,
      errors: this.#errors,
      events: this.#eventLines,
      gone: this.#gone,
    }
  }

  /** Range-reads `[byteStart, byteEnd)` of the turn's file and formats the viewer's expanded body. */
  turnBody(turnId: string): TurnBody | undefined {
    const located = this.#locate(turnId)
    if (located === undefined) return undefined
    const text = readLines(located.path, located.byteStart, located.byteEnd, false).map((line) => line.text).join("\n")
    const turn = parseSessionTurns(text)[0]
    if (turn === undefined) return undefined
    const images = turn.results.flatMap((result) => (result.images ?? []).map((image) => ({
      sha256: this.#options.images.put(image.mimeType, image.data),
      mimeType: image.mimeType,
    })))
    return { turnId, lines: formatTurnBody(turn), images }
  }

  /** Turns older than `beforeTurnId`, from the retained window first, then by reading backwards from the oldest byteStart. */
  olderTurns(beforeTurnId: string, limit: number): { readonly turns: readonly TurnSummary[]; readonly hasOlder: boolean } | undefined {
    const retained = this.#log.turns
    const index = retained.findIndex((turn) => turn.id === beforeTurnId)
    if (index > 0) {
      const from = Math.max(0, index - limit)
      return { turns: retained.slice(from, index), hasOlder: from > 0 || this.snapshot(retained.length).hasOlder }
    }
    const located = this.#locate(beforeTurnId)
    return located === undefined ? undefined : this.#readOlder(located.path, located.byteStart, limit)
  }

  /** The image's bytes when one of this document's turns carries it; re-extracted by a range read after cache eviction. */
  image(sha256: string): StoredImage | undefined {
    const owner = [...this.#log.turns, ...this.#older.values()]
      .find((turn) => turn.results.some((result) => result.images.some((image) => image.sha256 === sha256)))
    if (owner === undefined) return undefined
    const cached = this.#options.images.get(sha256)
    if (cached !== undefined) return cached
    this.turnBody(owner.id)
    return this.#options.images.get(sha256)
  }

  #freshLog(): TurnLog {
    return new TurnLog(this.#options.images, this.#options.limits.observerMaxTurns)
  }

  #fileState(path: string): FileState {
    return { path, name: basename(path), cursor: new JsonlCursor(path, this.#options.readBytes), started: false, windowStart: 0 }
  }

  #reset(reason: DocResetReason): DocChange<TranscriptOp> {
    this.#rebuild()
    return { reset: reason, ops: [] }
  }

  #rebuild(): void {
    this.#log = this.#freshLog()
    this.#older.clear()
    this.#errors = []
    this.#eventLines = []
    this.#gone = false
    this.#files = this.#source.files().map((path) => this.#fileState(path))
    const eventLog = this.#source.eventLog
    this.#events = eventLog === undefined ? undefined : new JsonlCursor(eventLog, this.#options.readBytes)
    const ignored: TranscriptOp[] = []
    for (const file of this.#files) this.#applySession(file, file.cursor.read(), ignored)
    const events = this.#events?.read()
    if (events !== undefined) this.#applyEvents(events, ignored)
    this.#mode = this.#currentMode()
    this.#todo = JSON.stringify(this.#log.todo ?? null)
  }

  #applySession(file: FileState, read: CursorRead, ops: TranscriptOp[]): void {
    if (read.gone) return
    if (read.bootstrap) {
      file.started = true
      file.windowStart = read.windowStart
    }
    for (const line of read.lines) {
      const event = this.#log.apply(line, file.name)
      if (event === null) continue
      const turn = event.turn
      ops.push(event.kind === "add"
        ? { op: "turn.add", turn }
        : { op: "turn.patch", turnId: turn.id, results: turn.results, lines: turn.lines, byteEnd: turn.byteEnd })
    }
  }

  #applyEvents(read: CursorRead, ops: TranscriptOp[]): void {
    const added: string[] = []
    for (const line of read.lines) {
      added.push(...parseEventTranscript(line.text))
      for (const error of parseEventErrors(line.text)) {
        if (this.#errors.includes(error)) continue
        this.#errors = [...this.#errors, error]
        ops.push({ op: "error.add", text: error })
      }
    }
    if (added.length === 0) return
    this.#eventLines = [...this.#eventLines, ...added].slice(-this.#options.limits.observerMaxEventLines)
    ops.push({ op: "event.add", lines: added })
  }

  #currentMode(): TranscriptSnapshot["mode"] {
    if (this.#source.eventLog === undefined) return "session"
    return this.#log.turns.some((turn) => turn.lines.length > 0) ? "session" : "events"
  }

  #locate(turnId: string): Located | undefined {
    const turn = this.#log.get(turnId)
    if (turn === undefined) return this.#older.get(turnId)
    const path = this.#files.find((file) => file.name === turn.file)?.path
    return path === undefined ? undefined : { id: turn.id, path, byteStart: turn.byteStart, byteEnd: turn.byteEnd, results: turn.results }
  }

  #readOlder(path: string, before: number, limit: number): { readonly turns: readonly TurnSummary[]; readonly hasOlder: boolean } {
    const start = Math.max(0, before - this.#options.readBytes)
    const log = new TurnLog(this.#options.images, Number.POSITIVE_INFINITY)
    const name = basename(path)
    for (const line of readLines(path, start, before, true)) log.apply(line, name)
    const page = log.turns.slice(-limit)
    for (const turn of page) {
      if (this.#older.size >= this.#options.limits.observerMaxOlderTurns) this.#older.delete(this.#older.keys().next().value ?? "")
      this.#older.set(turn.id, { id: turn.id, path, byteStart: turn.byteStart, byteEnd: turn.byteEnd, results: turn.results })
    }
    const previous = this.#files[this.#files.findIndex((file) => file.path === path) - 1]
    if (page.length === 0 && start === 0 && previous !== undefined && previous.windowStart > 0) {
      return this.#readOlder(previous.path, previous.windowStart, limit)
    }
    return { turns: page, hasOlder: log.turns.length > limit || start > 0 || (previous?.windowStart ?? 0) > 0 }
  }
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}
