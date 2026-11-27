import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"

import { ulid } from "../../src/core/ids"
import type { Loop, LoopTemplate, Project, Run, Schedule } from "../../src/core/types"
import type { LoopLaunch, LoopLauncher } from "../../src/scheduler/scheduler"
import { SeededRng } from "../support/fakes"
import { closeSchedulerRigs, HOUR, schedulerRig, type SchedulerRig } from "./harness"

afterEach(closeSchedulerRigs)

const T0 = Date.parse("2027-01-10T00:00:00Z")
const S1 = T0 + HOUR / 2
const S2 = S1 + HOUR
const S3 = S2 + HOUR

function bySlot(rig: SchedulerRig, schedule: Schedule): ReadonlyMap<number | undefined, Run> {
  return new Map(rig.runsOf(schedule).map((run) => [run.slotAt, run]))
}

async function complete(rig: SchedulerRig, run: Run | undefined): Promise<void> {
  const thread = run === undefined ? undefined : rig.repos.runs.get(run.id)?.threadId
  if (thread === undefined) throw new Error("run has no thread")
  rig.gateway.setThreadState(thread, "idle")
  rig.gateway.setCompletionOutcome(thread, { status: "completed", detail: null })
  await rig.settle()
}

describe("overlap", () => {
  test("skip: a slot that comes due while the previous run is unfinished is a skipped(overlap) row", async () => {
    const rig = await schedulerRig({ wallMs: T0 })
    const schedule = rig.create({ overlap: "skip" })
    await rig.scheduler.tick(S1)
    await rig.settle()
    await rig.scheduler.tick(S2)
    await rig.settle()
    const runs = bySlot(rig, schedule)
    expect(runs.get(S1)).toMatchObject({ state: "active" })
    expect(runs.get(S1)?.worktreePath).toBe(join(rig.root, "worktrees", rig.project.id, runs.get(S1)?.id ?? ""))
    expect(runs.get(S2)).toMatchObject({ state: "closed", outcome: { kind: "skipped", reason: "overlap" }, fireKey: `sched:${schedule.id}:${S2}` })
    expect(rig.gateway.createCalls).toHaveLength(1)
  })

  test("queue: one slot waits (queueMax 1), the next is skipped(queue_full), and the waiting slot fires when the run ends", async () => {
    const rig = await schedulerRig({ wallMs: T0 })
    const schedule = rig.create({ overlap: "queue" })
    expect(schedule.queueMax).toBe(1)
    await rig.scheduler.tick(S1)
    await rig.settle()
    await rig.scheduler.tick(S2)
    await rig.scheduler.tick(S3)
    await rig.settle()
    expect(bySlot(rig, schedule).has(S2)).toBe(false)
    expect(bySlot(rig, schedule).get(S3)).toMatchObject({ outcome: { kind: "skipped", reason: "queue_full" } })

    await complete(rig, bySlot(rig, schedule).get(S1))
    expect(bySlot(rig, schedule).get(S1)).toMatchObject({ state: "closed", outcome: { kind: "succeeded" } })
    expect(bySlot(rig, schedule).get(S2)).toMatchObject({ state: "active", fireKey: `sched:${schedule.id}:${S2}` })
  })

  test("queue: a waiting slot older than slot + max(period, 1 h) becomes skipped(stale)", async () => {
    const rig = await schedulerRig({ wallMs: T0 })
    const schedule = rig.create({ overlap: "queue" })
    await rig.scheduler.tick(S1)
    await rig.settle()
    await rig.scheduler.tick(S2)
    await rig.settle()
    expect(bySlot(rig, schedule).has(S2)).toBe(false)

    await rig.scheduler.tick(S3 + 1)
    await rig.settle()
    expect(bySlot(rig, schedule).get(S2)).toMatchObject({ state: "closed", outcome: { kind: "skipped", reason: "stale" } })
    expect(bySlot(rig, schedule).has(S3)).toBe(false)
    await complete(rig, bySlot(rig, schedule).get(S1))
    expect(bySlot(rig, schedule).get(S3)).toMatchObject({ state: "active" })
  })

  test("parallel: every slot is decided while earlier runs are unfinished", async () => {
    const rig = await schedulerRig({ wallMs: T0, project: { maxRunning: 2 } })
    const schedule = rig.create({ overlap: "parallel" })
    await rig.scheduler.tick(S1)
    await rig.scheduler.tick(S2)
    await rig.settle()
    expect(rig.runsOf(schedule).map((run) => [run.slotAt, run.state])).toEqual([[S1, "active"], [S2, "active"]])
  })
})

