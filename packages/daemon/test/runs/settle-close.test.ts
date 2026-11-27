import { afterEach, describe, expect, test } from "bun:test"

import type { RunSpec } from "../../src/core/types"
import { closeRigs, engineRig } from "./harness"

afterEach(closeRigs)

async function waitForGate(started: Promise<void>, label: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} gate was not entered`)), 5_000)
  })
  try {
    await Promise.race([started, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

describe("settled run close recovery", () => {
  test("a loop follow-up stays queued until its predecessor's settle close resolves", async () => {
    const rig = await engineRig()
    const loop = rig.addLoop(rig.project)
    const spec: RunSpec = { prompt: "Finish the task", timeoutMs: 60_000 }
    rig.engine.setEvaluator(async () => false)
    const first = rig.engine.decide({
      project: rig.project,
      spec,
      workspace: { kind: "checkout" },
      trigger: { kind: "loop", loopId: loop.id, iteration: 1, fireKey: `loop:${loop.id}:1` },
    })
    await rig.engine.idle()
    const active = rig.repos.runs.get(first.id)
    if (active?.threadId === undefined || active.sessionId === undefined) throw new Error("active loop run has no session")

    let closeStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      closeStarted = resolve
    })
    let releaseClose: (() => void) | undefined
    rig.gateway.closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve
    })
    rig.gateway.onCloseAttempt = () => closeStarted?.()
    rig.gateway.setCompletionOutcome(active.threadId, { status: "completed", detail: null })
    await waitForGate(started, "settle close")

    const followUp = rig.engine.decide({
      project: rig.project,
      spec,
      workspace: { kind: "checkout" },
      trigger: { kind: "loop", loopId: loop.id, iteration: 2, fireKey: `loop:${loop.id}:2` },
      continuation: {
        threadId: active.threadId,
        sessionId: active.sessionId,
        baselineBytes: 0,
      },
    })
    await rig.engine.dispatch()
    expect(rig.repos.runs.get(followUp.id)?.state).toBe("queued")
    expect(rig.gateway.sendCalls).toHaveLength(0)

    rig.gateway.closeGate = null
    releaseClose?.()
    await rig.engine.idle()
    expect(rig.repos.runs.get(first.id)?.state).toBe("closed")
    expect(rig.repos.runs.get(followUp.id)?.state).toBe("active")
    expect(rig.gateway.sendCalls).toHaveLength(1)
  })

  test("a loop follow-up decided during recovery re-close starts after that close", async () => {
    const rig = await engineRig()
    const loop = rig.addLoop(rig.project)
    const spec: RunSpec = { prompt: "Finish the task", timeoutMs: 60_000 }
    rig.engine.setEvaluator(async () => false)
    const first = rig.engine.decide({
      project: rig.project,
      spec,
      workspace: { kind: "checkout" },
      trigger: { kind: "loop", loopId: loop.id, iteration: 1, fireKey: `loop:${loop.id}:1` },
    })
    await rig.engine.idle()
    const active = rig.repos.runs.get(first.id)
    if (active?.threadId === undefined || active.sessionId === undefined) throw new Error("active loop run has no session")
    rig.gateway.setCompletionOutcome(active.threadId, { status: "completed", detail: null })
    await rig.engine.idle()
    expect(rig.repos.runs.get(first.id)?.state).toBe("closed")

    rig.gateway.restoreThread(active.threadId)
    let closeStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      closeStarted = resolve
    })
    let releaseClose: (() => void) | undefined
    rig.gateway.closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve
    })
    rig.gateway.onCloseAttempt = () => closeStarted?.()
    const recovery = rig.engine.recover()
    await waitForGate(started, "recovery re-close")

    const followUp = rig.engine.decide({
      project: rig.project,
      spec,
      workspace: { kind: "checkout" },
      trigger: { kind: "loop", loopId: loop.id, iteration: 2, fireKey: `loop:${loop.id}:2` },
      continuation: {
        threadId: active.threadId,
        sessionId: active.sessionId,
        baselineBytes: 0,
      },
    })
    await rig.engine.dispatch()
    expect(rig.repos.runs.get(followUp.id)?.state).toBe("queued")
    expect(rig.gateway.sendCalls).toHaveLength(0)

    rig.gateway.closeGate = null
    releaseClose?.()
    await recovery
    await rig.engine.idle()
    expect(rig.repos.runs.get(followUp.id)?.state).toBe("active")
    expect(rig.gateway.sendCalls).toHaveLength(1)
    expect(rig.gateway.closeCalls).toHaveLength(2)
  })

  test("a graceful close timeout leaves evaluation durable for a later recovery pass", async () => {
    const rig = await engineRig()
    const schedule = rig.addSchedule(rig.project)
    const spec: RunSpec = { prompt: "Finish the task", timeoutMs: 60_000 }
    const run = rig.engine.decide({
      project: rig.project,
      spec,
      workspace: { kind: "checkout" },
      trigger: { kind: "schedule", scheduleId: schedule.id, fireKey: `sched:${schedule.id}:1`, slotAt: 1 },
    })
    await rig.engine.idle()
    const active = rig.repos.runs.get(run.id)
    if (active?.threadId === undefined) throw new Error("active run has no thread")
    rig.gateway.gracefulCloseTimesOut = true
    rig.gateway.setCompletionOutcome(active.threadId, { status: "completed", detail: null })
    await rig.engine.idle()
    expect(rig.repos.runs.get(run.id)?.state).toBe("evaluating")

    rig.gateway.gracefulCloseTimesOut = false
    await rig.engine.recover()
    await rig.engine.idle()
    expect(rig.repos.runs.get(run.id)).toMatchObject({ state: "closed", outcome: { kind: "succeeded" } })
    expect(rig.gateway.closeCalls).toHaveLength(2)
  })
})
