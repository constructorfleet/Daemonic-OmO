import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"

import type { LoopTemplate } from "../../src/core/types"
import { createLoopEngine } from "../../src/loops/engine"
import { closeRigs, engineRig } from "../runs/harness"

afterEach(closeRigs)

const template: LoopTemplate = {
  spec: { prompt: "Repair the project", timeoutMs: 60_000 },
  doneWhen: [{ kind: "marker" }],
  maxIterations: 5,
  maxWallMs: 60_000,
  maxConsecutiveFailures: 3,
  cadenceMs: 0,
  backoff: { initialMs: 100, factor: 2, maxMs: 1_000 },
  sessionMode: "fresh",
  carryForwardBytes: 256,
}

function assistant(text: string): string {
  return JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } })
}

async function setup() {
  const rig = await engineRig()
  const sessionDir = join(rig.user.agentDir, "sessions", "--project--")
  await rig.fs.mkdir(sessionDir)
  const sessionFile = join(sessionDir, "2026-11-27T00-00-00_thread-1.jsonl")
  await rig.fs.write(sessionFile, "")
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
  const run = rig.repos.runs.listByProject(rig.project.id).find((candidate) => candidate.loopId === loop.id)
  if (run === undefined || run.threadId === undefined) throw new Error("loop iteration did not start")
  return { rig, loops, loop, run, sessionFile }
}

describe("marker completion", () => {
  test("an earlier assistant marker does not finish an iteration", async () => {
    const { rig, loops, loop, run, sessionFile } = await setup()
    const transcript = [
      assistant(`LOOP_DONE ${loop.nonce}`),
      assistant("The task still needs work."),
    ].join("\n")
    await rig.fs.write(sessionFile, `${transcript}\n`)
    if (run.threadId === undefined) throw new Error("run has no thread")
    rig.gateway.setCompletionOutcome(run.threadId, { status: "completed", detail: null })
    await rig.engine.idle()

    expect(loops.get(loop.id)?.state).toBe("waiting")
  })

  test("a whole final-turn marker with the loop nonce succeeds", async () => {
    const { rig, loops, loop, run, sessionFile } = await setup()
    await rig.fs.write(sessionFile, `${assistant(`LOOP_DONE ${loop.nonce}`)}\n`)
    if (run.threadId === undefined) throw new Error("run has no thread")
    rig.gateway.setCompletionOutcome(run.threadId, { status: "completed", detail: null })
    await rig.engine.idle()

    expect(loops.get(loop.id)?.state).toBe("succeeded")
  })

  test("three marker iterations emit three iteration-start events before success", async () => {
    const rig = await engineRig()
    const sessionDir = join(rig.user.agentDir, "sessions", "--project--")
    await rig.fs.mkdir(sessionDir)
    const sessionFile = (thread: number): string =>
      join(sessionDir, `2026-11-27T00-00-00_thread-${thread}.jsonl`)
    await rig.fs.write(sessionFile(1), "")
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

    for (const iteration of [1, 2, 3]) {
      const run = rig.repos.runs.listByProject(rig.project.id).find((candidate) =>
        candidate.loopId === loop.id && candidate.iteration === iteration)
      if (run?.threadId === undefined) throw new Error(`iteration ${iteration} has no thread`)
      await rig.fs.write(sessionFile(iteration), `${assistant(
        iteration === 3 ? `LOOP_DONE ${loop.nonce}` : `LOOP_CONTINUE ${loop.nonce}`,
      )}\n`)
      rig.gateway.setCompletionOutcome(run.threadId, { status: "completed", detail: null })
      await rig.engine.idle()
      if (iteration < 3) {
        await rig.fs.write(sessionFile(iteration + 1), "")
        await loops.tick(rig.clock.now())
        await loops.idle()
        await rig.engine.idle()
      }
    }

    const events = rig.db.query<{ readonly type: string }, [string]>(
      "SELECT type FROM events WHERE entity_id = ? AND type IN ('loop.iteration_started', 'loop.state_changed') ORDER BY seq",
    ).all(loop.id).map(({ type }) => type)
    expect(events.filter((type) => type === "loop.iteration_started")).toHaveLength(3)
    expect(events.at(-1)).toBe("loop.state_changed")
    expect(loops.get(loop.id)?.state).toBe("succeeded")
  })
})
