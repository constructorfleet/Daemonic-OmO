import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { isRecord } from "../auth/harness"
import { adminHeaders, member, memberHeaders, server, stopServers, type Member } from "../api/harness"
import type { E2eServer } from "../support/e2e-server"

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

async function setup(options: { gitRepo?: boolean } = {}): Promise<{
  target: E2eServer
  alice: Member
  bob: Member
  projectId: string
  cwd: string
}> {
  const root = await mkdtemp(join(tmpdir(), "omo-daemonic-sched-api-"))
  roots.push(root)
  const target = await server()
  const alice = await member(target, "alice")
  const bob = await member(target, "bob")
  target.app.ctx.repos.users.put({ ...alice.user, allowedRoots: [root] })
  const created = await call(target, alice, "POST", "/projects", { cwd: root })
  if (created.status !== 201) throw new Error(`project create failed: ${created.status} ${await created.text()}`)
  const cwd = await realpath(root)
  if (options.gitRepo !== false) target.git.addRepo(cwd)
  return { target, alice, bob, projectId: String((await json(created)).id), cwd }
}

const nightly = {
  name: "nightly",
  trigger: { kind: "cron", expr: "30 2 * * *", tz: "America/Los_Angeles" },
  target: { kind: "run", spec: { prompt: "Run the nightly checks" } },
}

