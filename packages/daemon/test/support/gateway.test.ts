import { describe, expect, test } from "bun:test"
import { sessionId, threadId } from "../../src/core/ids"
import type { CreateThreadArgs, GatewayResult, ThreadSnapshot } from "../../src/core/ports"
import { FakeGateway, GatewayFailpointError } from "./fakes"

const THREAD_1 = threadId("thread-1")
const SESSION_1 = sessionId("session-thread-1")

const CREATE: CreateThreadArgs = {
  name: "odm-run-1",
  cwd: "/work/project",
  model: "gpt-5",
  reasoning: "high",
  permissionPreset: "workspace",
  idempotencyKey: "fire-1:1",
}

async function ok<T>(result: Promise<GatewayResult<T>>): Promise<T> {
  const settled = await result
  if (settled.kind !== "ok") {
    throw new Error(`expected ok, got ${settled.code}: ${settled.message}`)
  }
  return settled.value
}

async function capture(action: () => Promise<unknown>): Promise<unknown> {
  try {
    await action()
    return null
  } catch (error) {
    return error
  }
}

describe("FakeGateway", () => {
  test("create records the cwd and returns an idle thread visible from list", async () => {
    const gateway = new FakeGateway()

    const created = await ok(gateway.create(CREATE))

    expect(created).toEqual({ thread: THREAD_1, sessionId: SESSION_1, created: true })
    expect(gateway.createCalls[0]?.cwd).toBe("/work/project")
    expect(gateway.createCalls[0]?.permissionPreset).toBe("workspace")
    const listed = await ok(gateway.list())
    const expected: readonly ThreadSnapshot[] = [
      {
        thread: THREAD_1,
        name: "odm-run-1",
        cwd: "/work/project",
        state: "idle",
        controls: ["interrupt", "close"],
        sessionId: SESSION_1,
        surface: "created",
      },
    ]
    expect(listed).toEqual(expected)
  })

  test("thread state and capabilities are controllable for read", async () => {
    const gateway = new FakeGateway()
    const thread = gateway.seedThread({ name: "seeded", cwd: "/work/seeded" })

    const before = await ok(gateway.read({ thread }))
    expect(before.state).toBe("idle")
    expect(before.controls).toEqual(["interrupt", "close"])

    gateway.setThreadState(thread, "running")
    gateway.setThreadControls(thread, ["interrupt"])

    const after = await ok(gateway.read({ thread }))
    expect(after.state).toBe("running")
    expect(after.controls).toEqual(["interrupt"])
  })

  test("sdkLoad fail makes probe report fail and create refuse with sdk_unavailable", async () => {
    const gateway = new FakeGateway({ sdkLoad: "fail" })

    const probe = await gateway.probe()
    expect(probe.sdkLoad).toBe("fail")
    expect(probe.presetNames).toEqual([])

    const created = await gateway.create(CREATE)
    expect(created.kind).toBe("error")
    if (created.kind !== "error") throw new Error("expected refusal")
    expect(created.code).toBe("sdk_unavailable")
    expect(gateway.createCalls).toHaveLength(1)
  })

  test("afterCreateBeforeCommit fails the create, hides the thread, and a retry reopens it", async () => {
    const gateway = new FakeGateway()
    gateway.failNext("afterCreateBeforeCommit")

    const error = await capture(() => gateway.create(CREATE))
    if (!(error instanceof GatewayFailpointError)) {
      throw new Error("expected GatewayFailpointError")
    }
    console.log(`observed failpoint error: ${error.name} failpoint=${error.failpoint}`)
    expect(error.failpoint).toBe("afterCreateBeforeCommit")
    expect(await ok(gateway.list())).toEqual([])

    const reopened = await ok(gateway.create(CREATE))
    expect(reopened).toEqual({
      thread: THREAD_1,
      sessionId: SESSION_1,
      created: false,
    })
    expect(await ok(gateway.list())).toHaveLength(1)
  })

  test("afterCreateCommitBeforeSend leaves the created thread visible for recovery", async () => {
    const gateway = new FakeGateway()
    gateway.failNext("afterCreateCommitBeforeSend")

    const error = await capture(() => gateway.create(CREATE))
    expect(error).toBeInstanceOf(GatewayFailpointError)
    expect(await ok(gateway.list())).toHaveLength(1)

    const reopened = await ok(gateway.create(CREATE))
    expect(reopened.created).toBe(false)
    expect(reopened.thread).toBe(THREAD_1)
  })

  test("afterDecideCommit fails before any thread exists, so a retry creates one", async () => {
    const gateway = new FakeGateway()
    gateway.failNext("afterDecideCommit")

    const error = await capture(() => gateway.create(CREATE))
    expect(error).toBeInstanceOf(GatewayFailpointError)
    expect(await ok(gateway.list())).toEqual([])

    const created = await ok(gateway.create(CREATE))
    expect(created).toEqual({ thread: THREAD_1, sessionId: SESSION_1, created: true })
  })

  test("send deduplicates repeated idempotency keys on one thread", async () => {
    const gateway = new FakeGateway()
    const thread = gateway.seedThread()

    const first = await ok(gateway.send({ thread, text: "go", idempotencyKey: "key-1" }))
    const second = await ok(gateway.send({ thread, text: "go", idempotencyKey: "key-1" }))

    expect(first).toEqual({ delivered: true, deduplicated: false })
    expect(second).toEqual({ delivered: false, deduplicated: true })
    expect(gateway.sendCalls).toHaveLength(2)
  })

  test("completion outcome is controllable per thread and returned with the binding", async () => {
    const gateway = new FakeGateway()
    const thread = gateway.seedThread()
    gateway.setCompletionOutcome(thread, { status: "completed", detail: "done" })

    const binding = await ok(gateway.bindCompletion({ thread, events: ["completion"] }))

    expect(binding).toEqual({ bindingId: "binding-1", thread, events: ["completion"] })
    expect(gateway.bindCompletionCalls[0]?.events).toEqual(["completion"])
    expect(gateway.getCompletionOutcome(thread)).toEqual({ status: "completed", detail: "done" })
  })

  test("close marks a thread inactive and removes it from list", async () => {
    const gateway = new FakeGateway()
    const thread = gateway.seedThread()

    const closed = await ok(gateway.close({ thread, graceful: true, waitMs: 30_000 }))

    expect(closed).toEqual({ closed: true, reason: "closed" })
    expect(await ok(gateway.list())).toEqual([])
    expect(gateway.closeCalls[0]?.waitMs).toBe(30_000)
    const read = await gateway.read({ thread })
    expect(read.kind).toBe("error")
  })
})
