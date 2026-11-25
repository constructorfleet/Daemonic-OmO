import type { Database } from "bun:sqlite"

import { ServiceKey } from "../api/services"
import type { Repositories } from "../auth/types"
import type { Config } from "../config"
import { parseUlid, ulid } from "../core/ids"
import type { Clock, Rng } from "../core/ports"
import type {
  Iso,
  MisfirePolicy,
  OverlapPolicy,
  Project,
  ProjectId,
  Schedule,
  ScheduleId,
  ScheduleTarget,
  ScheduleTrigger,
  User,
} from "../core/types"
import type { EventLedger } from "../db/ledger"
import type { RunEngine } from "../runs/engine"
import { isSpawnHeld } from "../runs/spawn-hold"
import { UNFINISHED_RUN_STATES, type FireOutcome } from "./fire"
import { planDue } from "./misfire"
import { placeSchedule, placementAfter, type SchedulePlacement } from "./placement"
import { writeQueue } from "./queue"
import { scheduleWriter } from "./records"
import type { Scheduler } from "./scheduler"
import { compileTrigger, previewSlots, type PreviewSlot } from "./slots"

export interface ScheduleInput {
  readonly name: string
  readonly trigger: ScheduleTrigger
  readonly target: ScheduleTarget
  readonly overlap?: OverlapPolicy
  readonly queueMax?: number
  readonly misfire?: MisfirePolicy
  readonly misfireGraceMs?: number
  readonly maxCatchup?: number
  readonly endAt?: Iso
  readonly maxFires?: number
}

/** `null` clears `endAt` or `maxFires`. */
export type SchedulePatchInput = Partial<Omit<ScheduleInput, "endAt" | "maxFires">> & {
  readonly revision: number
  readonly endAt?: Iso | null
  readonly maxFires?: number | null
}

export interface ScheduleServiceDeps {
  readonly db: Database
  readonly repos: Repositories
  readonly ledger: EventLedger
  readonly clock: Clock
  readonly rng: Rng
  readonly config: Pick<Config, "defaults" | "limits">
  readonly scheduler: Scheduler
  engine(): RunEngine
}

export type ScheduleConflict = "not_paused" | "not_active" | "spawn_hold"

export class ScheduleStateError extends Error {
  readonly name = "ScheduleStateError"

  constructor(readonly scheduleId: ScheduleId, readonly conflict: ScheduleConflict) {
    super(`schedule ${scheduleId}: ${conflict}`)
  }
}

export interface ScheduleService {
  get(id: ScheduleId): Schedule | null
  listByProject(projectId: ProjectId): readonly Schedule[]
  create(project: Project, input: ScheduleInput): Schedule
  patch(schedule: Schedule, input: SchedulePatchInput): Schedule
  pause(schedule: Schedule): Schedule
  resume(schedule: Schedule): Schedule
  /** Soft delete; the schedule's unfinished runs keep running unless `cancelRuns`. */
  remove(actor: User, schedule: Schedule, cancelRuns: boolean): Promise<void>
  fire(schedule: Schedule): Promise<FireOutcome>
  preview(schedule: Schedule, count: number): readonly PreviewSlot[]
}

export const SCHEDULES = new ServiceKey<ScheduleService>("schedules")

function stripErrorReason(schedule: Schedule): Schedule {
  const { errorReason: _cleared, ...rest } = schedule
  return rest
}

