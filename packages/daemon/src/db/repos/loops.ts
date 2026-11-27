import type { Database } from "bun:sqlite"
import { parseUlid } from "../../core/ids"
import type { Loop } from "../../core/types"
import type { EventLedger } from "../ledger"
import { RepositoryDataError, RevisionConflictError } from "./errors"
import { parseJsonObject, parseRecord } from "./json"

function isLoop(value: Record<string, unknown>): value is Record<string, unknown> & Loop {
  const optionalStrings = ["worktreePath", "branch", "threadId", "sessionId", "sessionFile", "errorDetail"] as const
  return typeof value.id === "string" && parseUlid(value.id) !== null &&
    typeof value.userId === "string" && parseUlid(value.userId) !== null &&
    typeof value.projectId === "string" && parseUlid(value.projectId) !== null &&
    typeof value.spec === "object" && value.spec !== null &&
    Array.isArray(value.doneWhen) && typeof value.maxIterations === "number" &&
    typeof value.maxConsecutiveFailures === "number" && typeof value.cadenceMs === "number" &&
    typeof value.backoff === "object" && value.backoff !== null &&
    (value.sessionMode === "fresh" || value.sessionMode === "continue") &&
    typeof value.carryForwardBytes === "number" && typeof value.fireKey === "string" &&
    typeof value.nonce === "string" &&
    (value.state === "pending" || value.state === "running" || value.state === "waiting" ||
      value.state === "cancelling" || value.state === "succeeded" || value.state === "blocked" ||
      value.state === "exhausted" || value.state === "failed" || value.state === "cancelled") &&
    typeof value.iteration === "number" && typeof value.consecutiveFailures === "number" &&
    (value.nextIterationAt === null || typeof value.nextIterationAt === "number") &&
    optionalStrings.every((key) => value[key] === undefined || typeof value[key] === "string") &&
    (value.activeRunId === undefined || (typeof value.activeRunId === "string" && parseUlid(value.activeRunId) !== null)) &&
    (value.evaluatedRunId === undefined || (typeof value.evaluatedRunId === "string" && parseUlid(value.evaluatedRunId) !== null)) &&
    typeof value.revision === "number"
}

function decodeLoop(json: string): Loop {
  const value = parseRecord(json, "loop")
  if (!isLoop(value)) throw new RepositoryDataError("loop")
  return value
}

export function createLoopRepository(db: Database, ledger: EventLedger) {
  return {
    get(id: Loop["id"]): Loop | null {
      const row = db.query<{ readonly json: string }, [string]>(
        "SELECT json FROM loops WHERE id = ?",
      ).get(id)
      return row === null ? null : decodeLoop(row.json)
    },
    listByProject(projectId: Loop["projectId"]): readonly Loop[] {
      return db.query<{ readonly json: string }, [string]>(
        "SELECT json FROM loops WHERE project_id = ? ORDER BY rowid",
      ).all(projectId).map(({ json }) => decodeLoop(json))
    },
    put(loop: Loop, at: string): void {
      ledger.transact((transaction) => {
        transaction.execute(
          `INSERT INTO loops(id, user_id, project_id, state, next_iteration_at, updated_at, json, revision)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [loop.id, loop.userId, loop.projectId, loop.state, loop.nextIterationAt,
            at, JSON.stringify(loop), loop.revision],
        )
        transaction.emit({
          at,
          type: "loop.state_changed",
          entityKind: "loop",
          entityId: loop.id,
          userId: loop.userId,
          projectId: loop.projectId,
          data: parseJsonObject(JSON.stringify(loop), "loop"),
        })
      })
    },
    update(loop: Loop, expectedRevision: number, at: string): void {
      if (loop.revision !== expectedRevision + 1) {
        throw new RangeError("loop revision must advance by one")
      }
      const previous = this.get(loop.id)
      if (previous === null) throw new RevisionConflictError(loop.id, expectedRevision)
      const iterationStarted = previous.state === "running" && previous.activeRunId === undefined &&
        loop.state === "running" && loop.activeRunId !== undefined && loop.iteration > 0
      ledger.transact((transaction) => {
        const changed = transaction.execute(
          `UPDATE loops SET state = ?, next_iteration_at = ?, updated_at = ?, json = ?, revision = ?
           WHERE id = ? AND user_id = ? AND revision = ?`,
          [loop.state, loop.nextIterationAt, at, JSON.stringify(loop), loop.revision,
            loop.id, loop.userId, expectedRevision],
        )
        if (changed !== 1) throw new RevisionConflictError(loop.id, expectedRevision)
        transaction.emit({
          at,
          type: "loop.state_changed",
          entityKind: "loop",
          entityId: loop.id,
          userId: loop.userId,
          projectId: loop.projectId,
          data: parseJsonObject(JSON.stringify(loop), "loop"),
        })
        if (iterationStarted) {
          transaction.emit({
            at,
            type: "loop.iteration_started",
            entityKind: "loop",
            entityId: loop.id,
            userId: loop.userId,
            projectId: loop.projectId,
            data: parseJsonObject(JSON.stringify(loop), "loop"),
          })
        }
      })
    },
  }
}
