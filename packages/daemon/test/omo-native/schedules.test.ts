import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { member, memberHeaders, server } from "../api/harness"
import { cleanOmoNative, omoStub, scheduleRecord, writeJson } from "./support"

afterEach(cleanOmoNative)

describe("omo schedule routes", () => {
  test("listing is per member and links schedule sessions", async () => {
    const target = await server()
    const alice = await member(target, "schedule-alice")
    const bob = await member(target, "schedule-bob")
    for (const [owner, id] of [[alice, "sch_aliceabc1234"], [bob, "sch_bobabcd12345"]] as const) {
      await writeJson(join(owner.user.agentDir, "schedule", "pending", `${id}.json`), {
        ...scheduleRecord(id, `prompt for ${id}`), sessionId: `session-${id}`, cwd: target.home,
        everyMs: 60_000, fireCount: 3, lastFiredAt: 1,
      })
    }

    const response = await fetch(`${target.url}/api/v1/omo/schedules`, { headers: memberHeaders(target, alice) })
    const body: unknown = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      schedules: [{
        id: "sch_aliceabc1234", state: "pending", dueAt: 2, everyMs: 60_000, fireCount: 3,
        promptPreview: "prompt for sch_aliceabc1234", sessionLink: expect.stringContaining("session:"),
      }],
      runners: { live: 0, total: 0 },
      willFire: false,
    })
    expect(JSON.stringify(body)).not.toContain("sch_bobabcd12345")
  })

  test("liveness reflects a live runner record", async () => {
    const target = await server()
    const alice = await member(target, "runner-alice")
    const startedAt = Bun.spawnSync(["ps", "-p", String(process.pid), "-o", "lstart="])
    const processStartedAtMs = Date.parse(startedAt.stdout.toString().trim())
    await writeJson(join(alice.user.agentDir, "schedule", "runners", `${process.pid}.json`), {
      pid: process.pid, processStartedAtMs, beatAt: target.clock.now(), watch: true,
    })

    const response = await fetch(`${target.url}/api/v1/omo/schedules`, { headers: memberHeaders(target, alice) })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ runners: { live: 1, total: 1 }, willFire: true })
  })

  test("cancellation invokes omo in the member agent dir", async () => {
    const bin = await omoStub()
    const target = await server({ config: { omo: { bin } } })
    const alice = await member(target, "cancel-alice")
    await mkdir(alice.user.agentDir, { recursive: true })
    await writeJson(join(alice.user.agentDir, "schedule", "pending", "sch_abcdefgh1234.json"), scheduleRecord("sch_abcdefgh1234"))

    const response = await fetch(`${target.url}/api/v1/omo/schedules/sch_abcdefgh1234/cancel`, {
      method: "POST", headers: memberHeaders(target, alice), body: "{}",
    })

    expect(response.status).toBe(200)
    expect(await readFile(join(alice.user.agentDir, "cancel-agent-dir"), "utf8")).toBe(alice.user.agentDir)
  })

  test("cancellation returns 404 for another member's schedule", async () => {
    const bin = await omoStub()
    const target = await server({ config: { omo: { bin } } })
    const alice = await member(target, "cancel-owner")
    const bob = await member(target, "cancel-other")
    await writeJson(join(bob.user.agentDir, "schedule", "pending", "sch_abcdefgh1234.json"), scheduleRecord("sch_abcdefgh1234"))

    const response = await fetch(`${target.url}/api/v1/omo/schedules/sch_abcdefgh1234/cancel`, {
      method: "POST", headers: memberHeaders(target, alice), body: "{}",
    })

    expect(response.status).toBe(404)
  })

  test("cancellation passes the configured command timeout to the clock deadline", async () => {
    const bin = await omoStub()
    const target = await server({ config: { omo: { bin }, limits: { omoCommandTimeoutMs: 45_000 } } })
    const alice = await member(target, "cancel-timeout")
    await mkdir(alice.user.agentDir, { recursive: true })
    await writeJson(join(alice.user.agentDir, "schedule", "pending", "sch_abcdefgh1234.json"), scheduleRecord("sch_abcdefgh1234"))
    const deadlines: number[] = []
    const original = target.clock.setTimer
    target.clock.setTimer = (at, fn) => {
      deadlines.push(at)
      return original.call(target.clock, at, fn)
    }
    let response: Response
    try {
      response = await fetch(`${target.url}/api/v1/omo/schedules/sch_abcdefgh1234/cancel`, {
        method: "POST", headers: memberHeaders(target, alice), body: "{}",
      })
    } finally {
      Reflect.deleteProperty(target.clock, "setTimer")
    }

    expect(response.status).toBe(200)
    expect(deadlines).toContain(target.clock.now() + 45_000)
  })

  test("failed cancellation trims stderr to the configured tail length", async () => {
    const bin = await omoStub()
    const target = await server({ config: { omo: { bin }, limits: { omoCommandStderrTailChars: 10 } } })
    const alice = await member(target, "cancel-tail")
    await mkdir(alice.user.agentDir, { recursive: true })
    await writeJson(join(alice.user.agentDir, "schedule", "pending", "sch_abcdefgh1234.json"), scheduleRecord("sch_abcdefgh1234"))
    await writeFile(join(alice.user.agentDir, "fail-cancel"), "")

    const response = await fetch(`${target.url}/api/v1/omo/schedules/sch_abcdefgh1234/cancel`, {
      method: "POST", headers: memberHeaders(target, alice), body: "{}",
    })

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({
      error: { details: { stderrTail: "ey expired", manualCommand: "omo schedule cancel sch_abcdefgh1234" } },
    })
  })

  test("failed cancellation maps stderr and the manual command to 503", async () => {
    const bin = await omoStub()
    const target = await server({ config: { omo: { bin } } })
    const alice = await member(target, "cancel-failure")
    await mkdir(alice.user.agentDir, { recursive: true })
    await writeJson(join(alice.user.agentDir, "schedule", "pending", "sch_abcdefgh1234.json"), scheduleRecord("sch_abcdefgh1234"))
    await writeFile(join(alice.user.agentDir, "fail-cancel"), "")

    const response = await fetch(`${target.url}/api/v1/omo/schedules/sch_abcdefgh1234/cancel`, {
      method: "POST", headers: memberHeaders(target, alice), body: "{}",
    })

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({
      error: { details: {
        stderrTail: expect.stringContaining("internal_key_unavailable"),
        manualCommand: "omo schedule cancel sch_abcdefgh1234",
      } },
    })
  })
})
