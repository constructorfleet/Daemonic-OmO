import { afterEach, describe, expect, test } from "bun:test"
import { sessionId, threadId, ulid } from "../../src/core/ids"
import type { Project, Run } from "../../src/core/types"
import { member, memberHeaders, server, stopServers } from "../api/harness"

afterEach(stopServers)

interface LinkRunInput {
  readonly target: Awaited<ReturnType<typeof server>>
  readonly owner: Awaited<ReturnType<typeof member>>
  readonly thread: string
  readonly cwd: string
}

function linkRun({ target, owner, thread, cwd }: LinkRunInput): Run {
  const { clock, rng, repos } = target.app.ctx
  const at = new Date(clock.now()).toISOString()
  const project: Project = {
    id: ulid(rng, clock.now()),
    userId: owner.user.id,
    name: "controls-project",
    cwd,
    agentDir: owner.user.agentDir,
    stateDir: `${cwd}/.omo/senpi-task`,
    settings: { fullAccessOptIn: false, maxRunning: 1, worktreeForAdhoc: false },
    state: "active",
    revision: 1,
    createdAt: at,
    updatedAt: at,
  }
  repos.projects.put(project)
  const run: Run = {
    id: ulid(rng, clock.now()),
    userId: owner.user.id,
    projectId: project.id,
    fireKey: "adhoc:controls-test",
    attempt: 1,
    name: "controls-test",
    spec: { prompt: "initial prompt", timeoutMs: 7_200_000 },
    cwd,
    threadId: threadId(thread),
    sessionId: sessionId(thread),
    state: "active",
    outcome: null,
    cancelRequested: false,
    orphanChildren: [],
    createdAt: at,
    updatedAt: at,
    revision: 1,
  }
  repos.runs.put(run)
  return run
}

