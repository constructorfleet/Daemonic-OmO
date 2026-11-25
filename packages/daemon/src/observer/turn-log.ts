import {
  formatSessionTranscript,
  parseSessionTurns,
  parseTodoReport,
  summarizeTurn,
  type TodoState,
  type TranscriptToolResult,
  type TranscriptTurn,
} from "@omo-daemonic/store"
import type { ImageCache } from "./images"
import type { JsonlLine } from "./jsonl-cursor"

const FORMAT = { toolDetail: true, thinkingPreview: true } as const
/** parseSessionTurns drops a toolResult with no turn before it, so a lone result line is parsed behind this empty assistant entry. */
const RESULT_HOST = JSON.stringify({ type: "message", message: { role: "assistant", content: [] } })
/** The id parseSessionTurns gives the first turn of a text when its entry has neither id nor timestamp. */
const UNIDENTIFIED_TURN = "turn-0"

export interface ImageRef {
  readonly sha256: string
  readonly mimeType: string
}

export interface ResultSummary {
  readonly callId?: string
  readonly name?: string
  readonly isError: boolean
  /** The viewer's result line; null for results the viewer hides (todo). */
  readonly preview: string | null
  readonly images: readonly ImageRef[]
}

export interface TurnSummary {
  readonly id: string
  readonly file: string
  readonly byteStart: number
  readonly byteEnd: number
  readonly summary: string
  readonly lines: readonly string[]
  readonly calls: readonly { readonly id?: string; readonly name: string }[]
  readonly results: readonly ResultSummary[]
}

export type TurnEvent =
  | { readonly kind: "add"; readonly turn: TurnSummary }
  | { readonly kind: "patch"; readonly turn: TurnSummary }

type Entry =
  | { readonly kind: "turn"; readonly turn: TranscriptTurn }
  | { readonly kind: "result"; readonly result: TranscriptToolResult }

/** Accumulator: one turn per assistant entry, mutated as its tool results arrive. */
interface TurnState {
  summary: TurnSummary
  readonly headLines: readonly string[]
  todo: TodoState | undefined
}

function parseEntry(text: string): Entry | null {
  const turn = parseSessionTurns(text)[0]
  if (turn !== undefined) return { kind: "turn", turn }
  if (!text.includes("\"toolResult\"")) return null
  const result = parseSessionTurns(`${RESULT_HOST}\n${text}`)[0]?.results[0]
  return result === undefined ? null : { kind: "result", result }
}

/**
 * Builds the viewer's turns (`parseSessionTurns` semantics) one session line at a
 * time, keeping only summaries and the viewer's formatted lines. A result
 * attaches to the turn that made its call, else to the newest turn.
 */
export class TurnLog {
  readonly #turns: TurnState[] = []
  readonly #byId = new Map<string, TurnState>()
  readonly #byCall = new Map<string, TurnState>()
  #evicted = false

  constructor(readonly images: ImageCache, readonly maxTurns: number) {}

  apply(line: JsonlLine, file: string): TurnEvent | null {
    const entry = parseEntry(line.text)
    if (entry === null) return null
    switch (entry.kind) {
      case "turn":
        return { kind: "add", turn: this.#add(entry.turn, line, file) }
      case "result": {
        const state = this.#attach(entry.result, line, file)
        return state === undefined ? null : { kind: "patch", turn: state.summary }
      }
      default: {
        const unreachable: never = entry
        throw new TypeError(`unexpected entry ${JSON.stringify(unreachable)}`)
      }
    }
  }

  get turns(): readonly TurnSummary[] {
    return this.#turns.map((state) => state.summary)
  }

  get evicted(): boolean {
    return this.#evicted
  }

  get(id: string): TurnSummary | undefined {
    return this.#byId.get(id)?.summary
  }

  /** The viewer's `lastTodoReport`: the last parseable todo result of the newest turn that has one. */
  get todo(): TodoState | undefined {
    for (let index = this.#turns.length - 1; index >= 0; index -= 1) {
      const todo = this.#turns[index]?.todo
      if (todo !== undefined) return todo
    }
    return undefined
  }

  #add(turn: TranscriptTurn, line: JsonlLine, file: string): TurnSummary {
    const base = turn.id === UNIDENTIFIED_TURN ? `off:${file}:${line.start}` : turn.id
    const id = this.#byId.has(base) ? `${file}#${base}` : base
    const headLines = formatSessionTranscript([turn], FORMAT)
    const calls = turn.parts.flatMap((part) => part.kind === "call"
      ? [{ name: part.call.name, ...(part.call.id === undefined ? {} : { id: part.call.id }) }]
      : [])
    const state: TurnState = {
      summary: { id, file, byteStart: line.start, byteEnd: line.end, summary: summarizeTurn(turn), lines: headLines, calls, results: [] },
      headLines,
      todo: undefined,
    }
    this.#turns.push(state)
    this.#byId.set(id, state)
    for (const call of calls) if (call.id !== undefined) this.#byCall.set(call.id, state)
    if (this.#turns.length > this.maxTurns) this.#evictOldest()
    return state.summary
  }

  #attach(result: TranscriptToolResult, line: JsonlLine, file: string): TurnState | undefined {
    const state = (result.callId === undefined ? undefined : this.#byCall.get(result.callId)) ?? this.#turns.at(-1)
    if (state === undefined) return undefined
    const preview = formatSessionTranscript([{ id: "", thinking: [], parts: [], results: [result] }], FORMAT)[0] ?? null
    const images = (result.images ?? []).map((image) => ({ sha256: this.images.put(image.mimeType, image.data), mimeType: image.mimeType }))
    const summary: ResultSummary = {
      isError: result.isError,
      preview,
      images,
      ...(result.callId === undefined ? {} : { callId: result.callId }),
      ...(result.name === undefined ? {} : { name: result.name }),
    }
    if (result.name === "todo" && result.text !== undefined) state.todo = parseTodoReport(result.text) ?? state.todo
    const previous = state.summary
    const results = [...previous.results, summary]
    state.summary = {
      ...previous,
      byteEnd: file === previous.file ? Math.max(previous.byteEnd, line.end) : previous.byteEnd,
      results,
      lines: [...state.headLines, ...results.flatMap((entry) => entry.preview === null ? [] : [entry.preview])],
    }
    return state
  }

  #evictOldest(): void {
    const oldest = this.#turns.shift()
    if (oldest === undefined) return
    this.#evicted = true
    this.#byId.delete(oldest.summary.id)
    for (const call of oldest.summary.calls) {
      if (call.id !== undefined && this.#byCall.get(call.id) === oldest) this.#byCall.delete(call.id)
    }
  }
}
