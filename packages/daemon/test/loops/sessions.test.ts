import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"

import type { Loop, Run } from "../../src/core/types"
import { createLoopEngine } from "../../src/loops/engine"
import { closeRigs, engineRig } from "../runs/harness"

afterEach(closeRigs)

const template = {
  spec: { prompt: "Continue repairing", timeoutMs: 60_000 },
  doneWhen: [{ kind: "check" as const, command: ["test-suite"], timeoutMs: 500 }],
  maxIterations: 5,
  maxWallMs: 60_000,
  maxConsecutiveFailures: 3,
  cadenceMs: 0,
  backoff: { initialMs: 100, factor: 2, maxMs: 1_000 },
  sessionMode: "continue" as const,
  carryForwardBytes: 256,
}

function assistantLine(text: string): string {
  return JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } })
}

function runOf(rig: Awaited<ReturnType<typeof engineRig>>, loop: Loop, iteration: number): Run {
  const run = rig.repos.runs.listByProject(loop.projectId).find((candidate) =>
    candidate.loopId === loop.id && candidate.iteration === iteration)
  if (run === undefined) throw new Error(`loop iteration ${iteration} has no run`)
  return run
}

async function startLoop(rig: Awaited<ReturnType<typeof engineRig>>) {
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
  return { loops, loop }
}

async function settleFirst(rig: Awaited<ReturnType<typeof engineRig>>, loop: Loop): Promise<Run> {
  const first = runOf(rig, loop, 1)
  if (first.threadId === undefined) throw new Error("first iteration has no thread")
  rig.gateway.setCompletionOutcome(first.threadId, { status: "completed", detail: null })
  await rig.engine.idle()
  return first
}

describe("continue-mode loop sessions", () => {
  test("a retried follow-up uses the same idempotency key and existing session", async () => {
    const rig = await engineRig()
    const { loops, loop } = await startLoop(rig)
    const first = await settleFirst(rig, loop)
    if (first.threadId === undefined) throw new Error("first iteration has no thread")
    const secondKey = `loop:${loop.id}:2:1`
    const seeded = await rig.gateway.send({
      thread: first.threadId,
      text: template.spec.prompt,
      mode: "follow_up",
      idempotencyKey: secondKey,
    })
    expect(seeded).toMatchObject({ kind: "ok", value: { delivered: true, deduplicated: false } })

    await loops.tick(rig.clock.now())
    await rig.engine.idle()
    const second = runOf(rig, loop, 2)
    expect(rig.gateway.sendCalls.map((call) => call.idempotencyKey)).toEqual([secondKey, secondKey])
    expect(rig.repos.runs.get(second.id)).toMatchObject({ state: "active", threadId: first.threadId })
  })

  test("a held follow-up resumes without changing its prompt or creating another session", async () => {
    const rig = await engineRig()
    const { loops, loop } = await startLoop(rig)
    const first = await settleFirst(rig, loop)
    if (first.threadId === undefined) throw new Error("first iteration has no thread")
    rig.gateway.setSessionHeld(first.threadId, true)

    await loops.tick(rig.clock.now())
    await rig.engine.idle()
    const second = runOf(rig, loop, 2)
    expect(rig.gateway.releaseHoldCalls).toEqual([{ thread: first.threadId, text: second.spec.prompt }])
    expect(rig.gateway.createCalls).toHaveLength(1)
    expect(rig.repos.runs.get(second.id)).toMatchObject({ state: "active", threadId: first.threadId })
  })

  test("a lost continue-mode thread starts the next run in the same loop worktree", async () => {
    const rig = await engineRig()
    const sessionDir = join(rig.user.agentDir, "sessions", "--project--")
    await rig.fs.mkdir(sessionDir)
    const oldSessionFile = join(sessionDir, "2026-11-27T00-00-00_thread-1.jsonl")
    await rig.fs.write(oldSessionFile, "")
    const { loops, loop } = await startLoop(rig)
    const first = await settleFirst(rig, loop)
    if (first.threadId === undefined) throw new Error("first iteration has no thread")
    await rig.gateway.close({ thread: first.threadId, force: true })

    await loops.tick(rig.clock.now())
    await rig.engine.idle()
    const second = runOf(rig, loop, 2)
    expect(rig.gateway.createCalls).toHaveLength(2)
    expect(rig.gateway.sendCalls).toHaveLength(1)
    expect(rig.repos.runs.get(second.id)).toMatchObject({
      state: "active",
      cwd: join(rig.root, "worktrees", rig.project.id, loop.id),
      threadId: "thread-2",
    })
    expect(rig.repos.runs.get(second.id)?.sessionFile).toBeUndefined()
    expect(first.sessionFile).toBe(oldSessionFile)
  })

  test("the idle-plus-assistant fallback ignores the previous continued turn", async () => {
    const rig = await engineRig()
    const sessionDir = join(rig.user.agentDir, "sessions", "--project--")
    await rig.fs.mkdir(sessionDir)
    const sessionFile = join(sessionDir, "2026-11-27T00-00-00_thread-1.jsonl")
    await rig.fs.write(sessionFile, "")
    const { loops, loop } = await startLoop(rig)
    const first = await settleFirst(rig, loop)
    if (first.threadId === undefined) throw new Error("first iteration has no thread")
    const previousTurn = `${assistantLine("previous iteration completed")}\n`
    await rig.fs.write(sessionFile, previousTurn)

    await loops.tick(rig.clock.now())
    await rig.engine.idle()
    const second = runOf(rig, loop, 2)
    expect(second.transcriptBaselineBytes).toBe(new TextEncoder().encode(previousTurn).length)
    rig.gateway.setThreadState(first.threadId, "idle")
    rig.engine.start()
    rig.clock.advance(5_000)
    await rig.engine.idle()
    expect(rig.repos.runs.get(second.id)?.state).toBe("active")

    await rig.fs.write(sessionFile, `${previousTurn}${assistantLine("continued turn completed")}\n`)
    rig.clock.advance(5_000)
    await rig.engine.idle()
    expect(rig.repos.runs.get(second.id)).toMatchObject({ state: "closed", outcome: { kind: "succeeded" } })
  })
})
