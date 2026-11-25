import type { Database } from "bun:sqlite"
import type { UserId } from "../../core/types"
import { IdempotencyConflictError, RepositoryDataError } from "./errors"

export interface IdempotencyRecord {
  readonly key: string
  readonly requestHash: string
  readonly response: string
  readonly expiresAt: number
}

export interface IdempotencyWrite {
  readonly userId: UserId
  readonly key: string
  readonly requestHash: string
  readonly response: string
  readonly expiresAt: number
}

type IdempotencyRow = {
  readonly key: string
  readonly request_hash: string
  readonly response: string
  readonly expires_at: number
}

export function createIdempotencyRepository(db: Database) {
  return {
    get(userId: UserId, key: string): IdempotencyRecord | null {
      const row = db.query<IdempotencyRow, [string, string]>(
        "SELECT key, request_hash, response, expires_at FROM idempotency WHERE user_id = ? AND key = ?",
      ).get(userId, key)
      return row === null ? null : {
        key: row.key,
        requestHash: row.request_hash,
        response: row.response,
        expiresAt: row.expires_at,
      }
    },
    put(record: IdempotencyWrite): void {
      db.transaction(() => {
        db.query(
          `INSERT INTO idempotency(user_id, key, request_hash, response, expires_at)
           VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, key) DO NOTHING`,
        ).run(record.userId, record.key, record.requestHash, record.response, record.expiresAt)
        const existing = db.query<{ readonly request_hash: string }, [string, string]>(
          "SELECT request_hash FROM idempotency WHERE user_id = ? AND key = ?",
        ).get(record.userId, record.key)
        if (existing === null) throw new RepositoryDataError("idempotency")
        if (existing.request_hash !== record.requestHash) throw new IdempotencyConflictError(record.key)
      }).immediate()
    },
    pruneExpired(now: number): number {
      return db.query("DELETE FROM idempotency WHERE expires_at <= ?").run(now).changes
    },
  }
}
