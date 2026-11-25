import type { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { openDb } from "../../src/db/db"
import { migrate } from "../../src/db/migrations"
import { EventLedger } from "../../src/db/ledger"
import { createRepositories } from "../../src/db/repos"
import { parseUlid } from "../../src/core/ids"
import type { DaemonEvent, User, UserId } from "../../src/core/types"

const temporaryRoots: string[] = []
const databases: Database[] = []

function id(value: string): UserId {
  const parsed = parseUlid(value)
  if (parsed === null) throw new RangeError(`invalid test id: ${value}`)
  return parsed
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close()
  for (const path of temporaryRoots.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
})

function testDb(path = ":memory:"): Database {
  const db = openDb(path)
  databases.push(db)
  return db
}

function closeTestDb(db: Database): void {
  db.close()
  databases.splice(databases.indexOf(db), 1)
}

function tempDatabasePath(): string {
  const root = mkdtempSync(join(tmpdir(), "omo-daemonic-db-"))
  temporaryRoots.push(root)
  return join(root, "daemon.sqlite")
}

function user(id: UserId): User {
  return {
    id,
    oidcIssuer: "https://issuer.example",
    oidcSub: id,
    email: `${id}@example.test`,
    name: id,
    role: "member",
    agentDir: `/tmp/${id}`,
    allowedRoots: [],
    settings: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastLoginAt: null,
  }
}

function event(userId: UserId, type = "daemon.tested", at = "2026-01-01T00:00:00.000Z") {
  return {
    at,
    type,
    entityKind: "daemon",
    entityId: "daemon",
    userId,
    projectId: null,
    data: {},
  } satisfies Omit<DaemonEvent, "seq" | "userSeq">
}

describe("daemon database", () => {
  test("applies migrations idempotently when reopening a WAL database", () => {
    const path = tempDatabasePath()
    const first = testDb(path)
    migrate(first)
    closeTestDb(first)

    const reopened = testDb(path)
    migrate(reopened)

    expect(reopened.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" })
    expect(reopened.query("PRAGMA synchronous").get()).toEqual({ synchronous: 2 })
    expect(reopened.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 })
    const tableNames = reopened.query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all().map(({ name }) => name)
    expect(tableNames.filter((name) => /task|dag/i.test(name))).toEqual([])
  })

  test("assigns contiguous global and per-user sequences across mixed commits", () => {
    const db = testDb()
    migrate(db)
    const ledger = new EventLedger(db)
    const repositories = createRepositories(db, ledger)
    const delivered: number[] = []
    ledger.subscribe((record) => {
      delivered.push(ledger.readAfter(record.seq - 1, 1)[0]?.seq ?? -1)
    })
    const users = [
      user(id("01ARZ3NDEKTSV4RRFFQ69G5FAV")),
      user(id("01ARZ3NDEKTSV4RRFFQ69G5FAW")),
      user(id("01ARZ3NDEKTSV4RRFFQ69G5FAX")),
    ]
    for (const value of users) repositories.users.put(value)

    for (let index = 0; index < 1_000; index += 1) {
      const value = users[index % users.length]
      if (value === undefined) throw new Error("user fixture missing")
      ledger.transact((transaction) => {
        transaction.emit(event(value.id, `test.${index}`))
      })
    }

    const events = ledger.readAfter(0, 1_100)
    expect(events.map(({ seq }) => seq)).toEqual(
      Array.from({ length: 1_003 }, (_, index) => index + 1),
    )
    for (const [userIndex, value] of users.entries()) {
      expect(events.filter((row) => row.userId === value.id).map(({ userSeq }) => userSeq))
        .toEqual(Array.from({ length: 335 }, (_, index) => index + 1)
          .slice(0, userIndex === 0 ? 335 : 334))
    }
    expect(delivered).toEqual(Array.from({ length: 1_003 }, (_, index) => index + 1))
    console.log("QA happy: seq 1..1003 contiguous; per-user user_seq 1..335/334/334")
  })

  test("rolls back writes and emits no broadcasts when a transaction throws", () => {
    const db = testDb()
    migrate(db)
    const ledger = new EventLedger(db)
    const value = user(id("01ARZ3NDEKTSV4RRFFQ69G5FAV"))
    createRepositories(db).users.put(value)
    const broadcasts: DaemonEvent[] = []
    ledger.subscribe((record) => broadcasts.push(record))
    const head = ledger.headSeq()

    expect(() => ledger.transact((transaction) => {
      transaction.execute("INSERT INTO audit(id, at, user_id, action, entity_kind, entity_id, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?)", [
        "audit-a", "2026-01-01T00:00:00.000Z", value.id, "test", "daemon", "one", "{}",
      ])
      transaction.emit(event(value.id, "daemon.first"))
      transaction.execute("INSERT INTO audit(id, at, user_id, action, entity_kind, entity_id, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?)", [
        "audit-b", "2026-01-01T00:00:00.000Z", value.id, "test", "daemon", "two", "{}",
      ])
      transaction.emit(event(value.id, "daemon.second"))
      throw new Error("force rollback")
    })).toThrow("force rollback")

    expect(db.query("SELECT COUNT(*) AS count FROM audit").get()).toEqual({ count: 0 })
    expect(ledger.readAfter(head, 10)).toEqual([])
    expect(broadcasts).toEqual([])
    console.log("QA failure: throw after two inserts left rows=0 broadcasts=0")
  })

  test("rejects a stale project revision without changing the stored project", () => {
    const db = testDb()
    migrate(db)
    const repositories = createRepositories(db)
    repositories.users.put(user(id("01ARZ3NDEKTSV4RRFFQ69G5FAV")))
    const original = {
      id: id("01ARZ3NDEKTSV4RRFFQ69G5FAZ"),
      userId: id("01ARZ3NDEKTSV4RRFFQ69G5FAV"),
      name: "project",
      cwd: "/tmp/project",
      agentDir: "/tmp/agent",
      stateDir: "/tmp/state",
      maxRunning: 1,
      state: "active",
      revision: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } as const
    repositories.projects.put(original)
    repositories.projects.update({ ...original, name: "updated", revision: 2 }, 1)

    expect(() => repositories.projects.update({ ...original, name: "stale", revision: 2 }, 1))
      .toThrow("revision_conflict")
    expect(repositories.projects.get(original.id)?.name).toBe("updated")
  })

  test("prunes only events outside both the retention window and minimum row count", () => {
    const db = testDb()
    migrate(db)
    const repositories = createRepositories(db)
    const userId = id("01ARZ3NDEKTSV4RRFFQ69G5FAV")
    repositories.users.put(user(userId))
    const ledger = new EventLedger(db)
    const dates = [
      "2026-01-01T00:00:00.000Z",
      "2026-02-01T00:00:00.000Z",
      "2026-03-01T00:00:00.000Z",
      "2026-04-01T00:00:00.000Z",
    ]
    for (const at of dates) {
      ledger.transact((transaction) => transaction.emit(event(userId, `event.${at}`, at)))
    }

    expect(ledger.prune({
      now: "2026-04-02T00:00:00.000Z",
      eventRetentionDays: 30,
      eventRetentionMinRows: 2,
    })).toBe(3)
    expect(ledger.readAfter(0, 10).map(({ type }) => type)).toEqual([
      "event.2026-03-01T00:00:00.000Z",
      "event.2026-04-01T00:00:00.000Z",
    ])
    ledger.transact((transaction) => transaction.emit(event(userId, "event.after-prune", "2026-04-02T00:00:00.000Z")))
    expect(ledger.readAfter(0, 10).at(-1)).toMatchObject({ seq: 6, userSeq: 6 })
  })

  test("replays idempotency records and rejects changed request hashes", () => {
    const db = testDb()
    migrate(db)
    const repositories = createRepositories(db)
    const owner = id("01ARZ3NDEKTSV4RRFFQ69G5FAV")
    repositories.users.put(user(owner))
    repositories.idempotency.put({
      userId: owner,
      key: "request-a",
      requestHash: "hash-a",
      response: "{\"ok\":true}",
      expiresAt: 100,
    })

    expect(repositories.idempotency.get(owner, "request-a")).toEqual({
      key: "request-a",
      requestHash: "hash-a",
      response: "{\"ok\":true}",
      expiresAt: 100,
    })
    repositories.idempotency.put({
      userId: owner,
      key: "request-a",
      requestHash: "hash-a",
      response: "{\"ok\":false}",
      expiresAt: 200,
    })
    expect(repositories.idempotency.get(owner, "request-a")?.response).toBe("{\"ok\":true}")
    expect(() => repositories.idempotency.put({
      userId: owner,
      key: "request-a",
      requestHash: "hash-b",
      response: "{}",
      expiresAt: 100,
    }))
      .toThrow("idempotency_conflict")
  })
})
