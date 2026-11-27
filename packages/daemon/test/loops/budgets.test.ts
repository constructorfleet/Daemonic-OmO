import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"

import type { Loop, Run, RunOutcome } from "../../src/core/types"
import { createLoopEngine } from "../../src/loops/engine"
import { SeededRng } from "../support/fakes"
import { closeRigs, engineRig, type EngineRig } from "../runs/harness"

afterEach(closeRigs)

const template = {
  spec: { prompt: "Repair the project", timeoutMs: 60_000 },
  doneWhen: [{ kind: "check" as const, command: ["test-suite"], timeoutMs: 500 }],
  maxIterations: 10,
  maxWallMs: 60_000,
  maxConsecutiveFailures: 3,
  cadenceMs: 0,
  backoff: { initialMs: 100, factor: 2, maxMs: 150 },
  sessionMode: "fresh" as const,
  carryForwardBytes: 256,
}

async function start(rig: EngineRig, loopRng: SeededRng, checkExit: number | null, patch = {}) {
  const loops = createLoopEngine({
    db: rig.db,
    repos: rig.repos,
    clock: rig.clock,
    rng: loopRng,
    git: rig.git,
    fs: rig.fs,
    config: rig.config,
    worktreeRoot: join(rig.root, "worktrees"),
    engine: () => rig.engine,
    check: async () => ({ exitCode: checkExit, stdout: "", stderr: "", timedOut: false }),
  })
  rig.engine.setEvaluator((run) => loops.settled(run))
  const loop = await loops.create({ actor: rig.user, project: rig.project, template: { ...template, ...patch } })
  await loops.idle()
  await rig.engine.idle()
  return { loops, loop }
}

function runOf(rig: EngineRig, loop: Loop, iteration: number): Run {
  const run = rig.repos.runs.listByProject(loop.projectId).find((candidate) =>
    candidate.loopId === loop.id && candidate.iteration === iteration)
  if (run === undefined) throw new Error(`loop iteration ${iteration} has no run`)
  return run
}

async function complete(rig: EngineRig, run: Run, outcome: RunOutcome): Promise<void> {
  if (run.threadId === undefined) throw new Error(`run ${run.id} has no thread`)
  const status = outcome.kind === "succeeded" ? "completed" : outcome.kind === "failed" ? "failed" : "aborted"
  rig.gateway.setCompletionOutcome(run.threadId, { status, detail: null })
  await rig.engine.idle()
}

describe("loop budgets and retry policy", () => {
  test("check exit zero succeeds", async () => {
    const rig = await engineRig()
    const { loops, loop } = await start(rig, new SeededRng(71), 0)
    await complete(rig, runOf(rig, loop, 1), { kind: "succeeded" })
    expect(loops.get(loop.id)?.state).toBe("succeeded")
  })

  test("wall budget exhaustion takes precedence over a done check", async () => {
    const rig = await engineRig()
    const { loops, loop } = await start(rig, new SeededRng(72), 0, { maxWallMs: 1 })
    rig.clock.advance(1)
    await complete(rig, runOf(rig, loop, 1), { kind: "succeeded" })
    expect(loops.get(loop.id)).toMatchObject({ state: "exhausted", stopReason: "max_wall_time" })
  })

  test("the seeded failure sequence persists jittered nextIterationAt", async () => {
    const rig = await engineRig()
    const seed = 73
    const expected = new SeededRng(seed)
    for (let index = 0; index < 30; index += 1) expected.next()
    const firstDelay = Math.floor(100 * expected.next())
    const secondDelay = Math.floor(150 * expected.next())
    const loopRng = new SeededRng(seed)
    const { loops, loop } = await start(rig, loopRng, 1, { maxConsecutiveFailures: 4 })

    await complete(rig, runOf(rig, loop, 1), { kind: "failed", reason: "turn_error" })
    const afterFirst = loops.get(loop.id)
    if (afterFirst === null || afterFirst.nextIterationAt === null) throw new Error("failure did not schedule a retry")
    expect(afterFirst.nextIterationAt - rig.clock.now()).toBe(firstDelay)

    await rig.restart().recover()
    rig.engine.setEvaluator((run) => loops.settled(run))
    await loops.recover()
    expect(loops.get(loop.id)?.nextIterationAt).toBe(afterFirst.nextIterationAt)
    rig.clock.advance(firstDelay)
    await loops.tick(rig.clock.now())
    await rig.engine.idle()
    const second = runOf(rig, loop, 2)
    await complete(rig, second, { kind: "failed", reason: "turn_error" })
    const afterSecond = loops.get(loop.id)
    if (afterSecond === null || afterSecond.nextIterationAt === null) throw new Error("second failure did not schedule a retry")
    expect(afterSecond.nextIterationAt - rig.clock.now()).toBe(secondDelay)
    expect(afterSecond.consecutiveFailures).toBe(2)
  })

  test("the consecutive-failure cap fails the loop", async () => {
    const rig = await engineRig()
    const { loops, loop } = await start(rig, new SeededRng(74), 1, { maxConsecutiveFailures: 1 })
    await complete(rig, runOf(rig, loop, 1), { kind: "failed", reason: "turn_error" })
    expect(loops.get(loop.id)).toMatchObject({ state: "failed", stopReason: "consecutive_failures:1" })
  })
})
