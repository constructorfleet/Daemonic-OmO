import type { Database } from "bun:sqlite"
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveTaskStateDir } from "@omo-daemonic/store"
import type { Repositories } from "../../src/auth/types"
import { DEFAULT_LIMITS } from "../../src/config/types"
import { ulid } from "../../src/core/ids"
import type { Project, Run, User } from "../../src/core/types"
import { openDb } from "../../src/db/db"
import { EventLedger } from "../../src/db/ledger"
import { migrate } from "../../src/db/migrations"
import { createRepositories } from "../../src/db/repos"
import { ImageCache } from "../../src/observer/images"
import type { TranscriptOptions } from "../../src/observer/transcript-doc"
import { SeededRng } from "../support/fakes"

export const FIXTURES = join(import.meta.dir, "fixtures")
export const ROOT_SESSION_REL = "sessions/--tmp-project-fixture--/2026-11-25T08-00-00-000Z_sess-basic.jsonl"
export const MIB = 1024 * 1024

const AT = "2026-11-25T08:00:00.000Z"
const NOW = Date.parse(AT)
const rng = new SeededRng(13)
const temps: string[] = []
const databases: Database[] = []

/** Each test file registers `afterEach(cleanTemps)`. */
export function cleanTemps(): void {
  for (const db of databases.splice(0)) db.close()
  for (const path of temps.splice(0)) rmSync(path, { recursive: true, force: true })
}

export function repositories(): Repositories {
  const db = openDb(":memory:")
  databases.push(db)
  migrate(db)
  return createRepositories(db, new EventLedger(db))
}

export function seedUser(repos: Repositories, agentDir: string, sub: string): User {
  const user: User = {
    id: ulid(rng, NOW),
    oidcIssuer: "https://issuer.example",
    oidcSub: sub,
    email: `${sub}@example.test`,
    name: sub,
    role: "member",
    agentDir,
    allowedRoots: [],
    settings: {},
    createdAt: AT,
    updatedAt: AT,
    lastLoginAt: null,
  }
  repos.users.put(user)
  return user
}

export function seedProject(repos: Repositories, user: User, cwd: string): Project {
  const project: Project = {
    id: ulid(rng, NOW),
    userId: user.id,
    name: "fixture",
    cwd,
    agentDir: user.agentDir,
    stateDir: resolveTaskStateDir(cwd, { agentDir: user.agentDir }),
    settings: { fullAccessOptIn: false, maxRunning: 1, worktreeForAdhoc: true },
    state: "active",
    revision: 1,
    createdAt: AT,
    updatedAt: AT,
  }
  repos.projects.put(project)
  return project
}

export function seedRun(repos: Repositories, project: Project, cwd: string, worktree: boolean): Run {
  const run: Run = {
    id: ulid(rng, NOW),
    userId: project.userId,
    projectId: project.id,
    fireKey: `observer-${cwd}`,
    attempt: 1,
    name: "run",
    spec: { prompt: "work", timeoutMs: 1_000 },
    cwd,
    ...(worktree ? { worktreePath: cwd, branch: "omo/run" } : {}),
    state: "active",
    outcome: null,
    cancelRequested: false,
    orphanChildren: [],
    createdAt: AT,
    updatedAt: AT,
    revision: 1,
  }
  repos.runs.put(run)
  return run
}

export function writeTask(stateDir: string, record: Readonly<Record<string, unknown>>): string {
  const path = join(stateDir, "tasks", `${String(record.task_id)}.json`)
  mkdirSync(join(stateDir, "tasks"), { recursive: true })
  writeFileSync(path, JSON.stringify({ created_at: AT, status: "running", ...record }))
  return path
}

export function tempDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), `omo-observer-${prefix}-`))
  temps.push(path)
  return path
}

export interface FixtureTree {
  readonly agentDir: string
  readonly projectDir: string
  readonly stateDir: string
  readonly rootSession: string
}

export function fixtureTree(): FixtureTree {
  const base = tempDir("tree")
  const agentDir = join(base, "agent")
  const projectDir = join(base, "project")
  cpSync(join(FIXTURES, "agent"), agentDir, { recursive: true })
  mkdirSync(projectDir)
  const stateDir = resolveTaskStateDir(projectDir, { agentDir })
  cpSync(join(FIXTURES, "store"), stateDir, { recursive: true })
  return { agentDir, projectDir, stateDir, rootSession: join(agentDir, ROOT_SESSION_REL) }
}

export function appendJson(path: string, value: unknown): void {
  appendFileSync(path, `${JSON.stringify(value)}\n`)
}

export function text(path: string): string {
  return readFileSync(path, "utf8")
}

export function assistant(id: string | null, content: readonly unknown[]): unknown {
  return { type: "message", ...(id === null ? {} : { id }), message: { role: "assistant", content } }
}

/** The shipped observer defaults; the config suite owns the numbers. */
export function transcriptOptions(readBytes: number, images: ImageCache = imageCache()): TranscriptOptions {
  return { readBytes, images, limits: DEFAULT_LIMITS }
}

export function imageCache(): ImageCache {
  return new ImageCache(DEFAULT_LIMITS.observerImageCacheBytes)
}

export function toolResult(callId: string, name: string, body: string, isError = false): unknown {
  return {
    type: "message",
    id: `res-${callId}-${body.length}`,
    message: { role: "toolResult", toolCallId: callId, toolName: name, content: [{ type: "text", text: body }], isError },
  }
}
