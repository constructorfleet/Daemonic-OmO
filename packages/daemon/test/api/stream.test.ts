import { afterEach, describe, expect, test } from "bun:test"
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ulid } from "../../src/core/ids"
import { sessionDocId } from "../../src/observer/doc-factory"
import type { Project, UserId } from "../../src/core/types"
import { SeededRng } from "../support/fakes"
import type { E2eServer } from "../support/e2e-server"
import {
  adminHeaders,
  emit,
  field,
  ids,
  member,
  memberHeaders,
  range,
  server,
  SseReader,
  stopServers,
  type SseFrame,
} from "./harness"

afterEach(stopServers)

const idRng = new SeededRng(7)

function project(target: E2eServer, userId: UserId, name: string): Project {
  const at = new Date(target.app.ctx.clock.now()).toISOString()
  const value: Project = {
    id: ulid(idRng, target.app.ctx.clock.now()),
    userId,
    name,
    cwd: `/work/${name}`,
    agentDir: "/agents/x",
    stateDir: `/state/${name}`,
    settings: { fullAccessOptIn: false, maxRunning: 1, worktreeForAdhoc: false },
    state: "active",
    revision: 1,
    createdAt: at,
    updatedAt: at,
  }
  target.app.ctx.repos.projects.put(value)
  return value
}

function entityId(frame: SseFrame): unknown {
  return field(field(frame.data, "entity"), "id")
}

