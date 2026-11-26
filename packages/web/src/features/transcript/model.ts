import { isRecord, requiredInteger, requiredString } from "../../lib/api-model-primitives"

export type TranscriptImage = {
  readonly sha256: string
  readonly mimeType: string
}

export type TranscriptResult = {
  readonly callId?: string
  readonly name?: string
  readonly isError: boolean
  readonly preview: string | null
  readonly images: readonly TranscriptImage[]
}

export type TranscriptTurn = {
  readonly id: string
  readonly summary: string
  readonly lines: readonly string[]
  readonly calls: readonly { readonly id?: string; readonly name: string }[]
  readonly results: readonly TranscriptResult[]
}

export type TranscriptTodo = {
  readonly done: number
  readonly total: number
  readonly open: number
  readonly now?: string
  readonly next?: string
  readonly activePhase?: string
  readonly phases: readonly {
    readonly name: string
    readonly items: readonly TodoItem[]
  }[]
  readonly remaining: readonly TodoItem[]
}

type TodoItem = {
  readonly text: string
  readonly status: "pending" | "in_progress" | "completed"
}

export type TranscriptSnapshot = {
  readonly mode: "session" | "events"
  readonly turns: readonly TranscriptTurn[]
  readonly hasOlder: boolean
  readonly todo: TranscriptTodo | null
  readonly errors: readonly string[]
  readonly events: readonly string[]
  readonly gone: boolean
}

export type TranscriptState = {
  readonly docId: string
  readonly epoch: number
  readonly rev: number
  readonly snapshot: TranscriptSnapshot
}

function stringList(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new TypeError(`${label} must be an array of strings`)
  }
  return value
}

function parseImage(value: unknown): TranscriptImage {
  if (!isRecord(value)) throw new TypeError("Transcript image must be an object")
  return { sha256: requiredString(value, "sha256"), mimeType: requiredString(value, "mimeType") }
}

function parseResult(value: unknown): TranscriptResult {
  if (!isRecord(value) || typeof value["isError"] !== "boolean") {
    throw new TypeError("Transcript result is invalid")
  }
  const preview = value["preview"]
  if (preview !== null && typeof preview !== "string") throw new TypeError("Transcript result preview is invalid")
  const images = value["images"]
  if (!Array.isArray(images)) throw new TypeError("Transcript result images must be an array")
  const callId = value["callId"]
  const name = value["name"]
  if ((callId !== undefined && typeof callId !== "string") || (name !== undefined && typeof name !== "string")) {
    throw new TypeError("Transcript result metadata is invalid")
  }
  return {
    isError: value["isError"],
    preview,
    images: images.map(parseImage),
    ...(typeof callId === "string" ? { callId } : {}),
    ...(typeof name === "string" ? { name } : {}),
  }
}

function parseTurn(value: unknown): TranscriptTurn {
  if (!isRecord(value) || !Array.isArray(value["calls"]) || !Array.isArray(value["results"])) {
    throw new TypeError("Transcript turn is invalid")
  }
  return {
    id: requiredString(value, "id"),
    summary: requiredString(value, "summary"),
    lines: stringList(value["lines"], "Transcript turn lines"),
    calls: value["calls"].map((entry) => {
      if (!isRecord(entry)) throw new TypeError("Transcript tool call is invalid")
      const id = entry["id"]
      if (id !== undefined && typeof id !== "string") throw new TypeError("Transcript tool call id is invalid")
      return {
        name: requiredString(entry, "name"),
        ...(typeof id === "string" ? { id } : {}),
      }
    }),
    results: value["results"].map(parseResult),
  }
}

function parseTodoItem(value: unknown): TodoItem {
  if (!isRecord(value)) throw new TypeError("Todo item is invalid")
  const status = (["pending", "in_progress", "completed"] as const)
    .find((candidate) => candidate === value["status"])
  if (status === undefined) throw new TypeError("Todo item status is unknown")
  return { text: requiredString(value, "text"), status }
}

function parseTodo(value: unknown): TranscriptTodo | null {
  if (value === null) return null
  if (!isRecord(value) || !Array.isArray(value["phases"]) || !Array.isArray(value["remaining"])) {
    throw new TypeError("Transcript todo is invalid")
  }
  const optionalText = (key: string): string | undefined => {
    const text = value[key]
    if (text !== undefined && typeof text !== "string") throw new TypeError(`Transcript todo ${key} is invalid`)
    return typeof text === "string" ? text : undefined
  }
  const now = optionalText("now")
  const next = optionalText("next")
  const activePhase = optionalText("activePhase")
  return {
    done: requiredInteger(value, "done"),
    total: requiredInteger(value, "total"),
    open: requiredInteger(value, "open"),
    phases: value["phases"].map((phase) => {
      if (!isRecord(phase) || !Array.isArray(phase["items"])) throw new TypeError("Todo phase is invalid")
      return { name: requiredString(phase, "name"), items: phase["items"].map(parseTodoItem) }
    }),
    remaining: value["remaining"].map(parseTodoItem),
    ...(now === undefined ? {} : { now }),
    ...(next === undefined ? {} : { next }),
    ...(activePhase === undefined ? {} : { activePhase }),
  }
}

