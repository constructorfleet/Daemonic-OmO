import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

import type { RunId, RunSpec, ThreadId } from "../../src/core/types"
import type { DecideInput } from "../../src/runs/engine"
import { closeRigs, engineRig, type EngineRig } from "./harness"

afterEach(closeRigs)

const spec: RunSpec = { prompt: "Reply with exactly OK", timeoutMs: 60_000 }

function adhoc(rig: EngineRig, overrides: Partial<DecideInput> = {}): DecideInput {
  return { project: rig.project, spec, workspace: { kind: "checkout" }, trigger: { kind: "adhoc", actor: rig.user.id }, ...overrides }
}

function scheduled(rig: EngineRig, overrides: Partial<DecideInput> = {}): DecideInput {
  const schedule = rig.addSchedule(rig.project)
  return { ...adhoc(rig), trigger: { kind: "schedule", scheduleId: schedule.id, fireKey: `sched:${schedule.id}:1`, slotAt: 1 }, ...overrides }
}

function threadOf(rig: EngineRig, id: RunId): ThreadId {
  const thread = rig.repos.runs.get(id)?.threadId
  if (thread === undefined) throw new Error(`run ${id} has no thread`)
  return thread
}

describe("cancel and timeout", () => {
  test("a cancel that arrives while create is in flight closes the thread create returned and ends cancelled", async () => {
    const rig = await engineRig()
    let release = (): void => undefined
    rig.gateway.createGate = new Promise((resolve) => { release = resolve })
    const entered = new Promise<void>((resolve) => { rig.gateway.onCreateAttempt = resolve })
    const run = rig.engine.decide(adhoc(rig))
    await entered
    const cancelling = rig.engine.cancel(rig.user, run.id, "user")
    release()
    const result = await cancelling
    await rig.engine.idle()

    expect(result.uninterruptible).toBe(false)
    expect(rig.repos.runs.get(run.id)).toMatchObject({ state: "closed", outcome: { kind: "cancelled" }, cancelRequested: true, threadId: "thread-1" })
    expect(rig.gateway.stopCalls.map((call) => call.method)).toEqual(["interrupt", "close"])
    expect((await rig.gateway.list()).kind === "ok" && (await rig.gateway.list())).toMatchObject({ value: [] })
  })

  test("past activeAt + timeoutMs the thread is interrupted, closed gracefully for 10 s, then force-closed, and the run ends timed_out", async () => {
    const rig = await engineRig()
    rig.gateway.gracefulCloseTimesOut = true
    const run = rig.engine.decide(adhoc(rig))
    await rig.engine.idle()
    rig.clock.advance(59_999)
    await rig.engine.idle()
    expect(rig.repos.runs.get(run.id)?.state).toBe("active")

    rig.clock.advance(1)
    await rig.engine.idle()
    const thread = threadOf(rig, run.id)
    expect(rig.gateway.stopCalls).toEqual([
      { method: "interrupt", args: { thread, allScope: true } },
      { method: "close", args: { thread, graceful: true, waitMs: 10_000 } },
      { method: "close", args: { thread, force: true } },
    ])
    expect(rig.repos.runs.get(run.id)).toMatchObject({ state: "closed", outcome: { kind: "timed_out" } })
  })
})

describe("completion", () => {
  test("the completion arm settles an unattended run and its thread is closed gracefully", async () => {
    const rig = await engineRig()
    const run = rig.engine.decide(scheduled(rig))
    await rig.engine.idle()
    const thread = threadOf(rig, run.id)
    expect(rig.gateway.bindCompletionCalls).toEqual([{ thread, events: ["completion"] }])

    rig.gateway.setCompletionOutcome(thread, { status: "completed", detail: null })
    await rig.engine.idle()
    expect(rig.repos.runs.get(run.id)).toMatchObject({ state: "closed", outcome: { kind: "succeeded" } })
    expect(rig.gateway.stopCalls).toEqual([{ method: "close", args: { thread, graceful: true, waitMs: 30_000 } }])
  })

  test("a failed turn settles failed(turn_error)", async () => {
    const rig = await engineRig()
    const run = rig.engine.decide(scheduled(rig))
    await rig.engine.idle()
    rig.gateway.setCompletionOutcome(threadOf(rig, run.id), { status: "failed", detail: "boom" })
    await rig.engine.idle()
    expect(rig.repos.runs.get(run.id)?.outcome).toEqual({ kind: "failed", reason: "turn_error" })
  })

  test("an ad-hoc run is kept after it settles, and its idle kept thread frees the project slot", async () => {
    const rig = await engineRig({ project: { maxRunning: 1 } })
    rig.gateway.runOnCreate = true
    const first = rig.engine.decide(adhoc(rig))
    const second = rig.engine.decide(adhoc(rig))
    await rig.engine.idle()
    expect(rig.repos.runs.get(second.id)?.state).toBe("queued")

    const thread = threadOf(rig, first.id)
    rig.gateway.setThreadState(thread, "idle")
    rig.gateway.setCompletionOutcome(thread, { status: "completed", detail: null })
    await rig.engine.idle()
    expect(rig.repos.runs.get(first.id)).toMatchObject({ state: "kept", outcome: { kind: "succeeded" } })
    expect(rig.repos.runs.get(second.id)?.state).toBe("active")
    expect(rig.gateway.closeCalls).toHaveLength(0)
  })

  test("without a completion event, an idle thread whose session ends with an assistant message settles on the supervision pass", async () => {
    const rig = await engineRig()
    const run = rig.engine.decide(scheduled(rig))
    await rig.engine.idle()
    const thread = threadOf(rig, run.id)
    const folder = join(rig.user.agentDir, "sessions", "--repo--")
    await mkdir(folder, { recursive: true })
    const lines = [
      { type: "session", id: thread, cwd: rig.project.cwd },
      { type: "message", message: { role: "user", content: [{ type: "text", text: spec.prompt }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "OK" }] } },
    ]
    await writeFile(join(folder, `2026-11-25T00-00-00_${thread}.jsonl`), lines.map((line) => JSON.stringify(line)).join("\n") + "\n")
    rig.engine.start()
    rig.clock.advance(5_000)
    await rig.engine.idle()
    expect(rig.repos.runs.get(run.id)).toMatchObject({ state: "closed", outcome: { kind: "succeeded" } })
  })
})