describe("interactive thread controls", () => {
  test("lists only gateway threads matching the requested state", async () => {
    const target = await server()
    const alice = await member(target, "alice")
    const idle = target.gateway.seedThread({ name: "idle-thread", cwd: "/work/alpha" })
    const running = target.gateway.seedThread({ name: "running-thread", cwd: "/work/beta" })
    target.gateway.setThreadControls(idle, ["send", "interrupt"])
    target.gateway.setThreadState(running, "running")

    const response = await fetch(`${target.url}/api/v1/threads?state=idle`, {
      headers: memberHeaders(target, alice),
    })
    const body: unknown = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      items: [{
        thread: idle,
        name: "idle-thread",
        cwd: "/work/alpha",
        state: "idle",
        controls: ["send", "interrupt"],
      }],
      headSeq: expect.any(Number),
    })
  })

  test("merges run linkage and hides a foreign user's linked thread", async () => {
    const target = await server()
    const alice = await member(target, "alice")
    const bob = await member(target, "bob")
    const thread = target.gateway.seedThread({ name: "linked-run", cwd: "/work/alice" })
    const run = linkRun({ target, owner: alice, thread, cwd: "/work/alice" })

    const aliceResponse = await fetch(
      `${target.url}/api/v1/threads?projectId=${run.projectId}`,
      { headers: memberHeaders(target, alice) },
    )
    const aliceBody: unknown = await aliceResponse.json()
    const bobResponse = await fetch(`${target.url}/api/v1/threads`, {
      headers: memberHeaders(target, bob),
    })
    const bobBody: unknown = await bobResponse.json()

    expect(aliceResponse.status).toBe(200)
    expect(aliceBody).toMatchObject({
      items: [{ thread, runId: run.id, projectId: run.projectId }],
    })
    expect(bobResponse.status).toBe(200)
    expect(bobBody).toMatchObject({ items: [] })
  })

  test("refuses a send when the gateway row lacks the send control", async () => {
    const target = await server()
    const alice = await member(target, "alice")
    const thread = target.gateway.seedThread({ name: "read-only", cwd: "/work/alpha" })
    target.gateway.setThreadControls(thread, ["read"])

    const response = await fetch(`${target.url}/api/v1/threads/${thread}/send`, {
      method: "POST",
      headers: memberHeaders(target, alice, { "idempotency-key": "send-control-1" }),
      body: JSON.stringify({ text: "continue", mode: "auto" }),
    })
    const body: unknown = await response.json()

    expect(response.status).toBe(409)
    expect(body).toMatchObject({
      error: {
        code: "state_conflict",
        details: { missingControl: "send" },
      },
    })
    expect(target.gateway.sendCalls).toHaveLength(0)
  })

  test("hides another user's daemon thread before checking its controls", async () => {
    const target = await server()
    const alice = await member(target, "alice")
    const bob = await member(target, "bob")
    const thread = target.gateway.seedThread({ name: "alice-run", cwd: "/work/alice" })
    linkRun({ target, owner: alice, thread, cwd: "/work/alice" })
    target.gateway.setThreadControls(thread, ["send"])

    const response = await fetch(`${target.url}/api/v1/threads/${thread}/send`, {
      method: "POST",
      headers: memberHeaders(target, bob, { "idempotency-key": "bob-send-1" }),
      body: JSON.stringify({ text: "private", mode: "auto" }),
    })
    const body: unknown = await response.json()

    expect(response.status).toBe(404)
    expect(body).toMatchObject({ error: { code: "not_found" } })
    expect(target.gateway.sendCalls).toHaveLength(0)
    expect(target.gateway.createCalls).toHaveLength(0)
  })

  test("forwards the request key and audits a successful follow-up only once", async () => {
    const target = await server()
    const alice = await member(target, "alice")
    const thread = target.gateway.seedThread({ name: "follow-up", cwd: "/work/alpha" })
    target.gateway.setThreadControls(thread, ["send"])
    const request = () => fetch(`${target.url}/api/v1/threads/${thread}/send`, {
      method: "POST",
      headers: memberHeaders(target, alice, { "idempotency-key": "follow-up-1" }),
      body: JSON.stringify({ text: "continue", mode: "follow_up" }),
    })

    const first = await request()
    const replay = await request()
    const body: unknown = await first.json()
    const audit = target.app.ctx.repos.audit.listByUser(alice.user.id, 10)

    expect([first.status, replay.status]).toEqual([200, 200])
    expect(body).toMatchObject({ delivery: "sent", queuedForNextStart: false })
    expect(target.gateway.sendCalls).toHaveLength(1)
    expect(target.gateway.sendCalls[0]).toMatchObject({
      thread,
      text: "continue",
      mode: "follow_up",
      idempotencyKey: "follow-up-1",
    })
    expect(audit.filter((entry) => entry.action === "thread.send")).toHaveLength(1)
  })

  test("reopens an idle daemon run and releases its unattended hold with the requested text", async () => {
    const target = await server()
    const alice = await member(target, "alice")
    const created = await target.gateway.create({
      name: "controls-test",
      cwd: "/work/alpha",
      idempotencyKey: "adhoc:controls-test:1",
    })
    if (created.kind === "error") throw new Error(created.message)
    const thread = created.value.thread
    const run = linkRun({ target, owner: alice, thread, cwd: "/work/alpha" })
    target.gateway.setThreadControls(thread, ["send"])
    target.gateway.setSessionHeld(thread, true)
    const request = () => fetch(`${target.url}/api/v1/threads/${thread}/send`, {
      method: "POST",
      headers: memberHeaders(target, alice, { "idempotency-key": "held-send-1" }),
      body: JSON.stringify({ text: "resume with this", mode: "auto" }),
    })
    const response = await request()
    const replay = await request()
    const body: unknown = await response.json()
    const replayBody: unknown = await replay.json()

    expect(response.status).toBe(200)
    expect(replay.status).toBe(200)
    expect(body).toMatchObject({ delivery: "released", queuedForNextStart: false })
    expect(replayBody).toEqual(body)
    expect(target.gateway.createCalls.at(-1)?.idempotencyKey).toBe(`${run.fireKey}:${run.attempt}`)
    expect(target.gateway.releaseHoldCalls).toEqual([{ thread, text: "resume with this" }])
    expect(target.gateway.sendCalls).toHaveLength(0)
  })

  test("reopens a non-held daemon run before sending the follow-up", async () => {
    const target = await server()
    const alice = await member(target, "alice")
    const created = await target.gateway.create({
      name: "controls-test",
      cwd: "/work/alpha",
      idempotencyKey: "adhoc:controls-test:1",
    })
    if (created.kind === "error") throw new Error(created.message)
    const thread = created.value.thread
    const run = linkRun({ target, owner: alice, thread, cwd: "/work/alpha" })
    target.gateway.setThreadControls(thread, ["send"])
    const response = await fetch(`${target.url}/api/v1/threads/${thread}/send`, {
      method: "POST",
      headers: memberHeaders(target, alice, { "idempotency-key": "run-send-1" }),
      body: JSON.stringify({ text: "next turn", mode: "follow_up" }),
    })
    const body: unknown = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ delivery: "sent" })
    expect(target.gateway.createCalls.at(-1)?.idempotencyKey).toBe(`${run.fireKey}:${run.attempt}`)
    expect(target.gateway.sendCalls.at(-1)).toMatchObject({
      thread,
      text: "next turn",
      mode: "follow_up",
      idempotencyKey: "run-send-1",
    })
    expect(target.gateway.calls.slice(-3).map((call) => call.method))
      .toEqual(["create", "sessionState", "send"])
  })
})