function parseSnapshot(value: unknown): TranscriptSnapshot {
  if (!isRecord(value) || (value["mode"] !== "session" && value["mode"] !== "events")) {
    throw new TypeError("Transcript snapshot is invalid")
  }
  if (
    !Array.isArray(value["turns"]) || typeof value["hasOlder"] !== "boolean"
    || !Array.isArray(value["errors"]) || !Array.isArray(value["events"])
    || typeof value["gone"] !== "boolean"
  ) throw new TypeError("Transcript snapshot fields are invalid")
  return {
    mode: value["mode"],
    turns: value["turns"].map(parseTurn),
    hasOlder: value["hasOlder"],
    todo: parseTodo(value["todo"]),
    errors: stringList(value["errors"], "Transcript errors"),
    events: stringList(value["events"], "Transcript events"),
    gone: value["gone"],
  }
}

export function parseTranscriptState(value: unknown): TranscriptState {
  if (!isRecord(value)) throw new TypeError("Transcript document must be an object")
  return {
    docId: requiredString(value, "docId"),
    epoch: requiredInteger(value, "epoch"),
    rev: requiredInteger(value, "rev"),
    snapshot: parseSnapshot(value["snapshot"]),
  }
}

export function prependTranscriptPage(state: TranscriptState, value: unknown): TranscriptState | null {
  if (!isRecord(value) || value["docId"] !== state.docId || !Array.isArray(value["turns"])) return null
  if (typeof value["hasOlder"] !== "boolean") return null
  const older = value["turns"].map(parseTurn)
  const ids = new Set(older.map((turn) => turn.id))
  return {
    ...state,
    snapshot: {
      ...state.snapshot,
      turns: [...older, ...state.snapshot.turns.filter((turn) => !ids.has(turn.id))],
      hasOlder: value["hasOlder"],
    },
  }
}

export function applyTranscriptFrame(state: TranscriptState, value: unknown): TranscriptState | null {
  if (!isRecord(value) || value["docId"] !== state.docId || !Array.isArray(value["ops"])) return null
  const { epoch, fromRev, toRev, reset } = value
  if (
    typeof epoch !== "number" || !Number.isSafeInteger(epoch)
    || typeof fromRev !== "number" || !Number.isSafeInteger(fromRev)
    || typeof toRev !== "number" || !Number.isSafeInteger(toRev)
  ) return null
  const resetFrame = reset !== undefined || value["ops"].some((operation) =>
    isRecord(operation) && operation["op"] === "reset")
  if (resetFrame) {
    const snapshot = value["ops"].find((operation) => isRecord(operation) && operation["op"] === "snapshot")
    return snapshot === undefined
      ? null
      : { docId: state.docId, epoch, rev: toRev, snapshot: parseSnapshot(snapshot) }
  }
  if (epoch !== state.epoch || fromRev !== state.rev) return null
  let snapshot = state.snapshot
  for (const operation of value["ops"]) {
    if (!isRecord(operation)) return null
    switch (operation["op"]) {
      case "snapshot":
        snapshot = parseSnapshot(operation)
        break
      case "turn.add":
        snapshot = { ...snapshot, turns: [...snapshot.turns, parseTurn(operation["turn"])] }
        break
      case "turn.patch": {
        const turnId = requiredString(operation, "turnId")
        const updated = snapshot.turns.map((turn) => turn.id !== turnId ? turn : parseTurn({
          ...turn,
          lines: operation["lines"],
          results: operation["results"],
        }))
        snapshot = { ...snapshot, turns: updated }
        break
      }
      case "todo.set":
        snapshot = { ...snapshot, todo: parseTodo(operation["todo"]) }
        break
      case "error.add":
        snapshot = { ...snapshot, errors: [...snapshot.errors, requiredString(operation, "text")] }
        break
      case "event.add":
        snapshot = { ...snapshot, events: [...snapshot.events, ...stringList(operation["lines"], "Transcript event lines")] }
        break
      default:
        return null
    }
  }
  return { ...state, rev: toRev, snapshot }
}