describe("caps and placement", () => {
  test("the machine cap holds a second user's run while the first thread runs", async () => {
    const rig = await engineRig({ limits: { machineMaxRunning: 1 } })
    rig.gateway.runOnCreate = true
    const other = rig.addUser()
    const otherProject = await rig.addProject(other)
    rig.engine.decide(adhoc(rig))
    const held = rig.engine.decide({ ...adhoc(rig), project: otherProject, trigger: { kind: "adhoc", actor: other.id } })
    await rig.engine.idle()
    expect(rig.repos.runs.get(held.id)?.state).toBe("queued")
  })

  test("an unattended run gets a daemon-created worktree and its thread runs there", async () => {
    const rig = await engineRig()
    const run = rig.engine.decide(scheduled(rig, { workspace: { kind: "run_worktree", name: "nightly" } }))
    await rig.engine.idle()
    const path = join(rig.root, "worktrees", rig.project.id, run.id)
    expect(rig.git.worktreeAdds.map(({ repo, path: added, base }) => ({ repo, path: added, base }))).toEqual([{ repo: rig.project.cwd, path, base: "HEAD" }])
    expect(rig.gateway.createCalls.map((call) => call.cwd)).toEqual([path])
    expect(rig.repos.runs.get(run.id)).toMatchObject({ state: "active", cwd: path, worktreePath: path, branch: `omo-daemonic/sched-nightly-${run.id}` })
  })

  test("past the kept-worktree cap the run is skipped(worktree_cap) and no thread is created", async () => {
    const rig = await engineRig({ limits: { maxKeptWorktreesPerProject: 1 } })
    rig.git.seedWorktree(rig.project.cwd, { path: join(rig.root, "worktrees", rig.project.id, "kept"), branch: "kept", head: "abc", bare: false })
    const run = rig.engine.decide(scheduled(rig, { workspace: { kind: "run_worktree", name: "nightly" } }))
    await rig.engine.idle()
    expect(rig.repos.runs.get(run.id)).toMatchObject({ state: "closed", outcome: { kind: "skipped", reason: "worktree_cap" } })
    expect(rig.gateway.createCalls).toHaveLength(0)
  })
})

describe("create failures", () => {
  test("host_unavailable: the host is ensured once, create retried once, then the run fails host_unavailable with the detail", async () => {
    const rig = await engineRig()
    const refusal = { kind: "error", code: "host_unavailable", message: "no operator socket" } as const
    rig.gateway.createRefusals.push(refusal, refusal)
    const run = rig.engine.decide(adhoc(rig))
    await rig.engine.idle()

    expect(rig.gateway.ensureHostCalls).toEqual([{ agentDir: rig.project.agentDir }])
    expect(rig.gateway.createAttempts).toHaveLength(2)
    expect(rig.repos.runs.get(run.id)).toMatchObject({
      state: "closed",
      outcome: { kind: "failed", reason: "host_unavailable" },
      errorDetail: "host_unavailable: no operator socket",
    })
  })

  test("a refused create fails create_refused and frees the slot for the next queued run", async () => {
    const rig = await engineRig()
    rig.gateway.createRefusals.push({ kind: "error", code: "invalid_arguments", message: "bad cwd" })
    const refused = rig.engine.decide(adhoc(rig))
    const next = rig.engine.decide(adhoc(rig))
    await rig.engine.idle()
    expect(rig.repos.runs.get(refused.id)?.outcome).toEqual({ kind: "failed", reason: "create_refused" })
    expect(rig.repos.runs.get(next.id)?.state).toBe("active")
  })
})
