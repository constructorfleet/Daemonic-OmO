import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import type { RunId, RunSpec, ThreadId } from "../../src/core/types"
import type { DecideInput } from "../../src/runs/engine"
import { GATEWAY_FAILPOINTS, GatewayFailpointError } from "../support/fakes"
import { closeRigs, engineRig, type EngineRig } from "./harness"

afterEach(closeRigs)

const MODEL = "zai/glm-5.3-flash"
const spec: RunSpec = { prompt: "Fix the flaky test", timeoutMs: 600_000, model: MODEL }

function scheduled(rig: EngineRig, slot = 1): DecideInput {
  const schedule = rig.addSchedule(rig.project)
  return { project: rig.project, spec, workspace: { kind: "checkout" }, trigger: { kind: "schedule", scheduleId: schedule.id, fireKey: `sched:${schedule.id}:${slot}`, slotAt: slot } }
}

async function visibleThreads(rig: EngineRig): Promise<readonly ThreadId[]> {
  const listed = await rig.gateway.list()
  if (listed.kind !== "ok") throw new Error("list refused")
  return listed.value.map((snapshot) => snapshot.thread)
}

function threadOf(rig: EngineRig, id: RunId): ThreadId {
  const thread = rig.repos.runs.get(id)?.threadId
  if (thread === undefined) throw new Error(`run ${id} has no thread`)
  return thread
}

describe("crash recovery per fire key", () => {
  for (const failpoint of GATEWAY_FAILPOINTS) {
    test(`${failpoint}: recovery ends with exactly one thread and one delivered prompt`, async () => {
      const rig = await engineRig()
      rig.gateway.failNext(failpoint)
      const run = rig.engine.decide(scheduled(rig))
      await rig.engine.idle()
      expect(rig.errors).toEqual([new GatewayFailpointError(failpoint)])
      expect(rig.repos.runs.get(run.id)?.state).toBe("creating")

      await rig.restart().recover()
      await rig.engine.idle()

      expect(rig.repos.runs.get(run.id)?.state).toBe("active")
      expect(await visibleThreads(rig)).toEqual([threadOf(rig, run.id)])
      // omo delivers a create's prompt once per idempotency key (FINDINGS assertion 2), and nothing is sent.
      expect(new Set(rig.gateway.createCalls.map((call) => call.idempotencyKey))).toEqual(new Set([`${run.fireKey}:1`]))
      expect(rig.gateway.createCalls.every((call) => call.prompt === spec.prompt)).toBe(true)
      expect(rig.gateway.sendCalls).toHaveLength(0)
    })
  }

  test("an active run whose thread is gone is marked lost(thread_missing) and never respawned", async () => {
    const rig = await engineRig()
    const run = rig.engine.decide(scheduled(rig))
    await rig.engine.idle()
    await rig.gateway.close({ thread: threadOf(rig, run.id), force: true })

    await rig.restart().recover()
    await rig.engine.idle()
    expect(rig.repos.runs.get(run.id)).toMatchObject({ state: "closed", outcome: { kind: "lost", reason: "thread_missing" } })
    expect(rig.gateway.createCalls).toHaveLength(1)
  })

  test("a run left evaluating because its close was refused is evaluated again and closed", async () => {
    const rig = await engineRig()
    const run = rig.engine.decide(scheduled(rig))
    await rig.engine.idle()
    rig.gateway.closeRefusals.push({ kind: "error", code: "bridge_timeout", message: "slow" })
    rig.gateway.setCompletionOutcome(threadOf(rig, run.id), { status: "completed", detail: null })
    await rig.engine.idle()
    expect(rig.repos.runs.get(run.id)?.state).toBe("evaluating")

    await rig.restart().recover()
    await rig.engine.idle()
    expect(rig.repos.runs.get(run.id)).toMatchObject({ state: "closed", outcome: { kind: "succeeded" } })
  })
})

describe("operator restart recovery", () => {
  test("a held session whose transcript lacks the prompt is released once with the prompt, then its model is re-applied", async () => {
    const rig = await engineRig()
    const run = rig.engine.decide(scheduled(rig))
    await rig.engine.idle()
    const thread = threadOf(rig, run.id)
    rig.gateway.setSessionHeld(thread, true)

    await rig.restart().recover()
    await rig.engine.idle()
    await rig.restart().recover()
    await rig.engine.idle()

    expect(rig.gateway.releaseHoldCalls).toEqual([{ thread, text: spec.prompt }])
    expect(rig.gateway.calls.filter((call) => call.method === "setModel").map((call) => call.args)).toEqual([{ thread, model: MODEL }])
    const actions = rig.repos.audit.listByUser(rig.user.id, 10).map((entry) => entry.action)
    expect(actions.filter((action) => action === "run.hold_release")).toHaveLength(1)
  })

  test("a held session that already holds the prompt is released with the fixed resume text", async () => {
    const rig = await engineRig()
    const run = rig.engine.decide(scheduled(rig))
    await rig.engine.idle()
    const thread = threadOf(rig, run.id)
    const folder = join(rig.user.agentDir, "sessions", "--repo--")
    await mkdir(folder, { recursive: true })
    const delivered = { type: "custom_message", content: spec.prompt }
    await writeFile(join(folder, `2026-11-25T00-00-00_${thread}.jsonl`), `${JSON.stringify(delivered)}\n`)
    rig.gateway.setSessionHeld(thread, true)

    await rig.restart().recover()
    await rig.engine.idle()
    expect(rig.gateway.releaseHoldCalls).toEqual([{ thread, text: "Resume the interrupted task." }])
  })

  test("a thread the daemon had closed that the restore lists again is closed again", async () => {
    const rig = await engineRig()
    const run = rig.engine.decide(scheduled(rig))
    await rig.engine.idle()
    const thread = threadOf(rig, run.id)
    rig.gateway.setCompletionOutcome(thread, { status: "completed", detail: null })
    await rig.engine.idle()
    expect(await visibleThreads(rig)).toEqual([])
    await rig.gateway.create({ name: run.name, cwd: run.cwd, idempotencyKey: `${run.fireKey}:1` })
    rig.gateway.setThreadState(thread, "idle")
    expect(await visibleThreads(rig)).toEqual([thread])

    await rig.restart().recover()
    await rig.engine.idle()
    expect(await visibleThreads(rig)).toEqual([])
    expect(rig.repos.runs.get(run.id)?.state).toBe("closed")
  })
})
