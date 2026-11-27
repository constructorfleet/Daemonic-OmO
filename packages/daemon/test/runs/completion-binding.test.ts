import { afterEach, describe, expect, test } from "bun:test"

import type { RunSpec } from "../../src/core/types"
import { closeRigs, engineRig } from "./harness"

afterEach(closeRigs)

describe("completion binding identity", () => {
  test("a stale binding cannot settle the active run", async () => {
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

    const rebound = await rig.gateway.bindCompletion({ thread: active.threadId, events: ["completion"] })
    if (rebound.kind === "error") throw new Error(`completion rebind failed: ${rebound.message}`)
    expect(rebound.value.bindingId).not.toBe(active.completionBindingId)
    rig.gateway.setCompletionOutcome(active.threadId, { status: "completed", detail: null })
    await rig.engine.idle()
    expect(rig.repos.runs.get(run.id)?.state).toBe("active")

    await rig.engine.recover()
    rig.gateway.setCompletionOutcome(active.threadId, { status: "completed", detail: null })
    await rig.engine.idle()
    expect(rig.repos.runs.get(run.id)).toMatchObject({ state: "closed", outcome: { kind: "succeeded" } })
  })
})
