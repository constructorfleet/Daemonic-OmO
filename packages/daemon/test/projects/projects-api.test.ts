import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseUlid } from "../../src/core/ids"
import type { JsonObject, Run } from "../../src/core/types"
import { isRecord } from "../auth/harness"
import type { E2eServer } from "../support/e2e-server"
import { adminHeaders, member, memberHeaders, server, SseReader, stopServers, type Member } from "../api/harness"

const temporaryRoots: string[] = []

afterEach(async () => {
  await stopServers()
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "omo-daemonic-projects-"))
  temporaryRoots.push(root)
  return root
}

function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("expected a JSON object")
  return value
}

async function errorBody(response: Response): Promise<{ code: string; message: string; details: unknown }> {
  const body: unknown = await response.json()
  const error = record(field(body, "error"))
  if (typeof error.code !== "string" || typeof error.message !== "string") {
    throw new Error("not an error envelope")
  }
  return { code: error.code, message: error.message, details: error.details }
}

function memberCall(
  target: E2eServer,
  who: Member,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return fetch(`${target.url}/api/v1${path}`, {
    method,
    headers: memberHeaders(target, who),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

function adminCall(target: E2eServer, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${target.url}/api/v1${path}`, {
    method,
    headers: adminHeaders(target, { "content-type": "application/json" }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function grantRoots(target: E2eServer, who: Member, roots: readonly string[]): Promise<void> {
  target.app.ctx.repos.users.put({ ...who.user, allowedRoots: roots })
}

async function createProject(
  target: E2eServer,
  who: Member,
  body: unknown,
): Promise<Record<string, unknown>> {
  const response = await memberCall(target, who, "POST", "/projects", body)
  if (response.status !== 201) throw new Error(`project create failed: ${response.status} ${await response.text()}`)
  return record(await response.json())
}

function itemsOf(body: unknown): readonly unknown[] {
  const items = field(body, "items")
  if (!Array.isArray(items)) throw new Error("list body has no items array")
  return items
}

function eventsOf(body: unknown): readonly unknown[] {
  const events = field(body, "events")
  if (!Array.isArray(events)) throw new Error("events body has no events array")
  return events
}

describe("projects api", () => {
  test("creates, lists, reads, patches and deletes a project with a canonical cwd", async () => {
    const root = await tempRoot()
    const target = await server()
    const alice = await member(target, "alice")
    await grantRoots(target, alice, [root])

    const created = await createProject(target, alice, { cwd: root, name: "demo" })
    const canonicalCwd = await realpath(root)

    expect(created.cwd).toBe(canonicalCwd)
    expect(created.name).toBe("demo")
    expect(created.settings).toEqual({ fullAccessOptIn: false, maxRunning: 1, worktreeForAdhoc: false })
    expect(created.state).toBe("active")
    expect(typeof created.stateDir).toBe("string")

    const listed: unknown = await (await memberCall(target, alice, "GET", "/projects")).json()
    expect(itemsOf(listed).map((item) => field(item, "id"))).toEqual([created.id])
    expect(field(listed, "headSeq")).toEqual(expect.any(Number))

    const read: unknown = await (await memberCall(target, alice, "GET", `/projects/${String(created.id)}`)).json()
    expect(read).toEqual(created)

    const patched: unknown = await (await memberCall(target, alice, "PATCH", `/projects/${String(created.id)}`, {
      revision: 1,
      name: "renamed",
    })).json()
    expect(field(patched, "name")).toBe("renamed")
    expect(field(patched, "revision")).toBe(2)

    const deleted = await memberCall(target, alice, "DELETE", `/projects/${String(created.id)}`)
    expect(deleted.status).toBe(204)
    const afterDelete = await memberCall(target, alice, "GET", `/projects/${String(created.id)}`)
    expect(afterDelete.status).toBe(404)
    const empty: unknown = await (await memberCall(target, alice, "GET", "/projects")).json()
    expect(itemsOf(empty)).toEqual([])
  })

  test("settings default from the user's maxRunningPerProject and accept explicit nested values", async () => {
    const root = await tempRoot()
    const target = await server()
    const alice = await member(target, "alice")
    target.app.ctx.repos.users.put({ ...alice.user, allowedRoots: [root], settings: { maxRunningPerProject: 4 } })

    const fromUser = await createProject(target, alice, { cwd: root, name: "from-user" })
    await mkdir(join(root, "explicit"), { recursive: true })
    target.git.addRepo(await realpath(join(root, "explicit")))
    const explicit = await createProject(target, alice, {
      cwd: join(root, "explicit"),
      name: "explicit",
      settings: { maxRunning: 2, fullAccessOptIn: false, worktreeForAdhoc: true },
    })
    const rejected = await memberCall(target, alice, "POST", "/projects", { cwd: root, maxRunning: 3 })

    expect(fromUser.settings).toEqual({ fullAccessOptIn: false, maxRunning: 4, worktreeForAdhoc: false })
    expect(explicit.settings).toEqual({ fullAccessOptIn: false, maxRunning: 2, worktreeForAdhoc: true })
    expect([rejected.status, (await errorBody(rejected)).code]).toEqual([400, "invalid_arguments"])
  })

  test("worktreeForAdhoc needs a git repository on create and patch", async () => {
    const root = await tempRoot()
    const target = await server()
    const alice = await member(target, "alice")
    await grantRoots(target, alice, [root])
    const nonRepo = join(root, "not-a-repo")
    const repo = join(root, "repo")
    await mkdir(nonRepo, { recursive: true })
    await mkdir(repo, { recursive: true })
    target.git.addRepo(await realpath(repo))

    const createRejected = await memberCall(target, alice, "POST", "/projects", {
      cwd: nonRepo,
      settings: { worktreeForAdhoc: true },
    })
    const createBody = await errorBody(createRejected)
    const plain = await createProject(target, alice, { cwd: nonRepo, name: "plain" })
    const patchRejected = await memberCall(target, alice, "PATCH", `/projects/${String(plain.id)}`, {
      revision: 1,
      settings: { worktreeForAdhoc: true },
    })
    const patchBody = await errorBody(patchRejected)
    const plainAfter: unknown = await (await memberCall(target, alice, "GET", `/projects/${String(plain.id)}`)).json()
    const accepted = await createProject(target, alice, {
      cwd: repo,
      name: "repo-project",
      settings: { worktreeForAdhoc: true },
    })
    const listed: unknown = await (await memberCall(target, alice, "GET", "/projects")).json()

    expect([createRejected.status, createBody.code]).toEqual([400, "invalid_arguments"])
    expect(createBody.message).toContain(await realpath(nonRepo))
    expect([patchRejected.status, patchBody.code]).toEqual([400, "invalid_arguments"])
    expect(patchBody.message).toContain(await realpath(nonRepo))
    expect([field(plainAfter, "revision"), field(plainAfter, "settings")])
      .toEqual([1, { fullAccessOptIn: false, maxRunning: 1, worktreeForAdhoc: false }])
    expect(accepted.settings).toEqual({ fullAccessOptIn: false, maxRunning: 1, worktreeForAdhoc: true })
    expect(itemsOf(listed).map((item) => field(item, "name"))).toEqual(["plain", "repo-project"])
  })

  test("rejects an unreadable cwd, a non-directory cwd and any permissionPreset", async () => {
    const root = await tempRoot()
    const target = await server()
    const alice = await member(target, "alice")
    await grantRoots(target, alice, [root])
    const missing = join(root, "does-not-exist")
    const file = join(root, "plain.txt")
    await writeFile(file, "not a directory")

    const missingResponse = await memberCall(target, alice, "POST", "/projects", { cwd: missing })
    const missingBody = await errorBody(missingResponse)
    const fileResponse = await memberCall(target, alice, "POST", "/projects", { cwd: file })
    const fileBody = await errorBody(fileResponse)
    const postPreset = await memberCall(target, alice, "POST", "/projects", {
      cwd: root,
      permissionPreset: "full-access",
    })
    const postPresetBody = await errorBody(postPreset)
    await mkdir(join(root, "valid"), { recursive: true })
    const project = await createProject(target, alice, { cwd: join(root, "valid") })
    const patchPreset = await memberCall(target, alice, "PATCH", `/projects/${String(project.id)}`, {
      revision: 1,
      permissionPreset: "read-only",
    })
    const patchPresetBody = await errorBody(patchPreset)
    const nestedPreset = await memberCall(target, alice, "PATCH", `/projects/${String(project.id)}`, {
      revision: 1,
      settings: { permissionPreset: "read-only" },
    })
    const nestedPresetBody = await errorBody(nestedPreset)

    expect([missingResponse.status, missingBody.code]).toEqual([400, "invalid_arguments"])
    expect(missingBody.message).toContain(missing)
    expect([fileResponse.status, fileBody.code]).toEqual([400, "invalid_arguments"])
    expect([postPreset.status, postPresetBody.code]).toEqual([400, "invalid_arguments"])
    expect(postPresetBody.message).toContain("permissionPreset")
    expect([patchPreset.status, patchPresetBody.code]).toEqual([400, "invalid_arguments"])
    expect([nestedPreset.status, nestedPresetBody.code]).toEqual([400, "invalid_arguments"])
  })

  test("enabling fullAccessOptIn is recorded once in the audit log", async () => {
    const root = await tempRoot()
    const target = await server()
    const alice = await member(target, "alice")
    await grantRoots(target, alice, [root])
    const project = await createProject(target, alice, { cwd: root })
    const path = `/projects/${String(project.id)}`

    const enabled: unknown = await (await memberCall(target, alice, "PATCH", path, {
      revision: 1,
      settings: { fullAccessOptIn: true },
    })).json()
    const repeated: unknown = await (await memberCall(target, alice, "PATCH", path, {
      revision: 2,
      settings: { fullAccessOptIn: true },
    })).json()
    const audit = target.app.ctx.repos.audit.listByUser(alice.user.id, 20)
      .filter((entry) => entry.action === "project.full_access_opt_in")

    expect(field(enabled, "settings")).toEqual({ fullAccessOptIn: true, maxRunning: 1, worktreeForAdhoc: false })
    expect(field(repeated, "revision")).toBe(3)
    expect(audit.map((entry) => entry.detail)).toEqual([{ projectId: String(project.id), enabled: true }])
  })

  test("members outside their allowed roots are forbidden while admins may register and read any project", async () => {
    const root = await tempRoot()
    const target = await server()
    const alice = await member(target, "alice")
    const bob = await member(target, "bob")
    await grantRoots(target, alice, [root])

    const aliceProject = await createProject(target, alice, { cwd: root, name: "alice-project" })
    const denied = await memberCall(target, bob, "POST", "/projects", { cwd: root })
    const adminCreated = await adminCall(target, "POST", "/projects", { cwd: root, name: "admin-project" })
    const bobRead = await memberCall(target, bob, "GET", `/projects/${String(aliceProject.id)}`)
    const adminRead = await adminCall(target, "GET", `/projects/${String(aliceProject.id)}`)
    const bobPatch = await memberCall(target, bob, "PATCH", `/projects/${String(aliceProject.id)}`, {
      revision: 1,
      name: "stolen",
    })
    const adminList: unknown = await (await adminCall(target, "GET", "/projects")).json()

    expect([denied.status, (await errorBody(denied)).code]).toEqual([403, "forbidden"])
    expect([adminCreated.status, field(await adminCreated.json(), "userId")]).not.toEqual([403, alice.user.id])
    expect(adminCreated.status).toBe(201)
    expect([bobRead.status, (await errorBody(bobRead)).code]).toEqual([404, "not_found"])
    expect(adminRead.status).toBe(200)
    expect([bobPatch.status, (await errorBody(bobPatch)).code]).toEqual([404, "not_found"])
    expect(itemsOf(adminList).map((item) => field(item, "name")).sort()).toEqual(["admin-project", "alice-project"])
  })

  test("archive is a 409 while a nonterminal run exists and succeeds once the run is closed", async () => {
    const root = await tempRoot()
    const target = await server()
    const alice = await member(target, "alice")
    await grantRoots(target, alice, [root])
    const project = await createProject(target, alice, { cwd: root })
    const projectId = parseUlid(String(project.id))
    const runId = parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FB2")
    if (projectId === null || runId === null) throw new Error("invalid fixture id")
    const at = new Date(target.app.ctx.clock.now()).toISOString()
    const run: Run = {
      id: runId,
      userId: alice.user.id,
      projectId,
      fireKey: "projects-api-archive",
      attempt: 1,
      name: "run",
      spec: { prompt: "work", timeoutMs: 1_000 },
      cwd: String(project.cwd),
      state: "active",
      outcome: null,
      cancelRequested: false,
      orphanChildren: [],
      createdAt: at,
      updatedAt: at,
      revision: 1,
    }
    target.app.ctx.repos.runs.put(run)
    const path = `/projects/${String(project.id)}/archive`

    const blocked = await memberCall(target, alice, "POST", path)
    const blockedBody = await errorBody(blocked)
    const forced = await memberCall(target, alice, "POST", `${path}?force=true`)
    target.app.ctx.repos.runs.update({ ...run, state: "closed", revision: 2, updatedAt: at }, 1)
    const archived = await memberCall(target, alice, "POST", path)
    const archivedBody: unknown = await archived.json()
    const again = await memberCall(target, alice, "POST", path)

    expect([blocked.status, blockedBody.code]).toEqual([409, "state_conflict"])
    expect(blockedBody.details).toEqual({ nonterminalRuns: 1 })
    expect([forced.status, (await errorBody(forced)).code]).toEqual([400, "invalid_arguments"])
    expect(archived.status).toBe(200)
    expect(field(archivedBody, "state")).toBe("archived")
    expect([again.status, (await errorBody(again)).code]).toEqual([409, "state_conflict"])
  })

  test("include=discovered lists unregistered projects from sessions with hyphenated folders", async () => {
    const root = await tempRoot()
    const target = await server()
    const alice = await member(target, "alice")
    await grantRoots(target, alice, [root])
    const registeredCwd = join(root, "registered-project")
    await mkdir(registeredCwd, { recursive: true })
    const discoveredCwd = join(root, "hyphen-project")
    await mkdir(discoveredCwd, { recursive: true })
    const sessions = join(alice.user.agentDir, "sessions", "2026-01-01T00-00-00-my-session")
    await mkdir(sessions, { recursive: true })
    await writeFile(
      join(sessions, "sess-1.jsonl"),
      `${JSON.stringify({ type: "session", id: "sess-1", cwd: discoveredCwd, version: 1 })}\n`,
    )
    await writeFile(
      join(sessions, "sess-2.jsonl"),
      `${JSON.stringify({ type: "session", id: "sess-2", cwd: registeredCwd, version: 1 })}\n`,
    )
    await createProject(target, alice, { cwd: registeredCwd, name: "registered-project" })

    const listed: unknown = await (await memberCall(target, alice, "GET", "/projects?include=discovered")).json()
    const items = itemsOf(listed)
    const discovered = items.filter((item) => field(item, "registered") === false)
    const allInclude = await adminCall(target, "GET", "/projects?include=discovered")

    expect(items.filter((item) => field(item, "registered") !== false).map((item) => field(item, "name")))
      .toEqual(["registered-project"])
    expect(discovered).toEqual([{
      cwd: await realpath(discoveredCwd),
      name: "hyphen-project",
      stateDir: expect.any(String),
      latestSessionId: "sess-1",
      latestSessionAt: expect.any(Number),
      registered: false,
    }])
    expect([allInclude.status, (await errorBody(allInclude)).code]).toEqual([400, "invalid_arguments"])
  })

  test("an old project event replays with canonical settings on the stream and /events", async () => {
    const target = await server()
    const alice = await member(target, "alice")
    const { feed, ledger } = target.app.ctx
    const scope = { kind: "user", userId: alice.user.id } as const
    const since = feed.head(scope)
    const legacy: JsonObject = {
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
      userId: alice.user.id,
      name: "legacy",
      cwd: "/work/legacy",
      agentDir: alice.user.agentDir,
      stateDir: "/state/legacy",
      maxRunning: 3,
      state: "active",
      revision: 2,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }
    const reader = await SseReader.open(target, memberHeaders(target, alice), `?since=${since}`)
    await reader.next()
    const head = ledger.headSeq()
    ledger.transact((transaction) => transaction.emit({
      at: new Date(target.clock.now()).toISOString(),
      type: "project.upserted",
      entityKind: "project",
      entityId: String(legacy.id),
      userId: alice.user.id,
      projectId: null,
      data: legacy,
    }))
    const frame = await reader.next()
    const events: unknown = await (await memberCall(target, alice, "GET", `/events?since=${since}`)).json()
    await reader.cancel()
    const stored = ledger.readAfter(head, 1)[0]?.data
    const streamed = record(field(frame?.data, "data"))
    const eventItem = record(eventsOf(events)[0])
    const replayed = record(field(eventItem, "data"))

    expect(frame?.event).toBe("entity")
    expect(streamed.settings).toEqual({ fullAccessOptIn: false, maxRunning: 3, worktreeForAdhoc: false })
    expect("maxRunning" in streamed).toBe(false)
    expect(replayed).toEqual(streamed)
    expect(stored).toEqual(legacy)
  })
})
