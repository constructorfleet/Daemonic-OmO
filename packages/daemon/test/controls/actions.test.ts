import { afterEach, describe, expect, test } from "bun:test"
import { member, memberHeaders, server, stopServers } from "../api/harness"

afterEach(stopServers)

describe("thread action routes", () => {
  test("rejects actions missing from the gateway controls list", async () => {
    const cases = [
      { action: "interrupt", control: "interrupt", gatewayMethod: "interrupt", body: {} },
      { action: "close", control: "close", gatewayMethod: "close", body: { graceful: true, wait_ms: 0 } },
      { action: "model", control: "set_model", gatewayMethod: "setModel", body: { model: "provider/model" } },
    ] as const

    for (const scenario of cases) {
      const target = await server()
      const alice = await member(target, `alice-${scenario.action}`)
      const thread = target.gateway.seedThread({ name: "read-only", cwd: "/work/alpha" })
      target.gateway.setThreadControls(thread, [])

      const response = await fetch(`${target.url}/api/v1/threads/${thread}/${scenario.action}`, {
        method: "POST",
        headers: memberHeaders(target, alice),
        body: JSON.stringify(scenario.body),
      })
      const body: unknown = await response.json()
      const actionCall = target.gateway.calls.find((entry) => entry.method === scenario.gatewayMethod)

      expect(response.status).toBe(409)
      expect(body).toMatchObject({
        error: { code: "state_conflict", details: { missingControl: scenario.control } },
      })
      expect(actionCall).toBeUndefined()
    }
  })

  test("interrupt reaches a thread in another cwd with all-scope enabled", async () => {
    const target = await server()
    const alice = await member(target, "alice")
    const thread = target.gateway.seedThread({ name: "other-cwd", cwd: "/outside/project" })

    const response = await fetch(`${target.url}/api/v1/threads/${thread}/interrupt`, {
      method: "POST",
      headers: memberHeaders(target, alice),
    })
    const body: unknown = await response.json()
    const call = target.gateway.calls.find((entry) => entry.method === "interrupt")

    expect(response.status).toBe(200)
    expect(body).toEqual({ interrupted: true })
    expect(call).toMatchObject({ method: "interrupt", args: { thread, allScope: true } })
  })

  test("labels offline delivery and its 24-hour expiry for the next start", async () => {
    const target = await server()
    const alice = await member(target, "alice")
    const thread = target.gateway.seedThread({ name: "offline", cwd: "/work/alpha" })
    target.gateway.setThreadControls(thread, ["send"])
    const nativeSend = target.gateway.send.bind(target.gateway)
    target.gateway.send = async (input) => {
      const result = await nativeSend(input)
      return result.kind === "error"
        ? result
        : { ...result, value: { ...result.value, delivered: false } }
    }

    const response = await fetch(`${target.url}/api/v1/threads/${thread}/send`, {
      method: "POST",
      headers: memberHeaders(target, alice, { "idempotency-key": "offline-send-1" }),
      body: JSON.stringify({ text: "later", mode: "auto" }),
    })
    const body: unknown = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({
      thread,
      delivery: "queued_offline",
      queuedForNextStart: true,
      expiresAt: new Date(target.clock.now() + 86_400_000).toISOString(),
      deduplicated: false,
    })
  })

  test("rejects text over the gateway's one-mebibyte send limit", async () => {
    const target = await server()
    const alice = await member(target, "alice")
    const thread = target.gateway.seedThread({ name: "large-message", cwd: "/work/alpha" })
    target.gateway.setThreadControls(thread, ["send"])

    const response = await fetch(`${target.url}/api/v1/threads/${thread}/send`, {
      method: "POST",
      headers: memberHeaders(target, alice, { "idempotency-key": "large-send-1" }),
      body: JSON.stringify({ text: "x".repeat(1_048_577), mode: "auto" }),
    })
    const body: unknown = await response.json()

    expect(response.status).toBe(400)
    expect(body).toMatchObject({ error: { code: "invalid_arguments" } })
    expect(target.gateway.sendCalls).toHaveLength(0)
  })

  test("applies the configured send byte cap", async () => {
    const target = await server({ config: { limits: { threadMessageMaxBytes: 4 } } })
    const alice = await member(target, "alice")
    const thread = target.gateway.seedThread({ name: "custom-cap", cwd: "/work/alpha" })
    target.gateway.setThreadControls(thread, ["send"])

    const over = await fetch(`${target.url}/api/v1/threads/${thread}/send`, {
      method: "POST",
      headers: memberHeaders(target, alice, { "idempotency-key": "cap-over" }),
      body: JSON.stringify({ text: "abcde", mode: "auto" }),
    })
    const overBody: unknown = await over.json()

    expect(over.status).toBe(400)
    expect(overBody).toMatchObject({ error: { code: "invalid_arguments" } })
    expect(target.gateway.sendCalls).toHaveLength(0)

    const atCap = await fetch(`${target.url}/api/v1/threads/${thread}/send`, {
      method: "POST",
      headers: memberHeaders(target, alice, { "idempotency-key": "cap-at" }),
      body: JSON.stringify({ text: "abcd", mode: "auto" }),
    })

    expect(atCap.status).toBe(200)
    expect(await atCap.json()).toMatchObject({ delivery: "sent" })
    expect(target.gateway.sendCalls.map((call) => call.text)).toEqual(["abcd"])
  })

  test("applies the configured queued-offline expiry", async () => {
    const target = await server({ config: { limits: { threadQueueTtlMs: 60_000 } } })
    const alice = await member(target, "alice")
    const thread = target.gateway.seedThread({ name: "custom-ttl", cwd: "/work/alpha" })
    target.gateway.setThreadControls(thread, ["send"])
    const nativeSend = target.gateway.send.bind(target.gateway)
    target.gateway.send = async (input) => {
      const result = await nativeSend(input)
      return result.kind === "error"
        ? result
        : { ...result, value: { ...result.value, delivered: false } }
    }

    const response = await fetch(`${target.url}/api/v1/threads/${thread}/send`, {
      method: "POST",
      headers: memberHeaders(target, alice, { "idempotency-key": "ttl-send-1" }),
      body: JSON.stringify({ text: "later", mode: "auto" }),
    })
    const body: unknown = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      delivery: "queued_offline",
      expiresAt: new Date(target.clock.now() + 60_000).toISOString(),
    })
  })

  test("steers only a running thread", async () => {
    const target = await server()
    const alice = await member(target, "alice")
    const thread = target.gateway.seedThread({ name: "running", cwd: "/work/alpha" })
    target.gateway.setThreadControls(thread, ["send"])
    target.gateway.setThreadState(thread, "running")

    const response = await fetch(`${target.url}/api/v1/threads/${thread}/send`, {
      method: "POST",
      headers: memberHeaders(target, alice, { "idempotency-key": "steer-1" }),
      body: JSON.stringify({ text: "steer current turn", mode: "steer" }),
    })
    const body: unknown = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ delivery: "sent" })
    expect(target.gateway.sendCalls).toEqual([{
      thread,
      text: "steer current turn",
      idempotencyKey: "steer-1",
    }])
  })

  test("closes and changes model only when each gateway control is present", async () => {
    const target = await server()
    const alice = await member(target, "alice")
    const thread = target.gateway.seedThread({ name: "controllable", cwd: "/work/alpha" })
    target.gateway.setThreadControls(thread, ["close", "set_model"])

    const model = await fetch(`${target.url}/api/v1/threads/${thread}/model`, {
      method: "POST",
      headers: memberHeaders(target, alice),
      body: JSON.stringify({ model: "provider/model", provider: "provider" }),
    })
    const closed = await fetch(`${target.url}/api/v1/threads/${thread}/close`, {
      method: "POST",
      headers: memberHeaders(target, alice, { "idempotency-key": "close-1" }),
      body: JSON.stringify({ graceful: true, wait_ms: 1_000 }),
    })
    const modelCall = target.gateway.calls.find((entry) => entry.method === "setModel")

    expect(model.status).toBe(200)
    expect(closed.status).toBe(200)
    expect(await closed.json()).toEqual({ closed: true, reason: "closed" })
    expect(modelCall).toMatchObject({
      method: "setModel",
      args: { thread, model: "provider/model", provider: "provider" },
    })
    expect(target.gateway.closeCalls).toEqual([{ thread, graceful: true, waitMs: 1_000, idempotencyKey: "close-1" }])
    expect(target.app.ctx.repos.audit.listByUser(alice.user.id, 10).map((entry) => entry.action).sort())
      .toEqual(["thread.close", "thread.model"])
  })
})
