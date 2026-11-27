import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { isRecord } from "../auth/harness"
import { member, memberHeaders, server, stopServers, type Member } from "../api/harness"
import type { E2eServer } from "../support/e2e-server"
import { parseUlid } from "../../src/core/ids"
import { LOOP_ENGINE } from "../../src/loops/engine"
import { RUNS } from "../../src/runs/engine"
import { SCHEDULER } from "../../src/scheduler/scheduler"

const roots: string[] = []

afterEach(async () => {
  await stopServers()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function json(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json()
  if (!isRecord(body)) throw new Error("expected a JSON object")
  return body
}

function call(target: E2eServer, actor: Member, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${target.url}/api/v1${path}`, {
    method,
    headers: memberHeaders(target, actor),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function createProject(target: E2eServer, actor: Member): Promise<{ readonly id: string; readonly cwd: string }> {
  const root = await mkdtemp(join(tmpdir(), "omo-daemonic-loop-api-"))
  roots.push(root)
  target.app.ctx.repos.users.put({ ...actor.user, allowedRoots: [root] })
  const created = await call(target, actor, "POST", "/projects", { cwd: root })
  if (created.status !== 201) throw new Error(`project create failed: ${created.status} ${await created.text()}`)
  const result = await json(created)
  if (typeof result.id !== "string") throw new Error("project response has no id")
  const cwd = await realpath(root)
  target.git.addRepo(cwd)
  return { id: result.id, cwd }
}

describe("loops API", () => {
  test("a project owner creates, lists, reads and cancels a loop while another member sees not-found", async () => {
    const target = await server()
    const alice = await member(target, "loop-owner")
    const bob = await member(target, "loop-outsider")
    const project = await createProject(target, alice)
    const posted = await call(target, alice, "POST", `/projects/${project.id}/loops`, {
      prompt: "Repair the project",
      doneWhen: [{ kind: "marker" }],
      maxIterations: 3,
    })
    expect(posted.status).toBe(201)
    const loop = await json(posted)
    expect(loop).toMatchObject({ projectId: project.id, userId: alice.user.id, maxIterations: 3 })
    expect(typeof loop.id).toBe("string")
    const id = String(loop.id)

    const listed = await json(await call(target, alice, "GET", `/loops?projectId=${project.id}`))
    expect(Array.isArray(listed.items) ? listed.items.map((item) => (isRecord(item) ? item.id : null)) : null).toEqual([id])
    expect(await json(await call(target, alice, "GET", `/loops/${id}`))).toMatchObject({ id, state: "running" })
    expect((await call(target, bob, "GET", `/loops/${id}`)).status).toBe(404)
    expect((await call(target, bob, "POST", `/loops/${id}/cancel`)).status).toBe(404)

    const cancelled = await json(await call(target, alice, "POST", `/loops/${id}/cancel`))
    expect(cancelled).toMatchObject({ alreadyTerminal: false, loop: { id, state: "cancelled" } })
  })

  test("a project without a git repository cannot create a loop", async () => {
    const target = await server()
    const actor = await member(target, "no-git-loop")
    const root = await mkdtemp(join(tmpdir(), "omo-daemonic-loop-no-git-"))
    roots.push(root)
    target.app.ctx.repos.users.put({ ...actor.user, allowedRoots: [root] })
    const response = await call(target, actor, "POST", "/projects", { cwd: root })
    const project = await json(response)
    const rejected = await call(target, actor, "POST", `/projects/${String(project.id)}/loops`, {
      prompt: "Repair",
      doneWhen: [{ kind: "marker" }],
    })
    expect([rejected.status, await json(rejected)]).toMatchObject([400, { error: { code: "invalid_arguments" } }])
  })

  test("a scheduled loop target creates its iteration Run in the loop worktree", async () => {
    const target = await server()
    const actor = await member(target, "scheduled-loop")
    const project = await createProject(target, actor)
    const scheduleResponse = await call(target, actor, "POST", `/projects/${project.id}/schedules`, {
      name: "loop schedule",
      trigger: { kind: "once", at: new Date(target.app.ctx.clock.now()).toISOString() },
      target: {
        kind: "loop",
        template: { prompt: "Repair the project", doneWhen: [{ kind: "marker" }], maxIterations: 2 },
      },
    })
    expect(scheduleResponse.status).toBe(201)
    const schedule = await json(scheduleResponse)
    const projectId = parseUlid(project.id)
    if (projectId === null) throw new Error("project id is invalid")

    await target.app.ctx.services.require(SCHEDULER).tick(target.app.ctx.clock.now())
    await target.app.ctx.services.require(LOOP_ENGINE).idle()
    await target.app.ctx.services.require(RUNS).idle()
    await target.app.ctx.services.require(LOOP_ENGINE).tick(target.app.ctx.clock.now())
    await target.app.ctx.services.require(LOOP_ENGINE).idle()
    await target.app.ctx.services.require(RUNS).idle()
    await target.app.ctx.services.require(SCHEDULER).tick(target.app.ctx.clock.now())
    await target.app.ctx.services.require(LOOP_ENGINE).idle()
    await target.app.ctx.services.require(RUNS).idle()

    const loop = target.app.ctx.repos.loops.listByProject(projectId)[0]
    if (loop === undefined) throw new Error("scheduled loop was not persisted")
    expect(loop).toMatchObject({ scheduleId: schedule.id, state: "running" })
    const run = target.app.ctx.repos.runs.listByProject(projectId).find((entry) => entry.loopId === loop.id)
    expect(run).toBeDefined()
    expect(run).toMatchObject({
      scheduleId: schedule.id,
      loopId: loop.id,
      worktreePath: join(target.app.ctx.home.home, "worktrees", projectId, loop.id),
    })
  })
})
