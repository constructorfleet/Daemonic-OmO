import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"

import { engageKillSwitch } from "../../src/runs/kill-switch"
import { createLoopEngine } from "../../src/loops/engine"
import type { Loop, Run, SessionMode } from "../../src/core/types"
import { closeRigs, engineRig, type EngineRig, type TestGateway } from "../runs/harness"

afterEach(closeRigs)

const template = (sessionMode: SessionMode) => ({
  spec: { prompt: "Continue repairing", timeoutMs: 60_000 },
  doneWhen: [{ kind: "check" as const, command: ["test-suite"], timeoutMs: 500 }],
  maxIterations: 5,
  maxWallMs: 60_000,
  maxConsecutiveFailures: 3,
  cadenceMs: 0,
  backoff: { initialMs: 100, factor: 2, maxMs: 1_000 },
  sessionMode,
  carryForwardBytes: 0,
})

function loopEngine(rig: EngineRig, sessionMode: SessionMode) {
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
  return loops
}

async function startLoop(rig: EngineRig, sessionMode: SessionMode) {
  const loops = loopEngine(rig, sessionMode)
  const loop = await loops.create({ actor: rig.user, project: rig.project, template: template(sessionMode) })
  await loops.idle()
  await rig.engine.idle()
  return { loops, loop }
}

function runOf(rig: EngineRig, loop: Loop, iteration: number): Run {
  const run = rig.repos.runs.listByProject(loop.projectId).find((candidate) =>
    candidate.loopId === loop.id && candidate.iteration === iteration)
  if (run === undefined) throw new Error(`loop iteration ${iteration} has no Run`)
  return run
}

async function complete(rig: EngineRig, run: Run): Promise<void> {
  if (run.threadId === undefined) throw new Error(`Run ${run.id} has no thread`)
  rig.gateway.setCompletionOutcome(run.threadId, { status: "completed", detail: null })
  await rig.engine.idle()
}

async function queueFollowUp(rig: EngineRig, loops: ReturnType<typeof loopEngine>, loop: Loop): Promise<Run> {
  await loops.tick(rig.clock.now())
  await loops.idle()
  await rig.engine.dispatch()
  const followUp = runOf(rig, loop, 2)
  return followUp
}

async function refusedContinuedFollowUp() {
  const rig = await engineRig()
  const { loops, loop } = await startLoop(rig, "continue")
  const first = runOf(rig, loop, 1)
  if (first.threadId === undefined) throw new Error("first iteration has no thread")
  await complete(rig, first)
  await rig.gateway.close({ thread: first.threadId, force: true })
  await rig.gateway.create({
    name: first.name,
    cwd: first.cwd,
    idempotencyKey: `${first.fireKey}:${first.attempt}`,
  })
  rig.gateway.setThreadState(first.threadId, "idle")
  const restarted = rig.restart()
  restarted.setEvaluator((run) => loops.settled(run))
  rig.gateway.closeRefusals.push({ kind: "error", code: "bridge_timeout", message: "refused predecessor close" })
  await restarted.recover()
  const second = await queueFollowUp(rig, loops, loop)
  return { rig, loops, loop, first, second, restarted }
}

function gateClose(gateway: TestGateway): { readonly entered: Promise<void>; release(): void } {
  let releaseGate = (): void => undefined
  let signalEntered = (): void => undefined
  const entered = new Promise<void>((resolve) => { signalEntered = resolve })
  gateway.closeGate = new Promise<void>((resolve) => { releaseGate = resolve })
  gateway.onCloseAttempt = signalEntered
  return { entered, release: releaseGate }
}

