import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ApiError } from "../../src/api/errors"
import { json, userRoute } from "../../src/api/routes"
import { parseUlid, ulid } from "../../src/core/ids"
import type { Project } from "../../src/core/types"
import { errorCode } from "../auth/harness"
import { SeededRng } from "../support/fakes"
import type { E2eServer } from "../support/e2e-server"
import { adminHeaders, emit, field, member, memberHeaders, server, stopServers, type Member } from "./harness"

afterEach(stopServers)

const PROJECTS = "/api/v1/test/projects"

interface ProjectRoutes {
  readonly executions: () => number
}

function mountProjectRoutes(target: E2eServer): ProjectRoutes {
  const { ctx } = target.app
  const rng = new SeededRng(3)
  let executions = 0
  ctx.addRoute(userRoute(ctx, {
    method: "POST",
    path: PROJECTS,
    handle: ({ principal, body }) => {
      executions += 1
      const name = field(body, "name")
      if (typeof name !== "string") throw new ApiError("invalid_arguments", "name is required")
      const at = new Date(ctx.clock.now()).toISOString()
      const project: Project = {
        id: ulid(rng, ctx.clock.now()),
        userId: principal.user.id,
        name,
        cwd: `/work/${name}`,
        agentDir: principal.user.agentDir,
        stateDir: `/state/${name}`,
        settings: { fullAccessOptIn: false, maxRunning: 1, worktreeForAdhoc: false },
        state: "active",
        revision: 1,
        createdAt: at,
        updatedAt: at,
      }
      ctx.repos.projects.put(project)
      return json(project, 201)
    },
  }))
  ctx.addRoute(userRoute(ctx, {
    method: "PATCH",
    path: `${PROJECTS}/:id`,
    handle: ({ params, body }) => {
      const id = parseUlid(params.id ?? "")
      const current = id === null ? null : ctx.repos.projects.get(id)
      const revision = field(body, "revision")
      const name = field(body, "name")
      if (current === null) throw new ApiError("not_found", "project not found")
      if (typeof revision !== "number" || typeof name !== "string") {
        throw new ApiError("invalid_arguments", "name and revision are required")
      }
      const next = { ...current, name, revision: revision + 1 }
      ctx.repos.projects.update(next, revision)
      return json(next)
    },
  }))
  return { executions: () => executions }
}

function post(target: E2eServer, who: Member, body: unknown, key: string): Promise<Response> {
  return fetch(`${target.url}${PROJECTS}`, {
    method: "POST",
    headers: memberHeaders(target, who, { "idempotency-key": key }),
    body: JSON.stringify(body),
  })
}

