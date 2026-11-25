import type { Database } from "bun:sqlite"

import { ServiceKey } from "../api/services"
import type { Repositories } from "../auth/types"
import { ulid } from "../core/ids"
import type { Clock, Rng } from "../core/ports"
import type { LoopTemplate, Ms, Project, Run, RunSkipReason, RunSpec, Schedule, ScheduleId } from "../core/types"
import { newRun } from "../runs/decide"
import type { DecideInput, RunEngine } from "../runs/engine"
import { readQueue, writeQueue, type QueuedFire } from "./queue"

export const UNFINISHED_RUN_STATES = "('queued', 'creating', 'active', 'settled', 'evaluating')"

export interface LoopLaunch {
  readonly project: Project
  readonly scheduleId: ScheduleId
  readonly template: LoopTemplate
  readonly fireKey: string
  readonly slotAt: Ms
}

/** Provided by the loop engine (todo 18): parses a schedule's loop target and starts one loop per fire key. */
export interface LoopLauncher {
  parseTemplate(value: unknown): LoopTemplate
  launch(input: LoopLaunch): void
  tick(now: Ms): Promise<void>
}

export const LOOP_LAUNCHER = new ServiceKey<LoopLauncher>("loopLauncher")

export type FireOutcome =
  | { readonly kind: "decided"; readonly run: Run }
  | { readonly kind: "skipped"; readonly run: Run }
  | { readonly kind: "queued"; readonly fire: QueuedFire }
  | { readonly kind: "loop_started"; readonly fireKey: string }

export interface FireDeps {
  readonly db: Database
  readonly repos: Repositories
  readonly clock: Clock
  readonly rng: Rng
  readonly queueMinExpiryMs: Ms
  engine(): RunEngine
  loops(): LoopLauncher | undefined
}

export interface SlotFire {
  readonly schedule: Schedule
  readonly project: Project
  readonly slotAt: Ms
  /** Time to the trigger's next slot; a queued fire also uses the configured minimum expiry. */
  readonly periodMs: Ms
}

export class LoopEngineUnavailableError extends Error {
  readonly name = "LoopEngineUnavailableError"

  constructor(readonly scheduleId: ScheduleId) {
    super(`schedule ${scheduleId} targets a loop but the loop engine is not available`)
  }
}

export function fireKeyOf(scheduleId: ScheduleId, slotAt: Ms): string {
  return `sched:${scheduleId}:${slotAt}`
}

function specOf(schedule: Schedule): RunSpec {
  return schedule.target.kind === "run" ? schedule.target.spec : schedule.target.template.spec
}

/** Unfinished runs, plus live loops for loop targets, of this schedule. */
export function scheduleBusy(db: Database, scheduleId: ScheduleId): boolean {
  const row = db.query<{ readonly busy: number }, [string, string]>(
    `SELECT EXISTS(SELECT 1 FROM runs WHERE schedule_id = ? AND state IN ${UNFINISHED_RUN_STATES})
       OR EXISTS(SELECT 1 FROM loops WHERE json_extract(json, '$.scheduleId') = ? AND state IN ('pending', 'running', 'waiting', 'cancelling'))
       AS busy`,
  ).get(scheduleId, scheduleId)
  return row !== null && row.busy === 1
}

/** A skipped run is a closed row that uses up the fire key; it never reaches the engine, so nothing is spawned. */
function skipRun(deps: FireDeps, fire: SlotFire, reason: RunSkipReason): Run {
  const now = deps.clock.now()
  const at = new Date(now).toISOString()
  const trigger = { kind: "schedule", scheduleId: fire.schedule.id, fireKey: fireKeyOf(fire.schedule.id, fire.slotAt), slotAt: fire.slotAt } as const
  const row = newRun(
    { project: fire.project, spec: specOf(fire.schedule), workspace: { kind: "checkout" }, trigger },
    { id: ulid(deps.rng, now), at, worktreeRoot: "" },
  )
  const run: Run = { ...row, state: "closed", outcome: { kind: "skipped", reason }, endedAt: at }
  deps.repos.runs.put(run)
  return run
}

export function launch(deps: FireDeps, fire: SlotFire): FireOutcome {
  const { schedule, project, slotAt } = fire
  const fireKey = fireKeyOf(schedule.id, slotAt)
  switch (schedule.target.kind) {
    case "run": {
      const input: DecideInput = {
        project,
        spec: schedule.target.spec,
        workspace: { kind: "run_worktree", name: schedule.name },
        trigger: { kind: "schedule", scheduleId: schedule.id, fireKey, slotAt },
      }
      return { kind: "decided", run: deps.engine().decide(input) }
    }
    case "loop": {
      const launcher = deps.loops()
      if (launcher === undefined) throw new LoopEngineUnavailableError(schedule.id)
      launcher.launch({ project, scheduleId: schedule.id, template: schedule.target.template, fireKey, slotAt })
      return { kind: "loop_started", fireKey }
    }
    default:
      return assertNever(schedule.target)
  }
}

/**
 * Fires one slot exactly once: a fire key that already has a row returns it (a tick replayed after a crash, or a
 * second tick at the same instant), otherwise the schedule's overlap policy decides while it is busy.
 */
export function fireSlot(deps: FireDeps, fire: SlotFire): FireOutcome {
  const { schedule, slotAt } = fire
  const existing = deps.repos.runs.getByFireKey(fireKeyOf(schedule.id, slotAt), 1)
  if (existing !== null) return { kind: existing.outcome?.kind === "skipped" ? "skipped" : "decided", run: existing }
  if (!scheduleBusy(deps.db, schedule.id)) return launch(deps, fire)
  switch (schedule.overlap) {
    case "parallel":
      return launch(deps, fire)
    case "skip":
      return { kind: "skipped", run: skipRun(deps, fire, "overlap") }
    case "queue": {
      const queue = readQueue(deps.db, schedule.id)
      const held = queue.find((entry) => entry.slotAt === slotAt)
      if (held !== undefined) return { kind: "queued", fire: held }
      if (queue.length >= schedule.queueMax) return { kind: "skipped", run: skipRun(deps, fire, "queue_full") }
      const entry: QueuedFire = { slotAt, expiresAt: slotAt + Math.max(fire.periodMs, deps.queueMinExpiryMs) }
      writeQueue(deps.db, schedule.id, [...queue, entry])
      return { kind: "queued", fire: entry }
    }
    default:
      return assertNever(schedule.overlap)
  }
}

/** Expired queued fires become `skipped(stale)` rows; the oldest live one fires once the schedule is idle. */
export function drainQueue(deps: FireDeps, fire: Omit<SlotFire, "slotAt">, now: Ms, runnable: boolean): void {
  const { schedule } = fire
  const queue = [...readQueue(deps.db, schedule.id)]
  const live = queue.filter((entry) => {
    if (now <= entry.expiresAt) return true
    if (deps.repos.runs.getByFireKey(fireKeyOf(schedule.id, entry.slotAt), 1) === null) skipRun(deps, { ...fire, slotAt: entry.slotAt }, "stale")
    return false
  })
  const head = live[0]
  if (runnable && head !== undefined && !scheduleBusy(deps.db, schedule.id)) {
    launch(deps, { ...fire, slotAt: head.slotAt })
    live.shift()
  }
  writeQueue(deps.db, schedule.id, live)
}

function assertNever(value: never): never {
  throw new TypeError(`unexpected variant: ${JSON.stringify(value)}`)
}
