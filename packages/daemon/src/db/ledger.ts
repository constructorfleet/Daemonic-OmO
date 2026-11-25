import type { Database, SQLQueryBindings } from "bun:sqlite"
import { parseUlid } from "../core/ids"
import { ENTITY_KINDS } from "../core/types"
import type { DaemonEvent, EntityKind, JsonObject, JsonValue, UserId } from "../core/types"

export type EventDraft = Omit<DaemonEvent, "seq" | "userSeq">

export interface LedgerTransaction {
  readonly execute: (sql: string, parameters?: readonly SQLQueryBindings[]) => number
  readonly emit: (event: EventDraft) => void
}

export interface RetentionLimits {
  readonly now: string
  readonly eventRetentionDays: number
  readonly eventRetentionMinRows: number
}

type EventRow = {
  readonly seq: number
  readonly user_seq: number
  readonly at: string
  readonly type: string
  readonly entity_kind: string
  readonly entity_id: string
  readonly user_id: string
  readonly project_id: string | null
  readonly data: string
}

type SequenceRow = { readonly seq: number }
type UserSequenceRow = { readonly user_seq: number }

export class LedgerDataError extends Error {
  readonly name = "LedgerDataError"

  constructor(readonly field: string) {
    super(`invalid event ledger field: ${field}`)
  }
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (typeof value !== "object") return false
  return Object.values(value).every(isJsonValue)
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) && isJsonValue(value)
}

function parseJsonObject(value: string): JsonObject {
  const parsed: unknown = JSON.parse(value)
  if (!isJsonObject(parsed)) throw new LedgerDataError("data")
  return parsed
}

function entityKind(value: string): EntityKind {
  const parsed = ENTITY_KINDS.find((kind) => kind === value)
  if (parsed === undefined) throw new LedgerDataError("entity_kind")
  return parsed
}

function userId(value: string): UserId {
  const parsed = parseUlid(value)
  if (parsed === null) throw new LedgerDataError("user_id")
  return parsed
}

function projectId(value: string | null): DaemonEvent["projectId"] {
  if (value === null) return null
  const parsed = parseUlid(value)
  if (parsed === null) throw new LedgerDataError("project_id")
  return parsed
}

function decodeEvent(row: EventRow): DaemonEvent {
  return {
    seq: row.seq,
    userSeq: row.user_seq,
    at: row.at,
    type: row.type,
    entityKind: entityKind(row.entity_kind),
    entityId: row.entity_id,
    userId: userId(row.user_id),
    projectId: projectId(row.project_id),
    data: parseJsonObject(row.data),
  }
}

export class EventLedger {
  readonly #db: Database
  readonly #listeners = new Set<(event: DaemonEvent) => void>()

  constructor(db: Database) {
    this.#db = db
  }

  subscribe(listener: (event: DaemonEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  transact<T>(work: (transaction: LedgerTransaction) => T): T {
    const committed: DaemonEvent[] = []
    const result = this.#db.transaction(() => work({
      execute: (sql, parameters = []) => this.#db.query(sql).run(...parameters).changes,
      emit: (event) => {
        const global = this.#db.query<SequenceRow, []>(
          "UPDATE event_heads SET seq = seq + 1 WHERE id = 1 RETURNING seq",
        ).get()
        const perUser = this.#db.query<UserSequenceRow, [string]>(
          `INSERT INTO user_event_heads(user_id, user_seq) VALUES (?, 1)
           ON CONFLICT(user_id) DO UPDATE SET user_seq = user_seq + 1
           RETURNING user_seq`,
        ).get(event.userId)
        if (global === null || perUser === null) {
          throw new LedgerDataError("sequence")
        }
        const record: DaemonEvent = { ...event, seq: global.seq, userSeq: perUser.user_seq }
        this.#db.query(
          `INSERT INTO events(seq, user_seq, at, type, entity_kind, entity_id, user_id, project_id, data)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          record.seq,
          record.userSeq,
          record.at,
          record.type,
          record.entityKind,
          record.entityId,
          record.userId,
          record.projectId,
          JSON.stringify(record.data),
        )
        committed.push(record)
      },
    })).immediate()
    for (const record of committed) {
      for (const listener of this.#listeners) listener(record)
    }
    return result
  }

  readAfter(seq: number, limit: number): readonly DaemonEvent[] {
    return this.#db.query<EventRow, [number, number]>(
      `SELECT seq, user_seq, at, type, entity_kind, entity_id, user_id, project_id, data
       FROM events WHERE seq > ? ORDER BY seq LIMIT ?`,
    ).all(seq, limit).map(decodeEvent)
  }

  headSeq(): number {
    const row = this.#db.query<SequenceRow, []>(
      "SELECT seq FROM event_heads WHERE id = 1",
    ).get()
    if (row === null) throw new LedgerDataError("head_seq")
    return row.seq
  }

  prune(limits: RetentionLimits): number {
    if (!Number.isInteger(limits.eventRetentionDays) || limits.eventRetentionDays < 0) {
      throw new RangeError("eventRetentionDays must be a non-negative integer")
    }
    if (!Number.isInteger(limits.eventRetentionMinRows) || limits.eventRetentionMinRows < 0) {
      throw new RangeError("eventRetentionMinRows must be a non-negative integer")
    }
    const cutoff = Date.parse(limits.now) - limits.eventRetentionDays * 86_400_000
    if (!Number.isFinite(cutoff)) throw new RangeError("now must be a valid ISO timestamp")
    return this.#db.query(
      `DELETE FROM events
       WHERE at < ? AND seq NOT IN (
         SELECT seq FROM events ORDER BY seq DESC LIMIT ?
       )`,
    ).run(new Date(cutoff).toISOString(), limits.eventRetentionMinRows).changes
  }
}