describe("http api", () => {
  test("an Idempotency-Key replays the first response and a changed body is 422", async () => {
    const target = await server()
    const routes = mountProjectRoutes(target)
    const alice = await member(target, "alice")
    const bob = await member(target, "bob")

    const first = await post(target, alice, { name: "demo" }, "key-1")
    const firstBody = await first.text()
    const replay = await post(target, alice, { name: "demo" }, "key-1")
    const changed = await post(target, alice, { name: "other" }, "key-1")
    const otherUser = await post(target, bob, { name: "demo" }, "key-1")
    const concurrent = await Promise.all([
      post(target, alice, { name: "racy" }, "key-2"),
      post(target, alice, { name: "racy" }, "key-2"),
    ])
    const concurrentBodies = await Promise.all(concurrent.map((response) => response.text()))

    expect(first.status).toBe(201)
    expect([replay.status, await replay.text(), replay.headers.get("idempotent-replayed")])
      .toEqual([201, firstBody, "true"])
    expect([changed.status, await errorCode(changed)]).toEqual([422, "idempotency_conflict"])
    expect(otherUser.status).toBe(201)
    expect(concurrent.map((response) => response.status)).toEqual([201, 201])
    expect(concurrentBodies[0]).toBe(concurrentBodies[1] ?? "")
    expect(routes.executions()).toBe(3)
    expect(target.app.ctx.repos.projects.listByUser(alice.user.id).map((project) => project.name))
      .toEqual(["demo", "racy"])
  })

  test("a stale revision is a 409 revision_conflict envelope and the row is unchanged", async () => {
    const target = await server()
    mountProjectRoutes(target)
    const alice = await member(target, "alice")
    const created: unknown = await (await post(target, alice, { name: "demo" }, "create")).json()
    const url = `${target.url}${PROJECTS}/${String(field(created, "id"))}`
    const patch = (body: unknown): Promise<Response> =>
      fetch(url, { method: "PATCH", headers: memberHeaders(target, alice), body: JSON.stringify(body) })

    const fresh = await patch({ name: "renamed", revision: 1 })
    const stale = await patch({ name: "stale", revision: 1 })
    const staleBody: unknown = await stale.json()

    expect(fresh.status).toBe(200)
    expect(stale.status).toBe(409)
    expect(staleBody).toEqual({
      error: {
        code: "revision_conflict",
        message: expect.any(String),
        details: { entityId: field(created, "id"), expectedRevision: 1 },
      },
    })
    expect(target.app.ctx.repos.projects.listByUser(alice.user.id).map((project) => project.name)).toEqual(["renamed"])
  })

  test("errors use the {error:{code,message}} envelope with the documented statuses", async () => {
    const target = await server()
    mountProjectRoutes(target)
    const alice = await member(target, "alice")

    const unknownRoute = await fetch(`${target.url}/api/v1/nope`, { headers: adminHeaders(target) })
    const anonymousStream = await fetch(`${target.url}/api/v1/stream`)
    const badCursor = await fetch(`${target.url}/api/v1/stream?since=abc`, { headers: memberHeaders(target, alice) })
    const badBody = await fetch(`${target.url}${PROJECTS}`, {
      method: "POST",
      headers: memberHeaders(target, alice),
      body: "{not json",
    })
    const missingName = await post(target, alice, {}, "no-name")

    expect([unknownRoute.status, await errorCode(unknownRoute)]).toEqual([404, "not_found"])
    expect([anonymousStream.status, await errorCode(anonymousStream)]).toEqual([401, "unauthenticated"])
    expect([badCursor.status, await errorCode(badCursor)]).toEqual([400, "invalid_arguments"])
    expect([badBody.status, await errorCode(badBody)]).toEqual([400, "invalid_arguments"])
    expect([missingName.status, await errorCode(missingName)]).toEqual([400, "invalid_arguments"])
  })

  test("health reports version, this start's incarnation, the caller's headSeq and the stored omo report", async () => {
    const target = await server()
    const alice = await member(target, "alice")
    const aliceHead = target.app.ctx.feed.head({ kind: "user", userId: alice.user.id })
    emit(target, alice.user.id, 3)
    const headSeq = target.app.ctx.ledger.headSeq()
    const before: unknown = await (await fetch(`${target.url}/api/v1/health`, { headers: adminHeaders(target) })).json()
    target.app.ctx.db.query("INSERT INTO meta(key, value) VALUES ('omo.compat', ?)")
      .run(JSON.stringify({ omoVersion: "5.1.79", checks: [] }))

    const asMember: unknown = await (await fetch(`${target.url}/api/v1/health`, { headers: memberHeaders(target, alice) })).json()

    expect(before).toEqual({ version: "0.0.0", incarnation: target.app.incarnation, headSeq, omo: null })
    expect(asMember).toEqual({
      version: "0.0.0",
      incarnation: target.app.incarnation,
      headSeq: aliceHead + 3,
      omo: { omoVersion: "5.1.79", checks: [] },
    })
  })

  test("events page by the caller's cursor and refuse an expired cursor", async () => {
    const target = await server()
    const alice = await member(target, "alice")
    const bob = await member(target, "bob")
    const aliceHead = target.app.ctx.feed.head({ kind: "user", userId: alice.user.id })
    const globalHead = target.app.ctx.ledger.headSeq()
    emit(target, bob.user.id, 2)
    emit(target, alice.user.id, 3)
    const page = (query: string, headers: Record<string, string>): Promise<Response> =>
      fetch(`${target.url}/api/v1/events${query}`, { headers })

    const first: unknown = await (await page(`?since=${aliceHead}&limit=2`, memberHeaders(target, alice))).json()
    const admin: unknown = await (await page(`?since=${globalHead}`, adminHeaders(target))).json()
    target.app.ctx.db.query("DELETE FROM events WHERE seq <= ?").run(globalHead + 3)
    const expired = await page(`?since=${aliceHead}`, memberHeaders(target, alice))

    expect(first).toMatchObject({ nextSince: aliceHead + 2, headSeq: aliceHead + 3, hasMore: true })
    const events = field(first, "events")
    expect(Array.isArray(events) ? events.map((event) => field(event, "seq")) : events)
      .toEqual([aliceHead + 1, aliceHead + 2])
    expect(admin).toMatchObject({ nextSince: globalHead + 5, headSeq: globalHead + 5, hasMore: false })
    expect([expired.status, await errorCode(expired)]).toEqual([409, "state_conflict"])
  })

  test("non-api GETs serve the web build with an SPA fallback that cannot escape the build dir", async () => {
    const dist = await mkdtemp(join(tmpdir(), "omo-daemonic-dist-"))
    try {
      await writeFile(join(dist, "index.html"), "<!doctype html><title>omo-daemonic</title>")
      await writeFile(join(dist, "app.js"), "console.log('app')")
      const target = await server({ staticDir: dist })
      const get = async (path: string): Promise<string> => (await fetch(`${target.url}${path}`)).text()

      const results = [await get("/"), await get("/app.js"), await get("/projects/abc"), await get("/..%2f..%2fconfig.jsonc")]
      const apiMiss = await fetch(`${target.url}/api/v1/unknown`)

      expect(results).toEqual([
        "<!doctype html><title>omo-daemonic</title>",
        "console.log('app')",
        "<!doctype html><title>omo-daemonic</title>",
        "<!doctype html><title>omo-daemonic</title>",
      ])
      expect([apiMiss.status, await errorCode(apiMiss)]).toEqual([404, "not_found"])
    } finally {
      await rm(dist, { recursive: true, force: true })
    }
  })
})
