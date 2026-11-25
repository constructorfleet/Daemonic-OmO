import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { threadId } from "../../src/core/ids"
import { errorCode } from "../auth/harness"
import type { E2eServer } from "../support/e2e-server"
import { field, member, memberHeaders, server, SseReader, stopServers } from "./harness"

const ENV_KEY = "OMO_DAEMONIC_E2E"
const originalEnv = process.env[ENV_KEY]
const fixtureRoots: string[] = []

afterEach(async () => {
  await stopServers()
  if (originalEnv === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = originalEnv
  for (const root of fixtureRoots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixtureTree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "omo-daemonic-fixtures-"))
  fixtureRoots.push(root)
  await mkdir(join(root, "sessions", "proj"), { recursive: true })
  await writeFile(join(root, "sessions", "proj", "s.jsonl"), "{\"type\":\"session\"}\n")
  return root
}

function control(target: E2eServer, path: string, body: unknown): Promise<Response> {
  return fetch(`${target.url}/__test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("e2e server", () => {
  test("control routes are absent unless OMO_DAEMONIC_E2E=1", async () => {
    delete process.env[ENV_KEY]
    const target = await server()

    const response = await control(target, "/clock/advance", { ms: 1 })

    expect([response.status, await errorCode(response)]).toEqual([404, "not_found"])
  })

  test("control routes drive the FakeClock, FakeGateway and a private copy of the fixture tree", async () => {
    process.env[ENV_KEY] = "1"
    const fixtures = await fixtureTree()
    const target = await server({ fixtures })
    const alice = await member(target, "alice")
    const reader = await SseReader.open(target, memberHeaders(target, alice))
    await reader.next()

    const advanced = await control(target, "/clock/advance", { ms: 15_000 })
    const heartbeat = await reader.next()
    const seeded: unknown = await (await control(target, "/gateway/threads", { name: "odm-1", cwd: "/work" })).json()
    const thread = threadId(String(field(seeded, "thread")))
    const stateSet = await control(target, `/gateway/threads/${thread}/state`, { state: "running" })
    const snapshot = await target.gateway.read({ thread })
    const appended = await control(target, "/fixtures/append", { path: "sessions/proj/s.jsonl", line: "{\"type\":\"message\"}" })
    const escaped = await control(target, "/fixtures/append", { path: "../outside.jsonl", line: "{}" })

    expect(advanced.status).toBe(200)
    expect(heartbeat).toMatchObject({ event: "heartbeat", id: null })
    expect(stateSet.status).toBe(204)
    expect(snapshot).toMatchObject({ kind: "ok", value: { name: "odm-1", state: "running" } })
    expect(appended.status).toBe(204)
    expect(await readFile(join(target.agentDir, "sessions", "proj", "s.jsonl"), "utf8"))
      .toBe("{\"type\":\"session\"}\n{\"type\":\"message\"}\n")
    expect(await readFile(join(fixtures, "sessions", "proj", "s.jsonl"), "utf8")).toBe("{\"type\":\"session\"}\n")
    expect([escaped.status, await errorCode(escaped)]).toEqual([400, "invalid_arguments"])
    await reader.cancel()
  })
})
