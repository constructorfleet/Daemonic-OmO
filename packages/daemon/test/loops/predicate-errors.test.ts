import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"

import { FsError, type Fs } from "../../src/core/ports"
import type { LoopTemplate, Run } from "../../src/core/types"
import { createLoopEngine } from "../../src/loops/engine"
import { closeRigs, engineRig, type EngineRig } from "../runs/harness"

afterEach(closeRigs)

const goalTemplate: LoopTemplate = {
  spec: { prompt: "Continue the goal", timeoutMs: 60_000 },
  doneWhen: [{ kind: "goal" }],
  maxIterations: 4,
  maxWallMs: 60_000,
  maxConsecutiveFailures: 3,
  cadenceMs: 0,
  backoff: { initialMs: 100, factor: 2, maxMs: 1_000 },
  sessionMode: "fresh",
  carryForwardBytes: 0,
}

function loopEngine(rig: EngineRig, fs: Fs = rig.fs) {
  const loops = createLoopEngine({
    db: rig.db,
    repos: rig.repos,
    clock: rig.clock,
    rng: rig.rng,
    git: rig.git,
    fs,
    config: rig.config,
    worktreeRoot: join(rig.root, "worktrees"),
    engine: () => rig.engine,
  })
  rig.engine.setEvaluator((run) => loops.settled(run))
  return loops
}

function goalRun(rig: EngineRig, loopId: string): Run {
  const run = rig.repos.runs.listByProject(rig.project.id).find((candidate) => candidate.loopId === loopId)
  if (run?.sessionId === undefined || run.threadId === undefined) throw new Error("goal run lacks a session")
  return run
}

async function finishGoalRun(rig: EngineRig, run: Run): Promise<void> {
  if (run.threadId === undefined) throw new Error("goal run has no thread")
  rig.gateway.setCompletionOutcome(run.threadId, { status: "completed", detail: null })
  await rig.engine.idle()
}

describe("goal predicate errors", () => {
  test("a present malformed goal increments failures, stores detail, and closes the Run", async () => {
    const rig = await engineRig()
    const loops = loopEngine(rig)
    const loop = await loops.create({ actor: rig.user, project: rig.project, template: goalTemplate })
    await loops.idle()
    await rig.engine.idle()
    const run = goalRun(rig, loop.id)
    const goalDir = join(run.cwd, ".omo", "goal")
    await rig.fs.mkdir(goalDir)
    await rig.fs.write(join(goalDir, `${encodeURIComponent(run.sessionId ?? "")}.json`), "{")
    await finishGoalRun(rig, run)

    expect(rig.repos.loops.get(loop.id)).toMatchObject({
      state: "waiting",
      consecutiveFailures: 1,
      errorDetail: "goal file is malformed JSON",
    })
    expect(rig.repos.runs.get(run.id)?.state).toBe("closed")
  })

  test("a present unreadable goal increments failures instead of appearing missing", async () => {
    const rig = await engineRig()
    const fs: Fs = {
      readFileRange: (path, offset, length) => rig.fs.readFileRange(path, offset, length),
      async stat(path) {
        if (path.includes(`${join(".omo", "goal")}/`)) throw new FsError(path, "permission_denied")
        return rig.fs.stat(path)
      },
      readdir: (path) => rig.fs.readdir(path),
      open: (path) => rig.fs.open(path),
      watchHint: (path) => rig.fs.watchHint(path),
    }
    const loops = loopEngine(rig, fs)
    const loop = await loops.create({ actor: rig.user, project: rig.project, template: goalTemplate })
    await loops.idle()
    await rig.engine.idle()
    const run = goalRun(rig, loop.id)
    const goalDir = join(run.cwd, ".omo", "goal")
    await rig.fs.mkdir(goalDir)
    await rig.fs.write(join(goalDir, `${encodeURIComponent(run.sessionId ?? "")}.json`), "{}")
    await finishGoalRun(rig, run)

    expect(rig.repos.loops.get(loop.id)).toMatchObject({
      state: "waiting",
      consecutiveFailures: 1,
      errorDetail: expect.stringContaining("permission_denied"),
    })
    expect(rig.repos.runs.get(run.id)?.state).toBe("closed")
  })

  test("an upstream-invalid blocked status is not treated as goal completion", async () => {
    const rig = await engineRig()
    const loops = loopEngine(rig)
    const loop = await loops.create({ actor: rig.user, project: rig.project, template: goalTemplate })
    await loops.idle()
    await rig.engine.idle()
    const run = goalRun(rig, loop.id)
    const goalDir = join(run.cwd, ".omo", "goal")
    await rig.fs.mkdir(goalDir)
    await rig.fs.write(join(goalDir, `${encodeURIComponent(run.sessionId ?? "")}.json`), JSON.stringify({
      version: 1,
      goal: {
        id: "goal-id",
        sessionID: run.sessionId,
        objective: "Continue the goal",
        status: "blocked",
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    }))
    await finishGoalRun(rig, run)

    expect(rig.repos.loops.get(loop.id)).toMatchObject({
      state: "waiting",
      consecutiveFailures: 1,
      errorDetail: "goal file does not match schema version 1",
    })
    expect(rig.repos.runs.get(run.id)?.state).toBe("closed")
  })
})