describe("loop follow-up close ordering", () => {
  test("a settle-close gate holds the next Run queued until release", async () => {
    const rig = await engineRig()
    const { loops, loop } = await startLoop(rig, "fresh")
    const first = runOf(rig, loop, 1)
    if (first.threadId === undefined) throw new Error("first iteration has no thread")
    const gate = gateClose(rig.gateway)
    rig.gateway.setCompletionOutcome(first.threadId, { status: "completed", detail: null })
    await gate.entered

    const second = await queueFollowUp(rig, loops, loop)
    expect(rig.repos.runs.get(second.id)?.state).toBe("queued")
    expect(rig.gateway.createCalls).toHaveLength(1)

    gate.release()
    await rig.engine.idle()
    expect(rig.repos.runs.get(second.id)?.state).toBe("active")
    expect(rig.gateway.createCalls).toHaveLength(2)
    expect(rig.gateway.closeCalls.filter((call) => call.thread === first.threadId)).toHaveLength(1)
  })

  test("a recovery re-close gate holds a continued follow-up and does not re-close it", async () => {
    const rig = await engineRig()
    const { loops, loop } = await startLoop(rig, "continue")
    const first = runOf(rig, loop, 1)
    if (first.threadId === undefined) throw new Error("first iteration has no thread")
    await complete(rig, first)
    await rig.gateway.close({ thread: first.threadId, force: true })
    await rig.gateway.create({
      name: first.name,
      cwd: first.cwd,
      idempotencyKey: `${first.fireKey}:${first.attempt}`,
    })
    rig.gateway.setThreadState(first.threadId, "idle")
    const restarted = rig.restart()
    restarted.setEvaluator((run) => loops.settled(run))
    const gate = gateClose(rig.gateway)
    const recovery = restarted.recover()
    await gate.entered

    const second = await queueFollowUp(rig, loops, loop)
    expect(rig.repos.runs.get(second.id)?.state).toBe("queued")
    expect(rig.gateway.sendCalls).toHaveLength(0)

    gate.release()
    await recovery
    await restarted.idle()
    expect(rig.repos.runs.get(second.id)).toMatchObject({ state: "active" })
    expect(rig.repos.runs.get(first.id)?.closePending).toBe(false)
    expect(rig.gateway.closeCalls.filter((call) => call.thread === first.threadId)).toHaveLength(2)
  })

  test("loop cancel removes a queued follow-up while its prior close was refused", async () => {
    const rig = await engineRig()
    const { loops, loop } = await startLoop(rig, "fresh")
    const first = runOf(rig, loop, 1)
    if (first.threadId === undefined) throw new Error("first iteration has no thread")
    rig.gateway.closeRefusals.push({ kind: "error", code: "bridge_timeout", message: "refused settle close" })
    await complete(rig, first)
    const second = await queueFollowUp(rig, loops, loop)
    expect(rig.repos.runs.get(second.id)?.state).toBe("queued")

    await loops.cancel(rig.user, loop.id)

    expect(rig.repos.loops.get(loop.id)?.state).toBe("cancelled")
    expect(rig.repos.runs.get(second.id)).toMatchObject({ state: "closed", cancelReason: "loop_cancel" })
    expect(rig.gateway.createCalls).toHaveLength(1)
    expect(rig.gateway.sendCalls).toHaveLength(0)
  })

  test("loop cancel does not stop a queued continued follow-up sharing the refused predecessor thread", async () => {
    const { rig, loops, loop, first, second, restarted } = await refusedContinuedFollowUp()
    if (first.threadId === undefined) throw new Error("first iteration has no thread")
    expect(rig.repos.runs.get(first.id)).toMatchObject({ state: "closed", closePending: true })
    expect(rig.repos.runs.get(second.id)).toMatchObject({ state: "queued", threadId: first.threadId })
    const stopCallsBeforeCancel = [...rig.gateway.stopCalls]
    const sendsBeforeCancel = [...rig.gateway.sendCalls]
    const releasesBeforeCancel = [...rig.gateway.releaseHoldCalls]

    await loops.cancel(rig.user, loop.id)

    expect(rig.repos.loops.get(loop.id)?.state).toBe("cancelled")
    expect(rig.repos.runs.get(second.id)).toMatchObject({ state: "closed", cancelReason: "loop_cancel" })
    expect(rig.gateway.stopCalls).toEqual(stopCallsBeforeCancel)
    expect(rig.gateway.sendCalls).toEqual(sendsBeforeCancel)
    expect(rig.gateway.releaseHoldCalls).toEqual(releasesBeforeCancel)

    restarted.start()
    rig.clock.advance(5_000)
    await restarted.idle()
    expect(rig.repos.runs.get(first.id)).toMatchObject({ state: "closed", closePending: false })
    expect(rig.repos.runs.get(second.id)).toMatchObject({ state: "closed", cancelReason: "loop_cancel" })
    expect(rig.gateway.stopCalls.slice(stopCallsBeforeCancel.length)).toMatchObject([
      { method: "close", args: { thread: first.threadId } },
    ])
    expect(rig.gateway.stopCalls).toHaveLength(stopCallsBeforeCancel.length + 1)
    expect(rig.gateway.sendCalls).toEqual(sendsBeforeCancel)
    expect(rig.gateway.releaseHoldCalls).toEqual(releasesBeforeCancel)
  })

  test("kill switch does not dispatch a queued follow-up after a refused close", async () => {
    const rig = await engineRig()
    const { loops, loop } = await startLoop(rig, "fresh")
    const first = runOf(rig, loop, 1)
    if (first.threadId === undefined) throw new Error("first iteration has no thread")
    rig.gateway.closeRefusals.push({ kind: "error", code: "bridge_timeout", message: "refused settle close" })
    await complete(rig, first)
    const second = await queueFollowUp(rig, loops, loop)
    expect(rig.repos.runs.get(second.id)?.state).toBe("queued")

    const report = await engageKillSwitch({
      db: rig.db,
      repos: rig.repos,
      clock: rig.clock,
      rng: rig.rng,
      engine: rig.engine,
    }, rig.user, [rig.user.id])

    expect(report.cancelled).toContain(second.id)
    expect(rig.repos.loops.get(loop.id)?.state).toBe("cancelled")
    expect(rig.repos.runs.get(second.id)).toMatchObject({ state: "closed", cancelRequested: true })
    expect(rig.gateway.createCalls).toHaveLength(1)
    expect(rig.gateway.sendCalls).toHaveLength(0)
  })

  test("kill switch does not stop a queued continued follow-up sharing the refused predecessor thread", async () => {
    const { rig, loop, first, second, restarted } = await refusedContinuedFollowUp()
    if (first.threadId === undefined) throw new Error("first iteration has no thread")
    expect(rig.repos.runs.get(first.id)).toMatchObject({ state: "closed", closePending: true })
    expect(rig.repos.runs.get(second.id)).toMatchObject({ state: "queued", threadId: first.threadId })
    const stopCallsBeforeCancel = [...rig.gateway.stopCalls]
    const sendsBeforeCancel = [...rig.gateway.sendCalls]
    const releasesBeforeCancel = [...rig.gateway.releaseHoldCalls]

    const report = await engageKillSwitch({
      db: rig.db,
      repos: rig.repos,
      clock: rig.clock,
      rng: rig.rng,
      engine: rig.engine,
    }, rig.user, [rig.user.id])

    expect(report.cancelled).toContain(second.id)
    expect(rig.repos.loops.get(loop.id)?.state).toBe("cancelled")
    expect(rig.repos.runs.get(second.id)).toMatchObject({ state: "closed", cancelRequested: true })
    expect(rig.gateway.stopCalls).toEqual(stopCallsBeforeCancel)
    expect(rig.gateway.sendCalls).toEqual(sendsBeforeCancel)
    expect(rig.gateway.releaseHoldCalls).toEqual(releasesBeforeCancel)

    restarted.start()
    rig.clock.advance(5_000)
    await restarted.idle()
    expect(rig.repos.runs.get(first.id)).toMatchObject({ state: "closed", closePending: false })
    expect(rig.repos.runs.get(second.id)).toMatchObject({ state: "closed", cancelRequested: true })
    expect(rig.gateway.stopCalls.slice(stopCallsBeforeCancel.length)).toMatchObject([
      { method: "close", args: { thread: first.threadId } },
    ])
    expect(rig.gateway.stopCalls).toHaveLength(stopCallsBeforeCancel.length + 1)
    expect(rig.gateway.sendCalls).toEqual(sendsBeforeCancel)
    expect(rig.gateway.releaseHoldCalls).toEqual(releasesBeforeCancel)
  })
})
