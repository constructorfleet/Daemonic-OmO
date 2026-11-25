import type { Database } from "bun:sqlite"
import type { UserId } from "../../core/types"
import { parseUlid } from "../../core/ids"
import { RepositoryDataError } from "./errors"

export interface DaemonSession {
  readonly id: string
  readonly userId: UserId
  readonly expiresAt: string
  readonly csrfToken: string
  readonly createdAt: string
}

type SessionRow = {
  readonly id: string
  readonly user_id: string
  readonly expires_at: string
  readonly csrf_token: string
  readonly created_at: string
}

function decodeSession(row: SessionRow): DaemonSession {
  const userId = parseUlid(row.user_id)
  if (userId === null) throw new RepositoryDataError("session")
  return {
    id: row.id,
    userId,
    expiresAt: row.expires_at,
    csrfToken: row.csrf_token,
    createdAt: row.created_at,
  }
}

export function createSessionRepository(db: Database) {
  return {
    get(id: string): DaemonSession | null {
      const row = db.query<SessionRow, [string]>("SELECT * FROM sessions WHERE id = ?").get(id)
      return row === null ? null : decodeSession(row)
    },
    put(session: DaemonSession): void {
      db.query(
        "INSERT INTO sessions(id, user_id, expires_at, csrf_token, created_at) VALUES (?, ?, ?, ?, ?)",
      ).run(session.id, session.userId, session.expiresAt, session.csrfToken, session.createdAt)
    },
    deleteExpired(now: string): number {
      return db.query("DELETE FROM sessions WHERE expires_at <= ?").run(now).changes
    },
  }
}