describe("caps and fairness", () => {
  test("the per-project cap holds a second schedule's run queued; decisions are never blocked", async () => {
    const rig = await schedulerRig({ wallMs: T0 })
    rig.gateway.runOnCreate = true
    const first = rig.create({ name: "first" })
    const second = rig.create({ name: "second" })
    await rig.scheduler.tick(S1)
    await rig.settle()
    const states = [...rig.runsOf(first), ...rig.runsOf(second)].map((run) => run.state).sort()
    expect(states).toEqual(["active", "queued"])
  })

  test("the machine-wide cap holds runs across projects", async () => {
    const rig = await schedulerRig({ wallMs: T0, limits: { machineMaxRunning: 1 } })
    rig.gateway.runOnCreate = true
    const a = rig.create({})
    const b = rig.create({}, await rig.addProject())
    await rig.scheduler.tick(S1)
    await rig.settle()
    expect([...rig.runsOf(a), ...rig.runsOf(b)].map((run) => run.state).sort()).toEqual(["active", "queued"])
  })

  test("dispatch round-robins projects: after project A's run, project B goes before A's second run", async () => {
    const rig = await schedulerRig({ wallMs: T0, limits: { machineMaxRunning: 1 } })
    rig.gateway.runOnCreate = true
    const a1 = rig.create({ name: "a1" })
    const a2 = rig.create({ name: "a2" })
    const projectB = await rig.addProject()
    const b = rig.create({ name: "b", trigger: { kind: "interval", everyMs: HOUR, anchorAt: new Date(S1 + 1_000).toISOString() } }, projectB)
    await rig.scheduler.tick(S1)
    await rig.settle()
    rig.clock.advance(1_000)
    await rig.scheduler.tick(S1 + 1_000)
    await rig.settle()
    const firstA = [...rig.runsOf(a1), ...rig.runsOf(a2)].find((run) => run.state === "active")
    expect(firstA).toBeDefined()

    await complete(rig, firstA)
    expect(rig.runsOf(b).map((run) => run.state)).toEqual(["active"])
    expect([...rig.runsOf(a1), ...rig.runsOf(a2)].map((run) => run.state).sort()).toEqual(["closed", "queued"])
  })

  test("a waiting loop holds no slot, so an unrelated scheduled run can start", async () => {
    const rig = await schedulerRig({ wallMs: T0 })
    rig.gateway.runOnCreate = true
    rig.repos.loops.put(loopRow(rig.project, "waiting"), new Date(T0).toISOString())
    const schedule = rig.create({})
    await rig.scheduler.tick(S1)
    await rig.settle()
    expect(rig.runsOf(schedule).map((run) => run.state)).toEqual(["active"])
  })
})

const template: LoopTemplate = {
  spec: { prompt: "iterate", timeoutMs: 60_000 },
  doneWhen: [{ kind: "marker" }],
  maxIterations: 3,
  maxConsecutiveFailures: 3,
  cadenceMs: 0,
  backoff: { initialMs: 1_000, factor: 2, maxMs: 60_000 },
  sessionMode: "fresh",
  carryForwardBytes: 0,
}

const loopRng = new SeededRng(23)

function loopRow(project: Project, state: Loop["state"], launch?: LoopLaunch): Loop {
  return {
    ...template,
    id: ulid(loopRng, T0),
    userId: project.userId,
    projectId: project.id,
    ...(launch === undefined ? {} : { scheduleId: launch.scheduleId }),
    fireKey: launch?.fireKey ?? `loop:${project.id}`,
    nonce: "nonce",
    state,
    iteration: 1,
    consecutiveFailures: 0,
    nextIterationAt: null,
    revision: 1,
  }
}

describe("loop targets", () => {
  test("a loop target is launched once per fire key, and a live loop makes the next slot skipped(overlap)", async () => {
    const launches: LoopLaunch[] = []
    let rig: SchedulerRig | null = null
    const loops: LoopLauncher = {
      parseTemplate: () => template,
      async tick() {},
      async settled() {
        return false
      },
      launch(input) {
        launches.push(input)
        rig?.repos.loops.put(loopRow(input.project, "running", input), new Date(T0).toISOString())
      },
    }
    rig = await schedulerRig({ wallMs: T0, loops })
    const schedule = rig.create({ target: { kind: "loop", template } })
    await rig.scheduler.tick(S1)
    await rig.scheduler.tick(S1)
    await rig.scheduler.tick(S2)
    await rig.settle()
    expect(launches.map((launch) => launch.fireKey)).toEqual([`sched:${schedule.id}:${S1}`])
    expect(rig.runsOf(schedule)).toMatchObject([{ slotAt: S2, outcome: { kind: "skipped", reason: "overlap" }, spec: template.spec }])
  })

  test("without the loop engine a loop-target schedule is errored instead of firing", async () => {
    const rig = await schedulerRig({ wallMs: T0 })
    const schedule = rig.create({ target: { kind: "loop", template } })
    await rig.scheduler.tick(S1)
    await rig.settle()
    expect(rig.schedule(schedule.id)).toMatchObject({ state: "errored", errorReason: "loop_engine_unavailable", nextFireAt: null })
  })
})
