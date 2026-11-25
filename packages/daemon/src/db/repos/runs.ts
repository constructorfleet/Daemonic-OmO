import type { Database } from "bun:sqlite"
import { parseUlid } from "../../core/ids"
import type { Run } from "../../core/types"
import type { EventLedger } from "../ledger"
import { RepositoryDataError, RevisionConflictError } from "./errors"
import { parseJsonObject, parseRecord } from "./json"

function isRun(value: Record<string, unknown>): value is Record<string, unknown> & Run {
  return typeof value.id === "string" && parseUlid(value.id) !== null &&
    typeof value.userId === "string" && parseUlid(value.userId) !== null &&
    typeof value.projectId === "string" && parseUlid(value.projectId) !== null &&
    typeof value.fireKey === "string" && typeof value.attempt === "number" &&
    (value.state === "queued" || value.state === "creating" || value.state === "active" ||
      value.state === "settled" || value.state === "evaluating" ||
      value.state === "closed" || value.state === "kept") &&
    typeof value.cancelRequested === "boolean" && Array.isArray(value.orphanChildren) &&
    typeof value.createdAt === "string" && typeof value.updatedAt === "string" &&
    typeof value.revision === "number" && value.spec !== null && typeof value.spec === "object" &&
    (value.outcome === null || (value.outcome !== null && typeof value.outcome === "object"))
}

function decodeRun(json: string): Run {
  const value = parseRecord(json, "run")
  if (!isRun(value)) throw new RepositoryDataError("run")
  return value
}

export function createRunRepository(db: Database, ledger: EventLedger) {
  return {
    get(id: Run["id"]): Run | null {
      const row = db.query<{ readonly json: string }, [string]>(
        "SELECT json FROM runs WHERE id = ?",
      ).get(id)
      return row === null ? null : decodeRun(row.json)
    },
    getByFireKey(fireKey: string, attempt: number): Run | null {
      const row = db.query<{ readonly json: string }, [string, number]>(
        "SELECT json FROM runs WHERE fire_key = ? AND attempt = ?",
      ).get(fireKey, attempt)
      return row === null ? null : decodeRun(row.json)
    },
    listByProject(projectId: Run["projectId"]): readonly Run[] {
      return db.query<{ readonly json: string }, [string]>(
        "SELECT json FROM runs WHERE project_id = ? ORDER BY created_at DESC, id",
      ).all(projectId).map(({ json }) => decodeRun(json))
    },
    put(run: Run): void {
      ledger.transact((transaction) => {
        transaction.execute(
          `INSERT INTO runs(id, user_id, project_id, schedule_id, loop_id, state, fire_key,
            attempt, created_at, updated_at, json, revision)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [run.id, run.userId, run.projectId, run.scheduleId ?? null, run.loopId ?? null,
            run.state, run.fireKey, run.attempt, run.createdAt, run.updatedAt,
            JSON.stringify(run), run.revision],
        )
        transaction.emit({
          at: run.updatedAt,
          type: "run.state_changed",
          entityKind: "run",
          entityId: run.id,
          userId: run.userId,
          projectId: run.projectId,
          data: parseJsonObject(JSON.stringify(run), "run"),
        })
      })
    },
    update(run: Run, expectedRevision: number): void {
      if (run.revision !== expectedRevision + 1) {
        throw new RangeError("run revision must advance by one")
      }
      ledger.transact((transaction) => {
        const changed = transaction.execute(
          `UPDATE runs SET schedule_id = ?, loop_id = ?, state = ?, updated_at = ?, json = ?, revision = ?
           WHERE id = ? AND user_id = ? AND revision = ?`,
          [run.scheduleId ?? null, run.loopId ?? null, run.state, run.updatedAt,
            JSON.stringify(run), run.revision, run.id, run.userId, expectedRevision],
        )
        if (changed !== 1) throw new RevisionConflictError(run.id, expectedRevision)
        transaction.emit({
          at: run.updatedAt,
          type: "run.state_changed",
          entityKind: "run",
          entityId: run.id,
          userId: run.userId,
          projectId: run.projectId,
          data: parseJsonObject(JSON.stringify(run), "run"),
        })
      })
    },
  }
}
