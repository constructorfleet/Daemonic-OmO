import { afterEach, describe, expect, test } from "bun:test"

import type { Project, RunSpec, User } from "../../src/core/types"
import type { DecideInput } from "../../src/runs/engine"
import { engageKillSwitch, releaseKillSwitch } from "../../src/runs/kill-switch"
import { closeRigs, engineRig, type EngineRig } from "./harness"

afterEach(closeRigs)

const spec: RunSpec = { prompt: "work", timeoutMs: 60_000 }

function adhoc(project: Project, user: User): DecideInput {
  return { project, spec, workspace: { kind: "checkout" }, trigger: { kind: "adhoc", actor: user.id } }
}

function deps(rig: EngineRig) {
  return { db: rig.db, repos: rig.repos, clock: rig.clock, rng: rig.rng, engine: rig.engine }
}

describe("kill switch", () => {
  test("stops one user's runs, schedules and loops and holds their spawns until release; other users are untouched", async () => {
    const rig = await engineRig({ project: { maxRunning: 1 } })
    rig.gateway.runOnCreate = true
    const schedule = rig.addSchedule(rig.project)
    const loop = rig.addLoop(rig.project)
    const active = rig.engine.decide(adhoc(rig.project, rig.user))
    const queued = rig.engine.decide(adhoc(rig.project, rig.user))
    const bob = rig.addUser()
    const bobProject = await rig.addProject(bob)
    const bobSchedule = rig.addSchedule(bobProject)
    const bobRun = rig.engine.decide(adhoc(bobProject, bob))
    await rig.engine.idle()

    const report = await engageKillSwitch(deps(rig), rig.user, [rig.user.id])
    await rig.engine.idle()

    expect({ ...report, cancelled: [...report.cancelled].sort() }).toEqual({
      users: [rig.user.id],
      cancelled: [active.id, queued.id].sort(),
      uninterruptible: [],
      pausedSchedules: [schedule.id],
      cancelledLoops: [loop.id],
    })
    expect(rig.repos.runs.get(active.id)?.outcome).toEqual({ kind: "cancelled" })
    expect(rig.repos.schedules.get(schedule.id)?.state).toBe("paused")
    expect(rig.repos.loops.get(loop.id)).toMatchObject({ state: "cancelled", stopReason: "kill_switch" })
    expect((await rig.engine.spawn(adhoc(rig.project, rig.user))).kind).toBe("held")
    expect(rig.repos.runs.get(bobRun.id)?.state).toBe("active")
    expect(rig.repos.schedules.get(bobSchedule.id)?.state).toBe("active")
    expect((await rig.engine.spawn(adhoc(bobProject, bob))).kind).toBe("queued")

    expect(releaseKillSwitch(deps(rig), rig.user, [rig.user.id])).toEqual({ released: [rig.user.id] })
    expect((await rig.engine.spawn(adhoc(rig.project, rig.user))).kind).toBe("queued")
    expect(rig.repos.schedules.get(schedule.id)?.state).toBe("paused")
    const actions = rig.repos.audit.listByUser(rig.user.id, 50).map((entry) => entry.action)
    expect(actions).toEqual(expect.arrayContaining(["kill_switch.engage", "kill_switch.release", "run.cancel"]))
  })

  test("a run whose thread refuses even a forced close is reported uninterruptible and stays unfinished", async () => {
    const rig = await engineRig()
    const run = rig.engine.decide(adhoc(rig.project, rig.user))
    await rig.engine.idle()
    const refused = { kind: "error", code: "bridge_timeout", message: "no answer" } as const
    rig.gateway.closeRefusals.push(refused, refused)

    const report = await engageKillSwitch(deps(rig), rig.user, [rig.user.id])
    expect(report.uninterruptible).toEqual([run.id])
    expect(report.cancelled).toEqual([])
    expect(rig.repos.runs.get(run.id)).toMatchObject({ state: "active", cancelRequested: true, errorDetail: "bridge_timeout: no answer" })
  })
})