export function createScheduleService(deps: ScheduleServiceDeps): ScheduleService {
  const { db, repos, clock, config, scheduler } = deps
  const writer = scheduleWriter({ ledger: deps.ledger, clock })
  const nowIso = (): string => new Date(clock.now()).toISOString()

  const assignPlacement = (schedule: Schedule, placement: SchedulePlacement): Schedule => ({
    ...stripErrorReason(schedule),
    ...placement,
    ...(placement.errorReason === undefined ? {} : { errorReason: placement.errorReason }),
  })

  return {
    get(id) {
      const schedule = repos.schedules.get(id)
      return schedule === null || schedule.deletedAt !== undefined ? null : schedule
    },

    listByProject(projectId) {
      return db.query<{ readonly id: string }, [string]>("SELECT id FROM schedules WHERE project_id = ? ORDER BY rowid")
        .all(projectId)
        .flatMap(({ id }) => {
          const parsed = parseUlid(id)
          const schedule = parsed === null ? null : repos.schedules.get(parsed)
          return schedule === null || schedule.deletedAt !== undefined ? [] : [schedule]
        })
    },

    create(project, input) {
      const now = clock.now()
      const misfire = input.misfire ?? config.defaults.misfire
      const grace = misfire === "skip" ? config.defaults.skipMisfireGraceMs :
        input.trigger.kind === "once" ? config.defaults.onceMisfireGraceMs : config.defaults.misfireGraceMs
      const base: Schedule = {
        id: ulid(deps.rng, now),
        userId: project.userId,
        projectId: project.id,
        name: input.name,
        trigger: input.trigger,
        target: input.target,
        overlap: input.overlap ?? config.defaults.overlap,
        queueMax: input.queueMax ?? config.defaults.queueMax,
        misfire,
        misfireGraceMs: input.misfireGraceMs ?? grace,
        maxCatchup: input.maxCatchup ?? config.defaults.maxCatchup,
        ...(input.endAt === undefined ? {} : { endAt: input.endAt }),
        ...(input.maxFires === undefined ? {} : { maxFires: input.maxFires }),
        fireCount: 0,
        state: "active",
        nextFireAt: null,
        lastSlotAt: null,
        revision: 1,
      }
      const schedule = assignPlacement(base, placeSchedule({
        trigger: input.trigger,
        after: placementAfter(input.trigger, now - 1, null),
        now,
        endAt: input.endAt,
        horizonMs: config.limits.scheduleHorizonMs,
      }))
      repos.schedules.put(schedule, nowIso())
      scheduler.rearm()
      return schedule
    },

    patch(schedule, input) {
      const { revision, endAt, maxFires, ...fields } = input
      const { endAt: currentEndAt, maxFires: currentMaxFires, ...current } = schedule
      const nextEndAt = endAt === undefined ? currentEndAt : endAt ?? undefined
      const nextMaxFires = maxFires === undefined ? currentMaxFires : maxFires ?? undefined
      const merged: Schedule = {
        ...current,
        ...fields,
        ...(nextEndAt === undefined ? {} : { endAt: nextEndAt }),
        ...(nextMaxFires === undefined ? {} : { maxFires: nextMaxFires }),
      }
      const now = clock.now()
      const placed = placeSchedule({
        trigger: merged.trigger,
        after: placementAfter(merged.trigger, now, merged.lastSlotAt),
        now,
        endAt: merged.endAt,
        horizonMs: config.limits.scheduleHorizonMs,
      })
      const completed = merged.state === "completed" || (merged.maxFires !== undefined && merged.fireCount >= merged.maxFires)
      const next: Schedule = completed
        ? { ...merged, state: "completed", nextFireAt: null }
        : assignPlacement(merged, merged.state === "paused" && placed.state === "active" ? { ...placed, state: "paused" } : placed)
      const saved = writer.save({ ...schedule, revision }, next)
      scheduler.rearm()
      return saved
    },

    pause(schedule) {
      if (schedule.state !== "active") throw new ScheduleStateError(schedule.id, "not_active")
      const saved = writer.save(schedule, { ...schedule, state: "paused" })
      scheduler.rearm()
      return saved
    },

    resume(schedule) {
      if (schedule.state !== "paused") throw new ScheduleStateError(schedule.id, "not_paused")
      if (isSpawnHeld(db, schedule.userId)) throw new ScheduleStateError(schedule.id, "spawn_hold")
      const compiled = compileTrigger(schedule.trigger)
      if (compiled.kind === "error") {
        return writer.save(schedule, { ...schedule, state: "errored", nextFireAt: null, errorReason: `${compiled.reason}: ${compiled.detail}` })
      }
      const now = clock.now()
      const start = schedule.nextFireAt ?? compiled.source.next(placementAfter(schedule.trigger, now, schedule.lastSlotAt))?.at ?? null
      // Slots that came due while paused are reported once as skipped(paused) and never fired: no backfill.
      const plan = start === null
        ? { skipped: null, lastSlotAt: schedule.lastSlotAt, nextFireAt: null }
        : planDue({ schedule, now: now - 1, source: compiled.source, blocked: true }, start)
      const saved = writer.save(schedule, {
        ...schedule,
        state: plan.nextFireAt === null ? "completed" : "active",
        lastSlotAt: plan.lastSlotAt,
        nextFireAt: plan.nextFireAt,
      }, plan.skipped)
      scheduler.rearm()
      return saved
    },

    async remove(actor, schedule, cancelRuns) {
      writer.save(schedule, { ...schedule, deletedAt: nowIso(), nextFireAt: null })
      writeQueue(db, schedule.id, [])
      scheduler.rearm()
      if (!cancelRuns) return
      const unfinished = db.query<{ readonly id: string }, [string]>(
        `SELECT id FROM runs WHERE schedule_id = ? AND state IN ${UNFINISHED_RUN_STATES} ORDER BY created_at`,
      ).all(schedule.id)
      for (const { id } of unfinished) {
        const runId = parseUlid(id)
        if (runId !== null) await deps.engine().cancel(actor, runId, "user")
      }
    },

    fire(schedule) {
      if (isSpawnHeld(db, schedule.userId)) throw new ScheduleStateError(schedule.id, "spawn_hold")
      return scheduler.fireNow(schedule)
    },

    preview(schedule, count) {
      const compiled = compileTrigger(schedule.trigger)
      if (compiled.kind === "error") return []
      return previewSlots(compiled.source, clock.now() - 1, count)
    },
  }
}
