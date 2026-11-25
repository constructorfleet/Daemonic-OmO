import type { Database } from "bun:sqlite"
import { parseUlid } from "../../core/ids"
import { ENTITY_KINDS } from "../../core/types"
import type { AuditEntry, EntityKind } from "../../core/types"
import { RepositoryDataError } from "./errors"
import { parseJsonObject } from "./json"

type AuditRow = {
  readonly id: string
  readonly at: string
  readonly user_id: string
  readonly action: string
  readonly entity_kind: string
  readonly entity_id: string
  readonly detail_json: string
}

function kind(value: string): EntityKind {
  const parsed = ENTITY_KINDS.find((entityKind) => entityKind === value)
  if (parsed === undefined) throw new RepositoryDataError("audit")
  return parsed
}

function decodeAudit(row: AuditRow): AuditEntry {
  const id = parseUlid(row.id)
  const userId = parseUlid(row.user_id)
  if (id === null || userId === null) throw new RepositoryDataError("audit")
  return {
    id,
    at: row.at,
    userId,
    action: row.action,
    entityKind: kind(row.entity_kind),
    entityId: row.entity_id,
    detail: parseJsonObject(row.detail_json, "audit"),
  }
}

export function createAuditRepository(db: Database) {
  return {
    get(id: AuditEntry["id"]): AuditEntry | null {
      const row = db.query<AuditRow, [string]>("SELECT * FROM audit WHERE id = ?").get(id)
      return row === null ? null : decodeAudit(row)
    },
    listByUser(userId: AuditEntry["userId"], limit: number): readonly AuditEntry[] {
      return db.query<AuditRow, [string, number]>(
        "SELECT * FROM audit WHERE user_id = ? ORDER BY at DESC, id LIMIT ?",
      ).all(userId, limit).map(decodeAudit)
    },
    put(entry: AuditEntry): void {
      db.query(
        `INSERT INTO audit(id, at, user_id, action, entity_kind, entity_id, detail_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        entry.id,
        entry.at,
        entry.userId,
        entry.action,
        entry.entityKind,
        entry.entityId,
        JSON.stringify(entry.detail),
      )
    },
  }
}
