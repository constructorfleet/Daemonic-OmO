import type { Database } from "bun:sqlite"
import { afterEach, describe, expect, test } from "bun:test"
import { openDb } from "../../src/db/db"
import { migrate } from "../../src/db/migrations"
import { EventLedger } from "../../src/db/ledger"
import { createRepositories } from "../../src/db/repos"
import { parseUlid } from "../../src/core/ids"
import type { EntityKind, Loop, Project, Run, Schedule, User, UserId } from "../../src/core/types"

const databases: Database[] = []
function fixtureId(value: string): UserId {
  const parsed = parseUlid(value)
  if (parsed === null) throw new Error("invalid entity fixture id")
  return parsed
}
const owner = fixtureId("01ARZ3NDEKTSV4RRFFQ69G5FAV")
const projectId = fixtureId("01ARZ3NDEKTSV4RRFFQ69G5FAZ")
const scheduleId = fixtureId("01ARZ3NDEKTSV4RRFFQ69G5FB0")
const loopId = fixtureId("01ARZ3NDEKTSV4RRFFQ69G5FB1")
const runId = fixtureId("01ARZ3NDEKTSV4RRFFQ69G5FB2")

afterEach(() => {
  for (const db of databases.splice(0)) db.close()
})

function entities(userId: UserId) {
  const user: User = {
    id: userId,
    oidcIssuer: "https://issuer.example",
    oidcSub: "subject",
    email: "member@example.test",
    name: "member",
    role: "member",
    agentDir: "/agents/member",
    allowedRoots: ["/work"],
    settings: { maxRunning: 3 },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    lastLoginAt: null,
  }
  const project: Project = {
    id: projectId,
    userId,
    name: "project",
    cwd: "/work/project",
    agentDir: "/agents/member",
    stateDir: "/state/project",
    settings: { fullAccessOptIn: false, maxRunning: 2, worktreeForAdhoc: false },
    state: "active",
    revision: 1,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  }
  const spec = { prompt: "work", timeoutMs: 30_000 } as const
  const schedule: Schedule = {
    id: scheduleId,
    userId,
    projectId,
    name: "schedule",
    trigger: { kind: "once", at: user.createdAt },
    target: { kind: "run", spec },
    overlap: "skip",
    queueMax: 1,
    misfire: "skip",
    misfireGraceMs: 0,
    maxCatchup: 1,
    fireCount: 0,
    state: "active",
    nextFireAt: 1,
    lastSlotAt: null,
    revision: 1,
  }
  const loop: Loop = {
    id: loopId,
    userId,
    projectId,
    spec,
    doneWhen: [{ kind: "marker" }],
    maxIterations: 3,
    maxConsecutiveFailures: 2,
    cadenceMs: 1_000,
    backoff: { initialMs: 100, factor: 2, maxMs: 1_000 },
    sessionMode: "fresh",
    carryForwardBytes: 0,
    fireKey: "loop-fire",
    nonce: "loop-nonce",
    state: "pending",
    iteration: 0,
    consecutiveFailures: 0,
    nextIterationAt: 1,
    revision: 1,
  }
  const run: Run = {
    id: runId,
    userId,
    projectId,
    fireKey: "run-fire",
    attempt: 1,
    name: "run",
    spec,
    cwd: project.cwd,
    state: "queued",
    outcome: null,
    cancelRequested: false,
    orphanChildren: [],
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    revision: 1,
  }
  return { user, project, schedule, loop, run }
}

describe("entity event snapshots", () => {
  test("each repository write stores its complete post-change entity in the event", () => {
    const db = openDb(":memory:")
    databases.push(db)
    migrate(db)
    const ledger = new EventLedger(db)
    const repos = createRepositories(db, ledger)
    const initial = entities(owner)
    const at = "2026-01-02T00:00:00.000Z"
    const expectSnapshot = (kind: EntityKind, snapshot: unknown): void => {
      const record = ledger.readAfter(ledger.headSeq() - 1, 1)[0]
      expect(record?.entityKind).toBe(kind)
      expect(JSON.stringify(record?.data)).toBe(JSON.stringify(snapshot))
    }

    repos.users.put(initial.user)
    expectSnapshot("user", repos.users.get(owner))
    const headAfterUser = ledger.headSeq()
    repos.sessions.put({
      id: "session-secret",
      userId: owner,
      expiresAt: at,
      csrfToken: "session-csrf-secret",
      createdAt: at,
    })
    expect(ledger.headSeq()).toBe(headAfterUser)
    repos.users.put({ ...initial.user, name: "renamed", updatedAt: at })
    expectSnapshot("user", repos.users.get(owner))
    repos.projects.put(initial.project)
    expectSnapshot("project", repos.projects.get(projectId))
    repos.projects.update({ ...initial.project, name: "renamed", revision: 2, updatedAt: at }, 1)
    expectSnapshot("project", repos.projects.get(projectId))
    repos.schedules.put(initial.schedule, at)
    expectSnapshot("schedule", repos.schedules.get(scheduleId))
    repos.schedules.update({ ...initial.schedule, name: "renamed", revision: 2 }, 1, at)
    expectSnapshot("schedule", repos.schedules.get(scheduleId))
    repos.loops.put(initial.loop, at)
    expectSnapshot("loop", repos.loops.get(loopId))
    repos.loops.update({ ...initial.loop, state: "running", revision: 2 }, 1, at)
    expectSnapshot("loop", repos.loops.get(loopId))
    repos.runs.put(initial.run)
    expectSnapshot("run", repos.runs.get(runId))
    repos.runs.update({ ...initial.run, state: "active", revision: 2, updatedAt: at }, 1)
    expectSnapshot("run", repos.runs.get(runId))
  })
})