describe("schedules api", () => {
  test("a project whose cwd is not a git repository is rejected before any schedule is written", async () => {
    const { target, alice, projectId, cwd } = await setup({ gitRepo: false })
    const rejected = await call(target, alice, "POST", `/projects/${projectId}/schedules`, nightly)
    const body = await json(rejected)
    const error = isRecord(body.error) ? body.error : {}
    expect([rejected.status, error.code]).toEqual([400, "invalid_arguments"])
    expect(error.details).toEqual({ cwd })
    expect((await json(await call(target, alice, "GET", `/projects/${projectId}/schedules`))).items).toEqual([])
  })

  test("a member creates, lists, reads, patches, pauses, resumes and deletes a schedule; another member gets 404 everywhere", async () => {
    const { target, alice, bob, projectId } = await setup()
    const posted = await call(target, alice, "POST", `/projects/${projectId}/schedules`, nightly)
    expect(posted.status).toBe(201)
    const schedule = await json(posted)
    expect(schedule).toMatchObject({
      projectId, userId: alice.user.id, state: "active", overlap: "skip", misfire: "fire_once", misfireGraceMs: 3_600_000,
      queueMax: 1, maxCatchup: 50, fireCount: 0, revision: 1, target: { kind: "run", spec: { prompt: "Run the nightly checks", timeoutMs: 7_200_000 } },
    })
    expect(typeof schedule.nextFireAt).toBe("number")
    const id = String(schedule.id)

    const listed = await json(await call(target, alice, "GET", `/projects/${projectId}/schedules`))
    expect(Array.isArray(listed.items) ? listed.items.map((item) => (isRecord(item) ? item.id : null)) : null).toEqual([id])
    expect(typeof listed.headSeq).toBe("number")
    expect(await json(await call(target, alice, "GET", `/schedules/${id}`))).toMatchObject({ id, name: "nightly" })

    for (const [method, path] of [
      ["GET", `/schedules/${id}`], ["PATCH", `/schedules/${id}`], ["DELETE", `/schedules/${id}`], ["POST", `/schedules/${id}/pause`],
      ["POST", `/schedules/${id}/resume`], ["POST", `/schedules/${id}/fire`], ["GET", `/schedules/${id}/preview`],
      ["GET", `/projects/${projectId}/schedules`], ["POST", `/projects/${projectId}/schedules`],
    ] as const) {
      const body = method === "GET" || method === "DELETE" ? undefined : method === "PATCH" ? { revision: 1, name: "x" } : nightly
      expect([method, path, (await call(target, bob, method, path, body)).status]).toEqual([method, path, 404])
    }

    const patched = await call(target, alice, "PATCH", `/schedules/${id}`, { revision: 1, name: "renamed" })
    expect(await json(patched)).toMatchObject({ name: "renamed", revision: 2 })
    const stale = await call(target, alice, "PATCH", `/schedules/${id}`, { revision: 1, name: "again" })
    expect([stale.status, await errorCode(stale)]).toEqual([409, "revision_conflict"])

    expect(await json(await call(target, alice, "POST", `/schedules/${id}/pause`))).toMatchObject({ state: "paused" })
    const pausedAgain = await call(target, alice, "POST", `/schedules/${id}/pause`)
    expect([pausedAgain.status, await errorCode(pausedAgain)]).toEqual([409, "state_conflict"])
    expect(await json(await call(target, alice, "POST", `/schedules/${id}/resume`))).toMatchObject({ state: "active" })

    expect((await call(target, alice, "DELETE", `/schedules/${id}`)).status).toBe(204)
    expect((await call(target, alice, "GET", `/schedules/${id}`)).status).toBe(404)
    expect((await json(await call(target, alice, "GET", `/projects/${projectId}/schedules`))).items).toEqual([])
  })

  test("fire decides one run for the schedule now, and preview lists the next slots with local time and offset", async () => {
    const { target, alice, projectId } = await setup()
    const schedule = await json(await call(target, alice, "POST", `/projects/${projectId}/schedules`, nightly))
    const fired = await call(target, alice, "POST", `/schedules/${String(schedule.id)}/fire`)
    expect(fired.status).toBe(201)
    expect(await json(fired)).toMatchObject({ kind: "decided", run: { scheduleId: schedule.id, projectId, spec: { prompt: "Run the nightly checks" } } })
    expect(await json(await call(target, alice, "GET", `/schedules/${String(schedule.id)}`))).toMatchObject({ fireCount: 1 })

    const preview = await json(await call(target, alice, "GET", `/schedules/${String(schedule.id)}/preview?count=3`))
    const items = Array.isArray(preview.items) ? preview.items.filter(isRecord) : []
    expect(items).toHaveLength(3)
    expect(items.every((item) => typeof item.at === "string" && typeof item.local === "string" && /^[+-]\d\d:\d\d$/.test(String(item.offset)))).toBe(true)
    expect(items.every((item) => String(item.local).endsWith("02:30:00") || item.dstNote === "gap_shifted")).toBe(true)
    expect((await call(target, alice, "GET", `/schedules/${String(schedule.id)}/preview?count=0`)).status).toBe(400)
    expect((await call(target, alice, "GET", `/schedules/${String(schedule.id)}/preview?count=1001`)).status).toBe(400)
  })

  test("the preview API shows the Los Angeles spring gap as gap_shifted", async () => {
    const root = await mkdtemp(join(tmpdir(), "omo-daemonic-sched-preview-"))
    roots.push(root)
    const target = await server()
    target.git.addRepo(await realpath(root))
    target.clock.jumpWall(Date.parse("2027-03-13T00:00:00Z") - target.clock.now())
    const headers = adminHeaders(target, { "content-type": "application/json" })
    const projectResponse = await fetch(`${target.url}/api/v1/projects`, {
      method: "POST",
      headers,
      body: JSON.stringify({ cwd: root }),
    })
    expect(projectResponse.status).toBe(201)
    const project = await json(projectResponse)
    const projectId = String(project.id)
    const scheduleResponse = await fetch(`${target.url}/api/v1/projects/${projectId}/schedules`, {
      method: "POST",
      headers,
      body: JSON.stringify(nightly),
    })
    expect(scheduleResponse.status).toBe(201)
    const created = await json(scheduleResponse)
    const previewResponse = await fetch(`${target.url}/api/v1/schedules/${String(created.id)}/preview?count=3`, { headers })
    expect(previewResponse.status).toBe(200)
    const preview = await json(previewResponse)
    const items = Array.isArray(preview.items) ? preview.items : []
    expect(items).toEqual([
      { at: "2027-03-13T10:30:00.000Z", local: "2027-03-13T02:30:00", offset: "-08:00" },
      { at: "2027-03-14T10:00:00.000Z", local: "2027-03-14T03:00:00", offset: "-07:00", dstNote: "gap_shifted" },
      { at: "2027-03-15T09:30:00.000Z", local: "2027-03-15T02:30:00", offset: "-07:00" },
    ])
  })

  test("structural errors are 400; an unknown time zone is stored as errored; loop targets need the loop engine", async () => {
    const { target, alice, projectId } = await setup()
    const post = (body: unknown) => call(target, alice, "POST", `/projects/${projectId}/schedules`, body)
    expect((await post({ ...nightly, trigger: { kind: "interval", everyMs: 59_999 } })).status).toBe(400)
    expect((await post({ ...nightly, trigger: { kind: "once", at: "tomorrow" } })).status).toBe(400)
    expect((await post({ ...nightly, color: "blue" })).status).toBe(400)
    expect((await post({ ...nightly, overlap: "sometimes" })).status).toBe(400)
    expect((await post({ ...nightly, target: { kind: "run", spec: { prompt: "x", permissionPreset: "workspace" } } })).status).toBe(400)
    expect((await post({ ...nightly, target: { kind: "run", spec: { prompt: "x", worktree: false } } })).status).toBe(400)
    const loop = await post({ ...nightly, target: { kind: "loop", template: {} } })
    expect([loop.status, await errorCode(loop)]).toEqual([400, "invalid_arguments"])

    const errored = await post({ ...nightly, trigger: { kind: "cron", expr: "30 2 * * *", tz: "Mars/Base" } })
    expect(errored.status).toBe(201)
    expect(await json(errored)).toMatchObject({ state: "errored", nextFireAt: null })

    const interval = await json(await post({ ...nightly, trigger: { kind: "interval", everyMs: 60_000 } }))
    expect(interval).toMatchObject({ state: "active", trigger: { kind: "interval", everyMs: 60_000 } })
  })
})
