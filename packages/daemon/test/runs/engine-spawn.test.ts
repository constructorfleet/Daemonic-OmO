import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"

import { closeRigs, engineRig } from "./harness"

afterEach(closeRigs)

const spec = (prompt: string) => ({ prompt, timeoutMs: 60_000, model: "zai/glm-5.3-flash", thinking: "low" as const })

describe("spawning a run", () => {
  test("an ad-hoc run puts its prompt inside one create with no permission_preset and goes active in the checkout", async () => {
    const rig = await engineRig()
    const decided = rig.engine.decide({ project: rig.project, spec: spec("Reply with exactly OK"), workspace: { kind: "checkout" }, trigger: { kind: "adhoc", actor: rig.user.id } })
    await rig.engine.idle()

    expect(rig.gateway.createCalls).toEqual([{
      name: `odm-${decided.id}`,
      cwd: rig.project.cwd,
      model: "zai/glm-5.3-flash",
      reasoning: "low",
      prompt: "Reply with exactly OK",
      idempotencyKey: `adhoc:${decided.id}:1`,
    }])
    expect(rig.gateway.sendCalls).toHaveLength(0)
    const run = rig.repos.runs.get(decided.id)
    expect(run).toMatchObject({ state: "active", cwd: rig.project.cwd, threadId: "thread-1", sessionId: "session-thread-1" })
    expect(rig.errors).toEqual([])
  })

  test("the run and its spawn audit row record the agent-dir default permission mode, a prompt hash and the first 500 characters", async () => {
    const rig = await engineRig()
    const prompt = `${"x".repeat(499)}YZ`
    const decided = rig.engine.decide({ project: rig.project, spec: spec(prompt), workspace: { kind: "checkout" }, trigger: { kind: "adhoc", actor: rig.user.id } })
    await rig.engine.idle()

    expect(rig.repos.runs.get(decided.id)?.permissionMode).toBe("agent-dir-default")
    const [entry] = rig.repos.audit.listByUser(rig.user.id, 10)
    expect(entry).toMatchObject({ action: "run.spawn", entityKind: "run", entityId: decided.id })
    expect(entry?.detail).toMatchObject({
      permissionMode: "agent-dir-default",
      promptSha256: createHash("sha256").update(prompt).digest("hex"),
      promptHead: `${"x".repeat(499)}Y`,
      actorId: rig.user.id,
      trigger: "adhoc",
    })
  })

  test("two scheduler ticks for one fire key decide one run and produce one create", async () => {
    const rig = await engineRig()
    const schedule = rig.addSchedule(rig.project)
    const trigger = { kind: "schedule", scheduleId: schedule.id, fireKey: `sched:${schedule.id}:1700000000000`, slotAt: 1_700_000_000_000 } as const
    const first = rig.engine.decide({ project: rig.project, spec: spec("tick"), workspace: { kind: "checkout" }, trigger })
    const second = rig.engine.decide({ project: rig.project, spec: spec("tick"), workspace: { kind: "checkout" }, trigger })
    await rig.engine.idle()

    expect(second.id).toBe(first.id)
    expect(rig.gateway.createCalls.map((call) => call.idempotencyKey)).toEqual([`${trigger.fireKey}:1`])
  })
})
