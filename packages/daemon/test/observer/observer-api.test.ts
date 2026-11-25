import { afterEach, describe, expect, test } from "bun:test"
import { cpSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { formatTurnBody, parseSessionTurns, resolveTaskStateDir } from "@omo-daemonic/store"
import { sessionDocId } from "../../src/observer/doc-factory"
import type { E2eServer } from "../support/e2e-server"
import { field, member, memberHeaders, server, SseReader, stopServers, type Member } from "../api/harness"
import { appendJson, assistant, cleanTemps, FIXTURES, ROOT_SESSION_REL, seedProject, tempDir, text } from "./support"

afterEach(async () => {
  await stopServers()
  cleanTemps()
})

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="

interface Setup {
  readonly target: E2eServer
  readonly alice: Member
  readonly bob: Member
  readonly sessionDoc: string
  readonly projectId: string
  readonly rootSession: string
}

async function setup(config: Record<string, unknown> = {}): Promise<Setup> {
  const target = await server({ config })
  const alice = await member(target, "alice")
  const bob = await member(target, "bob")
  cpSync(join(FIXTURES, "agent"), alice.user.agentDir, { recursive: true })
  const cwd = join(tempDir("api-project"), "project")
  mkdirSync(cwd)
  cpSync(join(FIXTURES, "store"), resolveTaskStateDir(cwd, { agentDir: alice.user.agentDir }), { recursive: true })
  const project = seedProject(target.app.ctx.repos, alice.user, cwd)
  return {
    target,
    alice,
    bob,
    sessionDoc: sessionDocId(alice.user.agentDir, "sess-basic"),
    projectId: project.id,
    rootSession: join(alice.user.agentDir, ROOT_SESSION_REL),
  }
}

async function get(target: E2eServer, who: Member, path: string): Promise<Response> {
  return fetch(`${target.url}${path}`, { headers: memberHeaders(target, who) })
}

function docPath(docId: string, suffix = ""): string {
  return `/api/v1/docs/${encodeURIComponent(docId)}${suffix}`
}

async function body(response: Response): Promise<unknown> {
  return response.json()
}

describe("observer document routes", () => {
  test("a session document is served to its owner and is a 404 for another user", async () => {
    const { target, alice, bob, sessionDoc } = await setup()

    const own = await get(target, alice, docPath(sessionDoc))
    const foreign = await get(target, bob, docPath(sessionDoc))

    expect(own.status).toBe(200)
    expect(field(field(await body(own), "snapshot"), "turns")).toHaveLength(4)
    expect(foreign.status).toBe(404)
  })

  test("a turn body is the range-read turn formatted like the viewer's expansion", async () => {
    const { target, alice, sessionDoc, rootSession } = await setup()
    const expected = parseSessionTurns(text(rootSession)).find((turn) => turn.id === "a2")

    const response = await get(target, alice, docPath(sessionDoc, "/turns/a2"))

    expect(field(await body(response), "lines")).toEqual(expected === undefined ? null : formatTurnBody(expected))
  })

  test("older turns page backwards from a turn", async () => {
    const { target, alice, sessionDoc } = await setup()

    const response = await get(target, alice, docPath(sessionDoc, "?beforeTurn=a4&limit=2"))
    const page = await body(response)

    const turns = field(page, "turns")
    expect(Array.isArray(turns) ? turns.map((turn) => field(turn, "id")) : turns).toEqual(["a2", expect.stringMatching(/^off:/)])
    expect(field(page, "hasOlder")).toBe(true)
  })

  test("an image is served only through a document of its owner that carries it", async () => {
    const { target, alice, bob, sessionDoc, projectId } = await setup()
    const snapshot = field(await body(await get(target, alice, docPath(sessionDoc))), "snapshot")
    const turns = field(snapshot, "turns")
    const sha = JSON.stringify(turns).match(/"sha256":"([0-9a-f]{64})"/)?.[1] ?? ""

    const own = await get(target, alice, docPath(sessionDoc, `/images/${sha}`))
    const foreign = await get(target, bob, docPath(sessionDoc, `/images/${sha}`))
    const otherDoc = await get(target, alice, docPath(`task:${projectId}:task-multi`, `/images/${sha}`))

    expect(own.status).toBe(200)
    expect(own.headers.get("content-type")).toBe("image/png")
    expect(Buffer.from(await own.arrayBuffer()).toString("base64")).toBe(PNG)
    expect([foreign.status, otherDoc.status]).toEqual([404, 404])
  })

  test("project, dag and schedule documents resolve for their owner only", async () => {
    const { target, alice, bob, projectId } = await setup()
    const ids = [`project:${projectId}:tasks`, `dag:${projectId}:dag_fixture`, `schedules:${alice.user.id}`]

    const own = await Promise.all(ids.map(async (docId) => (await get(target, alice, docPath(docId))).status))
    const foreign = await Promise.all(ids.map(async (docId) => (await get(target, bob, docPath(docId))).status))

    expect(own).toEqual([200, 200, 200])
    expect(foreign).toEqual([404, 404, 404])
  })

  test("an idle document is evicted after five minutes and reopens in a new epoch", async () => {
    const { target, alice, sessionDoc } = await setup()
    const epochOf = async (): Promise<unknown> => field(await body(await get(target, alice, docPath(sessionDoc))), "epoch")
    const first = await epochOf()
    target.clock.advance(60_000)
    const touched = await epochOf()

    target.clock.advance(5 * 60_000)
    const reopened = await epochOf()

    expect(touched).toBe(first)
    expect(reopened).not.toBe(first)
  })

  test("observerMaxOpenDocs from config evicts an idle document past the cap", async () => {
    const { target, alice, sessionDoc } = await setup({ limits: { observerMaxOpenDocs: 1 } })
    const schedules = `schedules:${alice.user.id}`
    const epochOf = async (docId: string): Promise<unknown> =>
      field(await body(await get(target, alice, docPath(docId))), "epoch")
    const first = await epochOf(sessionDoc)
    await epochOf(schedules)

    const reopened = await epochOf(sessionDoc)

    expect(reopened).not.toBe(first)
  })

  test("observerPageMaxTurns from config caps the page limit", async () => {
    const { target, alice, sessionDoc } = await setup({ limits: { observerPageMaxTurns: 2 } })

    const accepted = await get(target, alice, docPath(sessionDoc, "?beforeTurn=a4&limit=2"))
    const rejected = await get(target, alice, docPath(sessionDoc, "?beforeTurn=a4&limit=3"))

    expect(accepted.status).toBe(200)
    expect(rejected.status).toBe(400)
    expect(await rejected.text()).toContain("between 1 and 2")
  })
})

describe("observer document streams", () => {
  test("a subscribed session doc streams a snapshot then appended turns on the 1 s poll", async () => {
    const { target, alice, bob, sessionDoc, rootSession } = await setup()
    const reader = await SseReader.open(target, memberHeaders(target, alice))
    const streamId = String(field((await reader.next())?.data, "streamId"))
    const subscribe = (who: Member) => fetch(`${target.url}/api/v1/stream/${streamId}/docs`, {
      method: "POST",
      headers: memberHeaders(target, who),
      body: JSON.stringify({ docId: sessionDoc }),
    })

    const subscribed = await subscribe(alice)
    const foreign = await subscribe(bob)
    const snapshot = await reader.next()
    appendJson(rootSession, assistant("a5", [{ type: "text", text: "streamed" }]))
    target.clock.advance(1_000)
    const delta = await reader.next()

    expect([subscribed.status, foreign.status]).toEqual([200, 404])
    expect(snapshot).toMatchObject({ id: null, event: "doc", data: { docId: sessionDoc, fromRev: 0, toRev: 0, ops: [{ op: "snapshot" }] } })
    expect(delta).toMatchObject({
      id: null,
      event: "doc",
      data: { docId: sessionDoc, fromRev: 0, toRev: 1, ops: [{ op: "turn.add", turn: { id: "a5", lines: ["assistant: streamed"] } }] },
    })
    await reader.cancel()
  })
})
