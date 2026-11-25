import type { Database } from "bun:sqlite"

import type { Repositories } from "../auth/types"
import { parseUlid } from "../core/ids"
import type { Clock, Rng } from "../core/ports"
import type { Iso, LoopId, RunId, ScheduleId, Ulid, User, UserId } from "../core/types"
import { auditKillSwitch } from "./audit"
import type { RunEngine } from "./engine"
import { createRunRecords } from "./records"
import { clearSpawnHold, setSpawnHold } from "./spawn-hold"

export interface KillSwitchDeps {
  readonly db: Database
  readonly repos: Repositories
  readonly clock: Clock
  readonly rng: Rng
  readonly engine: RunEngine
}

export interface KillSwitchReport {
  readonly users: readonly UserId[]
  readonly cancelled: readonly RunId[]
  /** Runs whose thread refused even a forced close; they stay unfinished with `cancelRequested`. */
  readonly uninterruptible: readonly RunId[]
  readonly pausedSchedules: readonly ScheduleId[]
  readonly cancelledLoops: readonly LoopId[]
}

function ids(db: Database, sql: string, userId: UserId): readonly Ulid[] {
  return db.query<{ readonly id: string }, [string]>(sql).all(userId).flatMap(({ id }) => {
    const parsed = parseUlid(id)
    return parsed === null ? [] : [parsed]
  })
}

function pauseSchedules(deps: KillSwitchDeps, userId: UserId, at: Iso): readonly ScheduleId[] {
  return ids(deps.db, "SELECT id FROM schedules WHERE user_id = ? AND state = 'active' ORDER BY id", userId).flatMap((id) => {
    const schedule = deps.repos.schedules.get(id)
    if (schedule === null) return []
    deps.repos.schedules.update({ ...schedule, state: "paused", revision: schedule.revision + 1 }, schedule.revision, at)
    return [schedule.id]
  })
}

function cancelLoops(deps: KillSwitchDeps, userId: UserId, at: Iso): readonly LoopId[] {
  const sql = "SELECT id FROM loops WHERE user_id = ? AND state IN ('pending', 'running', 'waiting', 'cancelling') ORDER BY id"
  return ids(deps.db, sql, userId).flatMap((id) => {
    const loop = deps.repos.loops.get(id)
    if (loop === null) return []
    deps.repos.loops.update(
      { ...loop, state: "cancelled", stopReason: "kill_switch", endedAt: at, nextIterationAt: null, revision: loop.revision + 1 },
      loop.revision,
      at,
    )
    return [loop.id]
  })
}

/**
 * Per target user: sets the spawn hold first (so nothing new starts), pauses active schedules, cancels live
 * loops, then cancels every unfinished daemon-started run. Schedules stay paused after the release.
 */
export async function engageKillSwitch(deps: KillSwitchDeps, actor: User, users: readonly UserId[]): Promise<KillSwitchReport> {
  const records = createRunRecords(deps.db, deps.repos, deps.clock)
  const audit = { audit: deps.repos.audit, clock: deps.clock, rng: deps.rng }
  const allCancelled: RunId[] = []
  const allUninterruptible: RunId[] = []
  const allPaused: ScheduleId[] = []
  const allLoops: LoopId[] = []
  for (const userId of users) {
    const at = new Date(deps.clock.now()).toISOString()
    setSpawnHold(deps.db, userId, at)
    const paused = pauseSchedules(deps, userId, at)
    const loops = cancelLoops(deps, userId, at)
    const cancelled: RunId[] = []
    const uninterruptible: RunId[] = []
    for (const run of records.unfinishedOf(userId)) {
      const result = await deps.engine.cancel(actor, run.id, "user")
      ;(result.uninterruptible ? uninterruptible : cancelled).push(run.id)
    }
    auditKillSwitch(audit, "kill_switch.engage", userId, {
      actorId: actor.id, cancelled, uninterruptible, pausedSchedules: paused, cancelledLoops: loops,
    })
    allCancelled.push(...cancelled)
    allUninterruptible.push(...uninterruptible)
    allPaused.push(...paused)
    allLoops.push(...loops)
  }
  return { users, cancelled: allCancelled, uninterruptible: allUninterruptible, pausedSchedules: allPaused, cancelledLoops: allLoops }
}

export function releaseKillSwitch(deps: KillSwitchDeps, actor: User, users: readonly UserId[]): { readonly released: readonly UserId[] } {
  const audit = { audit: deps.repos.audit, clock: deps.clock, rng: deps.rng }
  const released = users.filter((userId) => clearSpawnHold(deps.db, userId))
  for (const userId of released) auditKillSwitch(audit, "kill_switch.release", userId, { actorId: actor.id })
  return { released }
}
