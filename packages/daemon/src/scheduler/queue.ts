import type { Database } from "bun:sqlite"

import { parseUlid } from "../core/ids"
import type { Ms, ScheduleId } from "../core/types"

const KEY_PREFIX = "scheduler.queue:"

/** A slot held by overlap `queue` until the schedule's active run or loop ends; stale after `expiresAt`. */
export interface QueuedFire {
  readonly slotAt: Ms
  readonly expiresAt: Ms
}

function isQueuedFire(value: unknown): value is QueuedFire {
  return typeof value === "object" && value !== null && "slotAt" in value && "expiresAt" in value &&
    typeof value.slotAt === "number" && typeof value.expiresAt === "number"
}

export class QueueDataError extends Error {
  readonly name = "QueueDataError"

  constructor(readonly scheduleId: string) {
    super(`invalid queued fires for schedule ${scheduleId}`)
  }
}

/** Queued fires live in `meta` (as the kill switch's spawn hold does), so they survive a restart. */
export function readQueue(db: Database, scheduleId: ScheduleId): readonly QueuedFire[] {
  const row = db.query<{ readonly value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get(`${KEY_PREFIX}${scheduleId}`)
  if (row === null) return []
  const parsed: unknown = JSON.parse(row.value)
  if (!Array.isArray(parsed) || !parsed.every(isQueuedFire)) throw new QueueDataError(scheduleId)
  return parsed
}

export function writeQueue(db: Database, scheduleId: ScheduleId, fires: readonly QueuedFire[]): void {
  const key = `${KEY_PREFIX}${scheduleId}`
  if (fires.length === 0) {
    db.query("DELETE FROM meta WHERE key = ?").run(key)
    return
  }
  db.query("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, JSON.stringify(fires))
}

export function queuedSchedules(db: Database): readonly ScheduleId[] {
  return db.query<{ readonly key: string }, [string]>("SELECT key FROM meta WHERE key LIKE ? ORDER BY key")
    .all(`${KEY_PREFIX}%`)
    .flatMap(({ key }) => {
      const id = parseUlid(key.slice(KEY_PREFIX.length))
      return id === null ? [] : [id]
    })
}

export function earliestExpiry(db: Database): Ms | null {
  const expiries = queuedSchedules(db).flatMap((id) => readQueue(db, id).map((fire) => fire.expiresAt))
  return expiries.length === 0 ? null : Math.min(...expiries)
}
