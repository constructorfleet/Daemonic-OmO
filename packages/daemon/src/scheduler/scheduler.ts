import type { Database } from "bun:sqlite"

import { ServiceKey } from "../api/services"
import type { Repositories } from "../auth/types"
import { parseUlid } from "../core/ids"
import type { Clock, Rng, TimerHandle } from "../core/ports"
import type { JsonObject, Ms, Project, Schedule, ScheduleId } from "../core/types"
import type { EventLedger } from "../db/ledger"
import type { RunEngine } from "../runs/engine"
import { isSpawnHeld } from "../runs/spawn-hold"
import { drainQueue, fireKeyOf, fireSlot, type FireDeps, type FireOutcome, type LoopLauncher } from "./fire"
import { planDue } from "./misfire"
import { earliestExpiry, queuedSchedules, readQueue, writeQueue } from "./queue"
import { periodAfter, scheduleWriter } from "./records"
import { compileTrigger } from "./slots"

export type { FireOutcome, LoopLaunch, LoopLauncher } from "./fire"

export interface SchedulerTiming {
  /** The tick timer never sleeps longer than this: a monotonic timer pauses while the laptop sleeps. */
  readonly maxTickIntervalMs: Ms
  /** Wall and monotonic clocks drifting apart by more than this between ticks logs `daemon.clock_jump`. */
  readonly clockJumpMs: Ms
}

export const DEFAULT_TIMING: SchedulerTiming = { maxTickIntervalMs: 30_000, clockJumpMs: 5_000 }

export interface SchedulerDeps {
  readonly db: Database
  readonly repos: Repositories
  readonly ledger: EventLedger
  readonly clock: Clock
  readonly rng: Rng
  readonly queueMinExpiryMs: Ms
  engine(): RunEngine
  loops(): LoopLauncher | undefined
  readonly timing?: Partial<SchedulerTiming>
  readonly log?: (event: string, fields: JsonObject) => void
  /** A tick failed outside any request; defaults to stderr. */
  readonly onError?: (error: unknown) => void
}

export interface Scheduler {
  /** Decides every schedule due at `now` and drains queued fires; ticks run one at a time. */
  tick(now: Ms): Promise<void>
  /** `POST /schedules/:id/fire`: one slot at the current instant, under the schedule's overlap policy. */
  fireNow(schedule: Schedule): Promise<FireOutcome>
  /** Runs a catch-up tick, then keeps the tick timer armed until `stop`. */
  start(): void
  /** Re-arms the timer after a schedule's next slot moved (create, PATCH, resume). */
  rearm(): void
  idle(): Promise<void>
  stop(): void
}

export const SCHEDULER = new ServiceKey<Scheduler>("scheduler")

const LOOP_TERMINAL = ["succeeded", "blocked", "exhausted", "failed", "cancelled"]

interface DueSchedule {
  readonly schedule: Schedule
  readonly start: Ms
  readonly context: { readonly project: Project }
  readonly now: Ms
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const { db, repos, ledger, clock } = deps
  const timing: SchedulerTiming = { ...DEFAULT_TIMING, ...deps.timing }
  const log = deps.log ?? ((event: string, fields: JsonObject) => console.warn(`omo-daemonic: ${event}`, fields))
  const report = deps.onError ?? ((error: unknown) => console.error("omo-daemonic: scheduler tick failed", error))
  const writer = scheduleWriter({ ledger, clock })
  const fireDeps: FireDeps = {
    db,
    repos,
    clock,
    rng: deps.rng,
    queueMinExpiryMs: deps.queueMinExpiryMs,
    engine: deps.engine,
    loops: deps.loops,
  }
  const inflight = new Set<Promise<void>>()
  let chain: Promise<void> = Promise.resolve()
  let timer: TimerHandle | null = null
  let running = false
  let lastReading: { readonly wall: Ms; readonly monotonic: Ms } | null = null

