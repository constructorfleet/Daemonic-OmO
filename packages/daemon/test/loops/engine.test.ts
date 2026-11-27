import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"

import type { Loop, Run } from "../../src/core/types"
import { createLoopEngine } from "../../src/loops/engine"
import { closeRigs, engineRig } from "../runs/harness"

afterEach(closeRigs)

const template = {
  spec: { prompt: "Repair the project", timeoutMs: 60_000 },
  doneWhen: [{ kind: "check" as const, command: ["test-suite"], timeoutMs: 500 }],
  maxIterations: 2,
  maxWallMs: 60_000,
  maxConsecutiveFailures: 3,
  cadenceMs: 0,
  backoff: { initialMs: 100, factor: 2, maxMs: 1_000 },
  sessionMode: "fresh" as const,
  carryForwardBytes: 256,
}

function runOf(runs: readonly Run[], loop: Loop, iteration: number): Run {
  const run = runs.find((candidate) => candidate.loopId === loop.id && candidate.iteration === iteration)
  if (run === undefined) throw new Error(`loop iteration ${iteration} has no run`)
  return run
}

describe("loop iteration engine", () => {
  test("iterations reuse the loop worktree and maxIterations exhausts the loop", async () => {
    const rig = await engineRig()
    const checks: string[] = []
    const loops = createLoopEngine({
      db: rig.db,
      repos: rig.repos,
      clock: rig.clock,
      rng: rig.rng,
      git: rig.git,
      fs: rig.fs,
      config: rig.config,
      worktreeRoot: join(rig.root, "worktrees"),
      engine: () => rig.engine,
      check: async (spec) => {
        checks.push(spec.cwd)
        return { exitCode: 1, stdout: "", stderr: "", timedOut: false }
      },
    })
    rig.engine.setEvaluator((run) => loops.settled(run))

    const created = await loops.create({ actor: rig.user, project: rig.project, template })
    await loops.idle()
    await rig.engine.idle()
    const first = runOf(rig.repos.runs.listByProject(rig.project.id), created, 1)
    if (first.threadId === undefined) throw new Error("first iteration has no thread")
    rig.gateway.setCompletionOutcome(first.threadId, { status: "completed", detail: null })
    await rig.engine.idle()

    await loops.tick(rig.clock.now())
    await loops.idle()
    await rig.engine.idle()
    const second = runOf(rig.repos.runs.listByProject(rig.project.id), created, 2)
    if (second.threadId === undefined) throw new Error("second iteration has no thread")
    rig.gateway.setCompletionOutcome(second.threadId, { status: "completed", detail: null })
    await rig.engine.idle()

    const worktree = join(rig.root, "worktrees", rig.project.id, created.id)
    expect(rig.gateway.createCalls.map((call) => call.cwd)).toEqual([worktree, worktree])
    expect(rig.git.worktreeAdds.map((entry) => entry.path)).toEqual([worktree])
    expect(checks).toEqual([worktree])
    expect(rig.repos.loops.get(created.id)).toMatchObject({ state: "exhausted", iteration: 2, stopReason: "max_iterations" })
    const iterations = rig.db.query<{ readonly count: number }, [string, string]>(
      "SELECT COUNT(*) AS count FROM events WHERE entity_id = ? AND type = ?",
    ).get(created.id, "loop.iteration_started")
    expect(iterations?.count).toBe(2)
  })

  test("a refused settle close keeps the follow-up queued until supervision closes the prior Run", async () => {
    const rig = await engineRig()
    let evaluations = 0
    const loops = createLoopEngine({
      db: rig.db,
      repos: rig.repos,
      clock: rig.clock,
      rng: rig.rng,
      git: rig.git,
      fs: rig.fs,
      config: rig.config,
      worktreeRoot: join(rig.root, "worktrees"),
      engine: () => rig.engine,
      check: async () => {
        evaluations += 1
        return { exitCode: 1, stdout: "", stderr: "", timedOut: false }
      },
    })
    rig.engine.setEvaluator((run) => loops.settled(run))
    const created = await loops.create({
      actor: rig.user,
      project: rig.project,
      template: { ...template, maxIterations: 4 },
    })
    await loops.idle()
    await rig.engine.idle()
    const first = runOf(rig.repos.runs.listByProject(rig.project.id), created, 1)
    if (first.threadId === undefined) throw new Error("first iteration has no thread")
    rig.gateway.closeRefusals.push({ kind: "error", code: "bridge_timeout", message: "delayed close" })
    rig.gateway.setCompletionOutcome(first.threadId, { status: "completed", detail: null })
    await rig.engine.idle()
    expect(rig.repos.runs.get(first.id)?.state).toBe("evaluating")

    await loops.tick(rig.clock.now())
    await loops.idle()
    await rig.engine.idle()
    const second = runOf(rig.repos.runs.listByProject(rig.project.id), created, 2)
    expect(rig.repos.runs.get(second.id)?.state).toBe("queued")
    expect(second.threadId).toBeUndefined()

    rig.engine.start()
    rig.clock.advance(5_000)
    await rig.engine.idle()

    expect(evaluations).toBe(1)
    expect(rig.repos.runs.get(first.id)?.state).toBe("closed")
    expect(rig.repos.runs.get(second.id)?.state).toBe("active")
  })

  test("a complete goal ends a loop while a missing goal cleanly continues it", async () => {
    const rig = await engineRig()
    const loops = createLoopEngine({
      db: rig.db,
      repos: rig.repos,
      clock: rig.clock,
      rng: rig.rng,
      git: rig.git,
      fs: rig.fs,
      config: rig.config,
      worktreeRoot: join(rig.root, "worktrees"),
      engine: () => rig.engine,
      check: async () => ({ exitCode: 1, stdout: "", stderr: "", timedOut: false }),
    })
    rig.engine.setEvaluator((run) => loops.settled(run))
    const goalTemplate = { ...template, doneWhen: [{ kind: "goal" as const }] }
    const complete = await loops.create({ actor: rig.user, project: rig.project, template: goalTemplate })
    await loops.idle()
    await rig.engine.idle()
    const first = runOf(rig.repos.runs.listByProject(rig.project.id), complete, 1)
    if (first.sessionId === undefined || first.threadId === undefined) throw new Error("goal iteration lacks session identity")
    const goalPath = join(first.cwd, ".omo", "goal", `${encodeURIComponent(first.sessionId)}.json`)
    await rig.fs.mkdir(join(first.cwd, ".omo", "goal"))
    await rig.fs.write(goalPath, JSON.stringify({
      version: 1,
      goal: {
        id: "goal-id",
        sessionID: first.sessionId,
        objective: "Repair the project",
        status: "complete",
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    }))
    rig.gateway.setCompletionOutcome(first.threadId, { status: "completed", detail: null })
    await rig.engine.idle()
    expect(rig.repos.loops.get(complete.id)?.state).toBe("succeeded")

    const missing = await loops.create({ actor: rig.user, project: rig.project, template: goalTemplate })
    await loops.idle()
    await rig.engine.idle()
    const second = runOf(rig.repos.runs.listByProject(rig.project.id), missing, 1)
    if (second.threadId === undefined) throw new Error("missing-goal iteration has no thread")
    rig.gateway.setCompletionOutcome(second.threadId, { status: "completed", detail: null })
    await rig.engine.idle()
    expect(rig.repos.loops.get(missing.id)).toMatchObject({ state: "waiting", consecutiveFailures: 0 })
  })

  test("loop cancellation interrupts and closes its active run", async () => {
    const rig = await engineRig()
    const loops = createLoopEngine({
      db: rig.db,
      repos: rig.repos,
      clock: rig.clock,
      rng: rig.rng,
      git: rig.git,
      fs: rig.fs,
      config: rig.config,
      worktreeRoot: join(rig.root, "worktrees"),
      engine: () => rig.engine,
      check: async () => ({ exitCode: 1, stdout: "", stderr: "", timedOut: false }),
    })
    rig.engine.setEvaluator((run) => loops.settled(run))
    const loop = await loops.create({ actor: rig.user, project: rig.project, template })
    await loops.idle()
    await rig.engine.idle()
    const run = runOf(rig.repos.runs.listByProject(rig.project.id), loop, 1)
    if (run.threadId === undefined) throw new Error("active loop run has no thread")

    await loops.cancel(rig.user, loop.id)

    expect(rig.repos.loops.get(loop.id)?.state).toBe("cancelled")
    expect(rig.repos.runs.get(run.id)).toMatchObject({ state: "closed", cancelReason: "loop_cancel" })
    expect(rig.gateway.stopCalls.map((call) => call.method)).toEqual(["interrupt", "close"])
  })

  test("a check that cannot spawn counts a failure and still closes the Run", async () => {
    const rig = await engineRig()
    const loops = createLoopEngine({
      db: rig.db,
      repos: rig.repos,
      clock: rig.clock,
      rng: rig.rng,
      git: rig.git,
      fs: rig.fs,
      config: rig.config,
      worktreeRoot: join(rig.root, "worktrees"),
      engine: () => rig.engine,
      check: async () => ({ exitCode: null, stdout: "", stderr: "not found", timedOut: false }),
    })
    rig.engine.setEvaluator((run) => loops.settled(run))
    const loop = await loops.create({ actor: rig.user, project: rig.project, template: { ...template, maxIterations: 4 } })
    await loops.idle()
    await rig.engine.idle()
    const run = runOf(rig.repos.runs.listByProject(rig.project.id), loop, 1)
    if (run.threadId === undefined) throw new Error("check iteration has no thread")
    rig.gateway.setCompletionOutcome(run.threadId, { status: "completed", detail: null })
    await rig.engine.idle()

    expect(rig.repos.loops.get(loop.id)).toMatchObject({
      state: "waiting",
      consecutiveFailures: 1,
      errorDetail: "loop check could not start: not found",
    })
    expect(rig.repos.runs.get(run.id)?.state).toBe("closed")
  })
})