describe("gap-free SSE stream", () => {
  test("resume with events appended during catch-up delivers every cursor exactly once", async () => {
    const target = await server()
    const alice = await member(target, "alice")
    const bob = await member(target, "bob")
    const aliceHead = target.app.ctx.feed.head({ kind: "user", userId: alice.user.id })
    emit(target, alice.user.id, 1_200)
    const opened = target.app.hub.open({
      user: alice.user,
      scope: { kind: "user", userId: alice.user.id },
      since: aliceHead + 100,
    })
    const reader = new SseReader(opened.stream)

    const hello = await reader.next()
    const firstCatchUpFrame = await reader.next()
    emit(target, alice.user.id, 5)
    emit(target, bob.user.id, 3)
    const backlog = await reader.entitiesThrough(aliceHead + 1_200)
    emit(target, alice.user.id, 1)
    const live = await reader.entitiesThrough(aliceHead + 1_206)

    expect(hello).toMatchObject({
      id: null,
      event: "hello",
      data: { streamId: opened.streamId, headSeq: aliceHead + 1_200 },
    })
    expect(firstCatchUpFrame?.id).toBe(String(aliceHead + 101))
    expect([aliceHead + 101, ...ids(backlog), ...ids(live)]).toEqual(range(aliceHead + 101, aliceHead + 1_206))
    await reader.cancel()
  })

  test("a cursor below the retained window gets reset and the stream closes", async () => {
    const target = await server()
    const alice = await member(target, "alice")
    const aliceHead = target.app.ctx.feed.head({ kind: "user", userId: alice.user.id })
    emit(target, alice.user.id, 5, "2020-01-01T00:00:00.000Z")
    emit(target, alice.user.id, 5)
    target.app.ctx.ledger.prune({
      now: new Date(target.app.ctx.clock.now()).toISOString(),
      eventRetentionDays: 1,
      eventRetentionMinRows: 0,
    })

    const expired = await SseReader.open(target, memberHeaders(target, alice, {
      "last-event-id": String(aliceHead + 2),
    }))
    const expiredFrames = [await expired.next(), await expired.next(), await expired.next()]
    const resumable = await SseReader.open(target, memberHeaders(target, alice), `?since=${aliceHead + 5}`)
    const resumed = await resumable.entitiesThrough(aliceHead + 10)

    expect(expiredFrames).toEqual([
      expect.objectContaining({ event: "hello" }),
      { id: null, event: "reset", data: { reason: "cursor_expired", headSeq: aliceHead + 10 } },
      null,
    ])
    expect(ids(resumed)).toEqual(range(aliceHead + 6, aliceHead + 10))
    await resumable.cancel()
  })

  test("an overflowing subscriber is closed and a reconnect resumes with nothing missing", async () => {
    const target = await server({ config: { limits: { sseSubscriberMaxFrames: 4 } } })
    const alice = await member(target, "alice")
    const aliceHead = target.app.ctx.feed.head({ kind: "user", userId: alice.user.id })
    const scope = { kind: "user", userId: alice.user.id } as const
    const first = new SseReader(target.app.hub.open({ user: alice.user, scope, since: aliceHead }).stream)
    await first.next()
    emit(target, alice.user.id, 2)
    const delivered = await first.take(2)

    emit(target, alice.user.id, 10)
    const afterOverflow = await first.next()
    const lastId = Number(delivered.at(-1)?.id)
    const second = await SseReader.open(target, memberHeaders(target, alice, { "last-event-id": String(lastId) }))
    const resumed = await second.entitiesThrough(aliceHead + 12)

    expect(ids(delivered)).toEqual([aliceHead + 1, aliceHead + 2])
    expect(afterOverflow).toBeNull()
    expect([...ids(delivered), ...ids(resumed)]).toEqual(range(aliceHead + 1, aliceHead + 12))
    console.log(`QA failure: maxFrames=4, 10 unread events -> stream closed after id ${lastId}; `
      + `reconnect Last-Event-ID ${lastId} resumed ids ${ids(resumed).join(",")}`)
    await second.cancel()
  })

  test("doc frames carry no id line and subscriptions belong to the stream's user", async () => {
    const target = await server()
    const alice = await member(target, "alice")
    const bob = await member(target, "bob")
    const aliceHead = target.app.ctx.feed.head({ kind: "user", userId: alice.user.id })
    const sessionDir = join(alice.user.agentDir, "sessions", "--work--")
    const sessionFile = join(sessionDir, "2026-11-25T08-00-00-000Z_sess-stream.jsonl")
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: "sess-stream", cwd: "/work" })}\n`)
    const docId = sessionDocId(alice.user.agentDir, "sess-stream")
    const reader = await SseReader.open(target, memberHeaders(target, alice))
    const streamId = String(field((await reader.next())?.data, "streamId"))
    const docsUrl = `${target.url}/api/v1/stream/${streamId}/docs`

    const subscribed = await fetch(docsUrl, {
      method: "POST",
      headers: memberHeaders(target, alice),
      body: JSON.stringify({ docId, epoch: 3, rev: 41 }),
    })
    const foreign = await fetch(docsUrl, {
      method: "POST",
      headers: memberHeaders(target, bob),
      body: JSON.stringify({ docId }),
    })
    const unknownDoc = await fetch(docsUrl, {
      method: "POST",
      headers: memberHeaders(target, alice),
      body: JSON.stringify({ docId: "session:000000000000:sess-missing" }),
    })
    emit(target, alice.user.id, 1)
    const [doc, entity] = await reader.take(2)
    const removed = await fetch(`${docsUrl}/${encodeURIComponent(docId)}`, { method: "DELETE", headers: memberHeaders(target, alice) })
    appendFileSync(sessionFile, `${JSON.stringify({ type: "message", id: "late", message: { role: "assistant", content: [] } })}\n`)
    target.clock.advance(1_000)
    emit(target, alice.user.id, 1)
    const [afterRemoval] = await reader.take(1)

    expect(subscribed.status).toBe(200)
    expect([foreign.status, unknownDoc.status]).toEqual([404, 404])
    expect(doc).toMatchObject({ id: null, event: "doc", data: { docId, fromRev: 0, toRev: 0, ops: [{ op: "snapshot" }] } })
    expect(entity).toMatchObject({ id: String(aliceHead + 1), event: "entity" })
    expect(removed.status).toBe(204)
    expect(afterRemoval).toMatchObject({ id: String(aliceHead + 2), event: "entity" })
    await reader.cancel()
  })

  test("a list's headSeq followed by stream since=headSeq has no gap", async () => {
    const target = await server()
    const alice = await member(target, "alice")
    const bob = await member(target, "bob")
    const { feed, repos } = target.app.ctx
    const aliceHead = feed.head({ kind: "user", userId: alice.user.id })
    project(target, alice.user.id, "a1")
    project(target, bob.user.id, "b1")
    project(target, alice.user.id, "a2")
    const listed = feed.list({ kind: "user", userId: alice.user.id }, () => ({
      items: repos.projects.listByUser(alice.user.id),
    }))
    const later = [project(target, bob.user.id, "b2"), project(target, alice.user.id, "a3"), project(target, alice.user.id, "a4")]

    const reader = await SseReader.open(target, memberHeaders(target, alice), `?since=${listed.headSeq}`)
    const frames = await reader.entitiesThrough(listed.headSeq + 2)

    expect(listed.items.map((item) => item.name)).toEqual(["a1", "a2"])
    expect(listed.headSeq).toBe(aliceHead + 2)
    expect(ids(frames)).toEqual([aliceHead + 3, aliceHead + 4])
    expect(frames.map(entityId)).toEqual([later[1]?.id, later[2]?.id])
    await reader.cancel()
  })

  test("a member never receives another user's entity frames; an admin stream sees all by global seq", async () => {
    const target = await server()
    const alice = await member(target, "alice")
    const bob = await member(target, "bob")
    const aliceHead = target.app.ctx.feed.head({ kind: "user", userId: alice.user.id })
    const bobHead = target.app.ctx.feed.head({ kind: "user", userId: bob.user.id })
    const globalHead = target.app.ctx.ledger.headSeq()
    const aliceStream = await SseReader.open(target, memberHeaders(target, alice))
    const bobStream = await SseReader.open(target, memberHeaders(target, bob))
    const adminStream = await SseReader.open(target, adminHeaders(target))
    await Promise.all([aliceStream.next(), bobStream.next(), adminStream.next()])

    const a1 = project(target, alice.user.id, "a1")
    const b1 = project(target, bob.user.id, "b1")
    const a2 = project(target, alice.user.id, "a2")
    const b2 = project(target, bob.user.id, "b2")
    const sentinel = project(target, alice.user.id, "a3")
    const aliceFrames = await aliceStream.entitiesThrough(aliceHead + 3)
    const bobFrames = await bobStream.entitiesThrough(bobHead + 2)
    const adminFrames = await adminStream.entitiesThrough(globalHead + 5)

    expect(ids(aliceFrames)).toEqual([aliceHead + 1, aliceHead + 2, aliceHead + 3])
    expect(aliceFrames.map(entityId)).toEqual([a1.id, a2.id, sentinel.id])
    expect(ids(bobFrames)).toEqual([bobHead + 1, bobHead + 2])
    expect(bobFrames.map(entityId)).toEqual([b1.id, b2.id])
    expect(ids(adminFrames)).toEqual(range(globalHead + 1, globalHead + 5))
    expect(adminFrames.map(entityId)).toEqual([a1.id, b1.id, a2.id, b2.id, sentinel.id])
    await Promise.all([aliceStream.cancel(), bobStream.cancel(), adminStream.cancel()])
  })

  test("a heartbeat with the subscriber's headSeq is sent every 15 s of injected clock", async () => {
    const target = await server()
    const alice = await member(target, "alice")
    const aliceHead = target.app.ctx.feed.head({ kind: "user", userId: alice.user.id })
    emit(target, alice.user.id, 2)
    const reader = await SseReader.open(target, memberHeaders(target, alice))
    const hello = await reader.next()

    target.clock.advance(14_999)
    emit(target, alice.user.id, 1)
    const beforeBeat = await reader.next()
    target.clock.advance(1)
    const beat = await reader.next()

    expect(hello).toMatchObject({
      event: "hello",
      data: { headSeq: aliceHead + 2, incarnation: target.app.incarnation },
    })
    expect(beforeBeat).toMatchObject({ id: String(aliceHead + 3), event: "entity" })
    expect(beat).toEqual({ id: null, event: "heartbeat", data: { headSeq: aliceHead + 3 } })
    await reader.cancel()
  })
})