  const track = (work: Promise<unknown>): void => {
    const settled: Promise<void> = work.then(() => undefined, report).finally(() => inflight.delete(settled))
    inflight.add(settled)
  }

  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = chain.then(work)
    chain = next.then(() => undefined, () => undefined)
    return next
  }

  function noteClock(): void {
    const reading = { wall: clock.now(), monotonic: clock.monotonicNow() }
    if (lastReading !== null) {
      const wallDeltaMs = reading.wall - lastReading.wall
      const monotonicDeltaMs = reading.monotonic - lastReading.monotonic
      if (Math.abs(wallDeltaMs - monotonicDeltaMs) > timing.clockJumpMs) log("daemon.clock_jump", { wallDeltaMs, monotonicDeltaMs })
    }
    lastReading = reading
  }

  function placement(projectId: Schedule["projectId"]): { readonly project: Project } | null {
    const project = repos.projects.get(projectId)
    return project === null ? null : { project }
  }

  const runnable = (schedule: Schedule, project: Project): boolean =>
    schedule.state === "active" && schedule.deletedAt === undefined && project.state === "active" &&
    !isSpawnHeld(db, schedule.userId) && (schedule.target.kind === "run" || deps.loops() !== undefined)

  function errored(schedule: Schedule, errorReason: string): void {
    writer.save(schedule, { ...schedule, state: "errored", errorReason, nextFireAt: null })
  }

  function decideDue({ schedule, start, context, now }: DueSchedule): void {
    const compiled = compileTrigger(schedule.trigger)
    if (compiled.kind === "error") return errored(schedule, `${compiled.reason}: ${compiled.detail}`)
    if (schedule.target.kind === "loop" && deps.loops() === undefined) return errored(schedule, "loop_engine_unavailable")
    const plan = planDue({ schedule, now, source: compiled.source, blocked: !runnable(schedule, context.project) }, start)
    for (const slotAt of plan.fire) {
      fireSlot(fireDeps, { schedule, ...context, slotAt, periodMs: periodAfter(compiled.source, slotAt) })
    }
    const fireCount = schedule.fireCount + plan.fire.length
    const done = schedule.trigger.kind === "once" || plan.nextFireAt === null ||
      (schedule.maxFires !== undefined && fireCount >= schedule.maxFires)
    writer.save(schedule, {
      ...schedule,
      fireCount,
      lastSlotAt: plan.lastSlotAt,
      nextFireAt: done ? null : plan.nextFireAt,
      state: done ? "completed" : schedule.state,
    }, plan.skipped)
  }

  async function drain(id: ScheduleId, now: Ms): Promise<void> {
    const listed = repos.schedules.get(id)
    const context = listed === null ? null : placement(listed.projectId)
    const schedule = repos.schedules.get(id)
    if (schedule === null || context === null) {
      writeQueue(db, id, [])
      return
    }
    drainQueue(fireDeps, { schedule, ...context, periodMs: 0 }, now, runnable(schedule, context.project))
  }

  async function tickOnce(now: Ms): Promise<void> {
    noteClock()
    await deps.loops()?.tick(now)
    for (const id of queuedSchedules(db)) await drain(id, now)
    for (const due of repos.schedules.listDue(now)) {
      const context = placement(due.projectId)
      const schedule = repos.schedules.get(due.id)
      if (context === null || schedule === null || schedule.state !== "active" || schedule.nextFireAt === null || schedule.nextFireAt > now) continue
      decideDue({ schedule, start: schedule.nextFireAt, context, now })
    }
    arm()
  }

  const runTick = (now: Ms): Promise<void> => serial(() => tickOnce(now))

  function arm(): void {
    if (!running) return
    if (timer !== null) clock.clearTimer(timer)
    const now = clock.now()
    const due = db.query<{ readonly at: number | null }, []>("SELECT MIN(next_fire_at) AS at FROM schedules WHERE state = 'active'").get()?.at ?? null
    const nextIteration = db.query<{ readonly at: number | null }, []>(
      "SELECT MIN(next_iteration_at) AS at FROM loops WHERE state = 'waiting'",
    ).get()?.at ?? null
    const expiry = earliestExpiry(db)
    const at = Math.min(
      due ?? Number.POSITIVE_INFINITY,
      nextIteration ?? Number.POSITIVE_INFINITY,
      expiry === null ? Number.POSITIVE_INFINITY : expiry + 1,
      now + timing.maxTickIntervalMs,
    )
    timer = clock.setTimer(Math.max(at, now), () => {
      timer = null
      track(runTick(clock.now()))
    })
  }

  // A finished run or loop of a schedule with queued fires frees the schedule: drain it on the next turn.
  const unsubscribe = ledger.subscribe((event) => {
    const finished = (event.type === "run.state_changed" && event.data.state === "closed") ||
      (event.type === "loop.state_changed" && LOOP_TERMINAL.includes(String(event.data.state)))
    const scheduleId = typeof event.data.scheduleId === "string" ? parseUlid(event.data.scheduleId) : null
    if (!finished || scheduleId === null || readQueue(db, scheduleId).length === 0) return
    track(Promise.resolve().then(() => runTick(clock.now())))
  })

  return {
    tick(now) {
      const ticked = runTick(now)
      track(ticked)
      return ticked
    },

    fireNow(schedule) {
      return serial(async () => {
        const context = placement(schedule.projectId)
        const latest = repos.schedules.get(schedule.id)
        if (context === null || latest === null) throw new RangeError(`schedule ${schedule.id} has no project`)
        const compiled = compileTrigger(latest.trigger)
        if (compiled.kind === "error") throw new RangeError(compiled.detail)
        const slotAt = clock.now()
        const fireKey = fireKeyOf(latest.id, slotAt)
        const existing = repos.runs.getByFireKey(fireKey, 1)
        const outcome = fireSlot(fireDeps, {
          schedule: latest,
          ...context,
          slotAt,
          periodMs: periodAfter(compiled.source, slotAt),
        })
        if (existing !== null) return outcome
        const fireCount = latest.fireCount + 1
        const completed = latest.trigger.kind === "once" ||
          (latest.maxFires !== undefined && fireCount >= latest.maxFires)
        writer.save(latest, {
          ...latest,
          fireCount,
          nextFireAt: completed ? null : latest.nextFireAt,
          state: completed ? "completed" : latest.state,
        })
        arm()
        return outcome
      })
    },

    start() {
      running = true
      track(runTick(clock.now()))
    },

    rearm: arm,

    async idle() {
      while (inflight.size > 0) await Promise.all([...inflight])
    },

    stop() {
      running = false
      if (timer !== null) clock.clearTimer(timer)
      timer = null
      unsubscribe()
    },
  }
}
