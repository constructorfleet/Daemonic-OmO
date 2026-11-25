import type { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { createEventFeed } from "../../src/api/feed"
import { parseUlid } from "../../src/core/ids"
import type { DaemonEvent, JsonObject, JsonValue, Project, User, UserId } from "../../src/core/types"
import { openDb } from "../../src/db/db"
import { EventLedger } from "../../src/db/ledger"
import { migrate } from "../../src/db/migrations"
import { createRepositories } from "../../src/db/repos"

const AT = "2026-01-01T00:00:00.000Z"
const databases: Database[] = []

afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

function fixtureId(value: string): UserId {
  const parsed = parseUlid(value)
  if (parsed === null) throw new Error(`invalid fixture id ${value}`)
  return parsed
}

const owner = fixtureId("01ARZ3NDEKTSV4RRFFQ69G5FAV")
const projectId = fixtureId("01ARZ3NDEKTSV4RRFFQ69G5FAZ")

function member(): User {
  return {
    id: owner,
    oidcIssuer: "https://issuer.example",
    oidcSub: "subject",
    email: "member@example.test",
    name: "member",
    role: "member",
    agentDir: "/agents/member",
    allowedRoots: ["/work"],
    settings: {},
    createdAt: AT,
    updatedAt: AT,
    lastLoginAt: null,
  }
}

function setup() {
  const db = openDb(":memory:")
  databases.push(db)
  migrate(db)
  const ledger = new EventLedger(db)
  const repos = createRepositories(db, ledger)
  repos.users.put(member())
  return { db, ledger, repos, feed: createEventFeed(db, ledger) }
}

function canonicalProject(): Project {
  return {
    id: projectId,
    userId: owner,
    name: "canonical",
    cwd: "/work/canonical",
    agentDir: "/agents/member",
    stateDir: "/state/canonical",
    settings: {
      fullAccessOptIn: true,
      maxRunning: 2,
      defaultModel: "anthropic/claude-sonnet-4",
      defaultReasoning: "high",
      worktreeForAdhoc: true,
    },
    state: "active",
    revision: 1,
    createdAt: AT,
    updatedAt: AT,
  }
}

function lastEvent(ledger: EventLedger): DaemonEvent {
  const event = ledger.readAfter(ledger.headSeq() - 1, 1)[0]
  if (event === undefined) throw new Error("ledger is empty")
  return event
}

function isJsonRecord(value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value)
}

function asRecord(value: JsonValue | undefined): { readonly [key: string]: JsonValue } {
  if (!isJsonRecord(value)) throw new Error("expected a JSON object")
  return value
}

describe("project settings compatibility", () => {
  test("a canonical project round-trips through the repository and persists only nested settings", () => {
    const { db, repos, ledger } = setup()
    const project = canonicalProject()

    repos.projects.put(project)

    expect(repos.projects.get(projectId)).toEqual(project)
    const stored: unknown = JSON.parse(
      db.query<{ readonly json: string }, [string]>("SELECT json FROM projects WHERE id = ?").get(projectId)?.json ?? "null",
    )
    expect(stored).toEqual(JSON.parse(JSON.stringify(project)))
    expect(stored !== null && typeof stored === "object" && "maxRunning" in stored).toBe(false)
    const event = lastEvent(ledger)
    expect(event.data).toMatchObject({ settings: project.settings })
    expect("maxRunning" in event.data).toBe(false)
  })

  test("a legacy project event snapshot replays as canonical settings and the stored event is unchanged", () => {
    const { ledger, feed } = setup()
    const legacy: JsonObject = {
      id: projectId,
      userId: owner,
      name: "legacy",
      cwd: "/work/legacy",
      agentDir: "/agents/member",
      stateDir: "/state/legacy",
      maxRunning: 4,
      state: "active",
      revision: 7,
      createdAt: AT,
      updatedAt: AT,
    }
    let emitted: DaemonEvent | null = null
    const unsubscribe = ledger.subscribe((event) => {
      emitted = event
    })
    ledger.transact((transaction) => transaction.emit({
      at: AT,
      type: "project.upserted",
      entityKind: "project",
      entityId: projectId,
      userId: owner,
      projectId: null,
      data: legacy,
    }))
    unsubscribe()
    if (emitted === null) throw new Error("no project event was emitted")

    const replayed = asRecord(feed.payload({ kind: "user", userId: owner }, emitted).data)
    const stored = lastEvent(ledger).data

    expect(replayed).toMatchObject({ settings: { fullAccessOptIn: false, maxRunning: 4, worktreeForAdhoc: false } })
    expect("maxRunning" in replayed).toBe(false)
    expect(stored).toEqual(legacy)
  })

  test("a canonical project event snapshot is replayed byte-for-byte", () => {
    const { repos, ledger, feed } = setup()
    const project = canonicalProject()
    repos.projects.put(project)

    const replayed = asRecord(feed.payload({ kind: "user", userId: owner }, lastEvent(ledger)).data)

    expect(replayed).toEqual(JSON.parse(JSON.stringify(project)))
    expect("maxRunning" in replayed).toBe(false)
  })
})
