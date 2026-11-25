import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { isRecord } from "../auth/harness"
import { parseUlid } from "../../src/core/ids"
import { RUNS } from "../../src/runs/engine"
import type { E2eServer } from "../support/e2e-server"
import { member, memberHeaders, server, stopServers, type Member } from "../api/harness"

const roots: string[] = []

afterEach(async () => {
  await stopServers()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

type Body = Record<string, unknown>

function call(target: E2eServer, who: Member, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${target.url}/api/v1${path}`, {
    method,
    headers: memberHeaders(target, who),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function json(response: Response): Promise<Body> {
  const body: unknown = await response.json()
  if (!isRecord(body)) throw new Error("expected a JSON object")
  return body
}

async function errorCode(response: Response): Promise<unknown> {
  const body = await json(response)
  return isRecord(body.error) ? body.error.code : undefined
}

async function setup(): Promise<{ target: E2eServer; alice: Member; bob: Member; projectId: string }> {
  const root = await mkdtemp(join(tmpdir(), "omo-daemonic-runs-api-"))
  roots.push(root)
  const target = await server()
  const alice = await member(target, "alice")
  const bob = await member(target, "bob")
  target.app.ctx.repos.users.put({ ...alice.user, allowedRoots: [root] })
  const created = await call(target, alice, "POST", "/projects", { cwd: root })
  if (created.status !== 201) throw new Error(`project create failed: ${created.status} ${await created.text()}`)
  return { target, alice, bob, projectId: String((await json(created)).id) }
}

const idle = (target: E2eServer): Promise<void> => target.app.ctx.services.require(RUNS).idle()

describe("runs api", () => {
  test("a member spawns a run in their project and reads it back; another member gets 404 for every route", async () => {
    const { target, alice, bob, projectId } = await setup()
    const posted = await call(target, alice, "POST", `/projects/${projectId}/runs`, { prompt: "Reply with exactly OK", model: "zai/glm-5.3-flash" })
    expect(posted.status).toBe(201)
    const run = await json(posted)
    expect(run).toMatchObject({ projectId, userId: alice.user.id, permissionMode: "agent-dir-default", spec: { prompt: "Reply with exactly OK", model: "zai/glm-5.3-flash", timeoutMs: 7_200_000 } })
    await idle(target)

    const read = await json(await call(target, alice, "GET", `/runs/${String(run.id)}`))
    expect(read).toMatchObject({ state: "active", threadId: "thread-1" })
    const listed = await json(await call(target, alice, "GET", `/runs?projectId=${projectId}`))
    expect(Array.isArray(listed.items) ? listed.items.map((item) => (isRecord(item) ? item.id : null)) : null).toEqual([run.id])
    expect(typeof listed.headSeq).toBe("number")

    expect((await call(target, bob, "GET", `/runs/${String(run.id)}`)).status).toBe(404)
    expect((await call(target, bob, "POST", `/runs/${String(run.id)}/cancel`, {})).status).toBe(404)
    expect((await call(target, bob, "POST", `/projects/${projectId}/runs`, { prompt: "x" })).status).toBe(404)
    expect((await json(await call(target, bob, "GET", "/runs"))).items).toEqual([])
  })

  test("a degraded gateway answers 503 gateway_degraded and records no run", async () => {
    const { target, alice, projectId } = await setup()
    target.gateway.setSdkLoad("fail")
    const posted = await call(target, alice, "POST", `/projects/${projectId}/runs`, { prompt: "hi" })
    expect(posted.status).toBe(503)
    expect(await errorCode(posted)).toBe("gateway_degraded")
    const id = parseUlid(projectId)
    if (id === null) throw new Error("project id is not a ULID")
    expect(target.app.ctx.repos.runs.listByProject(id)).toEqual([])
  })

  test("prompts are required and capped at 1 MiB", async () => {
    const { target, alice, projectId } = await setup()
    expect((await call(target, alice, "POST", `/projects/${projectId}/runs`, {})).status).toBe(400)
    expect((await call(target, alice, "POST", `/projects/${projectId}/runs`, { prompt: "x".repeat(1_048_577) })).status).toBe(400)
    expect((await call(target, alice, "POST", `/projects/${projectId}/runs`, { prompt: "x", permissionPreset: "workspace" })).status).toBe(400)
  })

  test("cancel and retry write audit rows on the owner's log only", async () => {
    const { target, alice, bob, projectId } = await setup()
    const run = await json(await call(target, alice, "POST", `/projects/${projectId}/runs`, { prompt: "work" }))
    await idle(target)
    const cancelled = await json(await call(target, alice, "POST", `/runs/${String(run.id)}/cancel`, {}))
    expect(cancelled).toMatchObject({ uninterruptible: false, run: { state: "closed", outcome: { kind: "cancelled" } } })

    const retried = await call(target, alice, "POST", `/runs/${String(run.id)}/retry`, {})
    expect(retried.status).toBe(201)
    expect(await json(retried)).toMatchObject({ fireKey: run.fireKey, attempt: 2 })

    const audit = await json(await call(target, alice, "GET", "/audit"))
    const rows = Array.isArray(audit.items) ? audit.items.filter(isRecord) : []
    expect(rows.map((row) => String(row.action)).sort()).toEqual(["run.cancel", "run.spawn", "run.spawn"])
    expect(rows.every((row) => isRecord(row.detail) && row.detail.permissionMode === "agent-dir-default")).toBe(true)
    expect((await json(await call(target, bob, "GET", "/audit"))).items).toEqual([])
  })

  test("the kill switch holds the caller's spawns until release and members cannot target another user", async () => {
    const { target, alice, bob, projectId } = await setup()
    const run = await json(await call(target, alice, "POST", `/projects/${projectId}/runs`, { prompt: "work" }))
    await idle(target)

    expect((await call(target, bob, "POST", "/kill-switch", { userId: alice.user.id })).status).toBe(403)
    const engaged = await json(await call(target, alice, "POST", "/kill-switch", {}))
    expect(engaged).toMatchObject({ users: [alice.user.id], cancelled: [run.id], uninterruptible: [] })
    const held = await call(target, alice, "POST", `/projects/${projectId}/runs`, { prompt: "again" })
    expect([held.status, await errorCode(held)]).toEqual([409, "state_conflict"])

    expect(await json(await call(target, alice, "POST", "/kill-switch/release", {}))).toEqual({ released: [alice.user.id] })
    expect((await call(target, alice, "POST", `/projects/${projectId}/runs`, { prompt: "again" })).status).toBe(201)
  })

  test("archive with force=true cancels the project's unfinished runs, then archives it", async () => {
    const { target, alice, projectId } = await setup()
    const run = await json(await call(target, alice, "POST", `/projects/${projectId}/runs`, { prompt: "work" }))
    await idle(target)
    const archived = await call(target, alice, "POST", `/projects/${projectId}/archive?force=true`)
    expect(archived.status).toBe(200)
    expect((await json(archived)).state).toBe("archived")
    expect(await json(await call(target, alice, "GET", `/runs/${String(run.id)}`))).toMatchObject({ state: "closed", outcome: { kind: "cancelled" } })
  })
})
