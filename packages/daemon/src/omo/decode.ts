import { sessionId as toSessionId, threadId as toThreadId } from "../core/ids"
import {
  GATEWAY_ERROR_CODES,
  type CloseOutcome,
  type CloseReason,
  type CompletionBinding,
  type CompletionOutcome,
  type CompletionStatus,
  type CreateOutcome,
  type GatewayAck,
  type GatewayErrorCode,
  type GatewayRefusal,
  type GatewayResult,
  type SendOutcome,
  type ThreadSnapshot,
  type ThreadState,
} from "../core/ports"

/**
 * Parses thread SDK answers (the same JSON unions as `omo thread --json`, pinned by todo 5's FINDINGS.md and
 * fixtures) into Gateway port values. A refusal is `{kind: "error", error: {code, message}}`; `interrupt` nests
 * one more `{kind: "error", ...}` inside `error`, which carries `code` at the same level.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function refusal(code: GatewayErrorCode, message: string): GatewayRefusal {
  return { kind: "error", code, message }
}

function ok<T>(value: T): GatewayResult<T> {
  return { kind: "ok", value }
}

export function refusalOf(raw: unknown): GatewayRefusal | null {
  if (!isRecord(raw) || raw.kind !== "error") return null
  const error = isRecord(raw.error) ? raw.error : {}
  const code = typeof error.code === "string" ? error.code : "internal"
  const message = typeof error.message === "string" ? error.message : JSON.stringify(raw.error ?? null)
  const known = GATEWAY_ERROR_CODES.find((candidate) => candidate === code)
  return known === undefined ? refusal("internal", `${code}: ${message}`) : refusal(known, message)
}

function decodeOk<T>(raw: unknown, method: string, decode: (answer: Record<string, unknown>) => T | null): GatewayResult<T> {
  const refused = refusalOf(raw)
  if (refused !== null) return refused
  const decoded = isRecord(raw) && raw.kind === "ok" ? decode(raw) : null
  return decoded === null ? refusal("internal", `unrecognized ${method} answer`) : ok(decoded)
}

/** The thread id is the session's durable id (FINDINGS assertion 3). The SDK never reports a reopen except through `prompt.deduplicated`. */
export function decodeCreate(raw: unknown): GatewayResult<CreateOutcome> {
  return decodeOk(raw, "create", (answer) => {
    if (typeof answer.thread !== "string") return null
    const reopened = isRecord(answer.prompt) && answer.prompt.deduplicated === true
    return { thread: toThreadId(answer.thread), sessionId: toSessionId(answer.thread), created: !reopened }
  })
}

export function decodeSend(raw: unknown): GatewayResult<SendOutcome> {
  return decodeOk(raw, "send", (answer) => {
    const delivery = isRecord(answer.delivery) ? answer.delivery.kind : null
    return { delivered: typeof delivery === "string" && delivery !== "queued_offline", deduplicated: answer.deduplicated === true }
  })
}

const CLOSE_REASONS: readonly CloseReason[] = ["closed", "not_live", "timeout"]

export function decodeClose(raw: unknown): GatewayResult<CloseOutcome> {
  return decodeOk(raw, "close", (answer) => {
    const reason = CLOSE_REASONS.find((candidate) => candidate === answer.reason)
    return typeof answer.closed === "boolean" && reason !== undefined ? { closed: answer.closed, reason } : null
  })
}

export function decodeAck(raw: unknown, method: string): GatewayAck {
  const decoded = decodeOk(raw, method, () => true)
  return decoded.kind === "ok" ? { kind: "ok" } : decoded
}

export function decodeBinding(raw: unknown): GatewayResult<CompletionBinding> {
  return decodeOk(raw, "bindCompletion", (answer) => {
    if (typeof answer.binding_id !== "string" || typeof answer.thread !== "string" || !Array.isArray(answer.events)) return null
    return { bindingId: answer.binding_id, thread: toThreadId(answer.thread), events: answer.events.filter((event) => typeof event === "string") }
  })
}

/** `omo thread list --json` documents an array but 5.1.79 prints `{kind: "ok", threads, scope, ...}` (FINDINGS assertion 10). */
export function parseThreadList(raw: unknown): GatewayResult<readonly ThreadSnapshot[]> {
  const refused = refusalOf(raw)
  if (refused !== null) return refused
  const rows = Array.isArray(raw) ? raw : isRecord(raw) && raw.kind === "ok" && Array.isArray(raw.threads) ? raw.threads : null
  if (rows === null) return refusal("internal", "unrecognized list answer")
  return ok(rows.flatMap((row) => {
    const snapshot = isRecord(row) ? threadSnapshot(row) : null
    return snapshot === null ? [] : [snapshot]
  }))
}

function threadSnapshot(row: Record<string, unknown>): ThreadSnapshot | null {
  if (typeof row.thread !== "string" || typeof row.name !== "string") return null
  return {
    thread: toThreadId(row.thread),
    name: row.name,
    cwd: typeof row.cwd === "string" ? row.cwd : "",
    state: threadState(row),
    controls: Array.isArray(row.controls) ? row.controls.filter((control) => typeof control === "string") : [],
    sessionId: toSessionId(row.thread),
    surface: typeof row.surface === "string" ? row.surface : null,
  }
}

const THREAD_STATES: readonly ThreadState[] = ["running", "idle", "inactive"]

/** `state` is the documented field; the CLI's list rows carry it as an object and report the turn in `activity`. */
function threadState(row: Record<string, unknown>): ThreadState {
  const named = THREAD_STATES.find((state) => state === row.state) ?? THREAD_STATES.find((state) => state === row.activity)
  if (named !== undefined) return named
  return row.status === "live" ? "idle" : "inactive"
}

const COMPLETION_STATUSES: Readonly<Record<string, CompletionStatus>> = {
  completed: "completed",
  failed: "failed",
  error: "failed",
  aborted: "aborted",
  interrupted: "aborted",
  cancelled: "aborted",
}

export function completionOutcome(outcome: string): CompletionOutcome {
  return { status: COMPLETION_STATUSES[outcome] ?? "idle", detail: outcome }
}
