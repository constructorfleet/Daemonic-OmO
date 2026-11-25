import type { Database } from "bun:sqlite"
import { parseUlid } from "../../core/ids"
import type { Schedule } from "../../core/types"
import type { EventLedger } from "../ledger"
import { RepositoryDataError, RevisionConflictError } from "./errors"
import { parseRecord } from "./json"

function isSchedule(value: Record<string, unknown>): value is Record<string, unknown> & Schedule {
  return typeof value.id === "string" && parseUlid(value.id) !== null &&
    typeof value.userId === "string" && parseUlid(value.userId) !== null &&
    typeof value.projectId === "string" && parseUlid(value.projectId) !== null &&
    typeof value.name === "string" && value.trigger !== null &&
    typeof value.trigger === "object" && value.target !== null &&
    typeof value.target === "object" &&
    (value.overlap === "skip" || value.overlap === "queue" || value.overlap === "parallel") &&
    typeof value.queueMax === "number" &&
    (value.misfire === "skip" || value.misfire === "fire_once" || value.misfire === "fire_all") &&
    typeof value.misfireGraceMs === "number" && typeof value.maxCatchup === "number" &&
    typeof value.fireCount === "number" &&
    (value.state === "active" || value.state === "paused" ||
      value.state === "completed" || value.state === "errored") &&
    typeof value.revision === "number" &&
    (value.nextFireAt === null || typeof value.nextFireAt === "number") &&
    (value.lastSlotAt === null || typeof value.lastSlotAt === "number")
}

function decodeSchedule(json: string): Schedule {
  const value = parseRecord(json, "schedule")
  if (!isSchedule(value)) throw new RepositoryDataError("schedule")
  return value
}

export function createScheduleRepository(db: Database, ledger: EventLedger) {
  return {
    get(id: Schedule["id"]): Schedule | null {
      const row = db.query<{ readonly json: string }, [string]>(
        "SELECT json FROM schedules WHERE id = ?",
      ).get(id)
      return row === null ? null : decodeSchedule(row.json)
    },
    listDue(at: number): readonly Schedule[] {
      return db.query<{ readonly json: string }, [number]>(
        "SELECT json FROM schedules WHERE state = 'active' AND next_fire_at <= ? ORDER BY next_fire_at",
      ).all(at).map(({ json }) => decodeSchedule(json))
    },
    put(schedule: Schedule, at: string): void {
      ledger.transact((transaction) => {
        transaction.execute(
          `INSERT INTO schedules(id, user_id, project_id, state, next_fire_at, updated_at, json, revision)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [schedule.id, schedule.userId, schedule.projectId, schedule.state,
            schedule.nextFireAt, at, JSON.stringify(schedule), schedule.revision],
        )
        transaction.emit({
          at,
          type: "schedule.upserted",
          entityKind: "schedule",
          entityId: schedule.id,
          userId: schedule.userId,
          projectId: schedule.projectId,
          data: { id: schedule.id, revision: schedule.revision },
        })
      })
    },
    update(schedule: Schedule, expectedRevision: number, at: string): void {
      if (schedule.revision !== expectedRevision + 1) {
        throw new RangeError("schedule revision must advance by one")
      }
      ledger.transact((transaction) => {
        const changed = transaction.execute(
          `UPDATE schedules SET state = ?, next_fire_at = ?, updated_at = ?, json = ?, revision = ?
           WHERE id = ? AND user_id = ? AND revision = ?`,
          [schedule.state, schedule.nextFireAt, at,
            JSON.stringify(schedule), schedule.revision, schedule.id, schedule.userId, expectedRevision],
        )
        if (changed !== 1) throw new RevisionConflictError(schedule.id, expectedRevision)
        transaction.emit({
          at,
          type: "schedule.upserted",
          entityKind: "schedule",
          entityId: schedule.id,
          userId: schedule.userId,
          projectId: schedule.projectId,
          data: { id: schedule.id, revision: schedule.revision },
        })
      })
    },
  }
}
