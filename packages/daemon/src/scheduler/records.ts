import type { Clock } from "../core/ports"
import type { Ms, Schedule } from "../core/types"
import type { EventLedger } from "../db/ledger"
import { RevisionConflictError } from "../db/repos/errors"
import { parseJsonObject } from "../db/repos/json"
import type { SkippedSlots } from "./misfire"
import type { SlotSource } from "./slots"

export interface ScheduleWriterDeps {
  readonly ledger: EventLedger
  readonly clock: Clock
}

export type ScheduleWriter = ReturnType<typeof scheduleWriter>

/** Schedule writes through the repository (revision + 1, `schedule.upserted`), plus the `slots_skipped` event. */
export function scheduleWriter({ ledger, clock }: ScheduleWriterDeps) {
  const nowIso = (): string => new Date(clock.now()).toISOString()
  return {
    save(current: Schedule, next: Schedule, skipped: SkippedSlots | null = null): Schedule {
      const saved: Schedule = { ...next, revision: current.revision + 1 }
      const at = nowIso()
      ledger.transact((transaction) => {
        const changed = transaction.execute(
          `UPDATE schedules SET state = ?, next_fire_at = ?, updated_at = ?, json = ?, revision = ?
           WHERE id = ? AND user_id = ? AND revision = ?`,
          [saved.state, saved.nextFireAt, at, JSON.stringify(saved), saved.revision, saved.id, saved.userId, current.revision],
        )
        if (changed !== 1) throw new RevisionConflictError(saved.id, current.revision)
        transaction.emit({
          at,
          type: "schedule.upserted",
          entityKind: "schedule",
          entityId: saved.id,
          userId: saved.userId,
          projectId: saved.projectId,
          data: parseJsonObject(JSON.stringify(saved), "schedule"),
        })
        if (skipped !== null) {
          transaction.emit({
            at,
            type: "schedule.slots_skipped",
            entityKind: "schedule",
            entityId: saved.id,
            userId: saved.userId,
            projectId: saved.projectId,
            data: { ...skipped },
          })
        }
      })
      return saved
    },
  }
}

export function periodAfter(source: SlotSource, slotAt: Ms): Ms {
  const next = source.next(slotAt)
  return next === null ? 0 : next.at - slotAt
}
