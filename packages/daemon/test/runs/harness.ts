import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Database } from "bun:sqlite"

import { DEFAULT_DEFAULTS, DEFAULT_HARD_CAPS, DEFAULT_LIMITS, type Config } from "../../src/config/types"
import { ulid } from "../../src/core/ids"
import type {
  CloseArgs,
  CloseOutcome,
  CreateOutcome,
  CreateThreadArgs,
  GatewayAck,
  GatewayRefusal,
  GatewayResult,
  InterruptArgs,
} from "../../src/core/ports"
import type { Loop, Project, ProjectSettings, RunSpec, Schedule, User, UserRole } from "../../src/core/types"
import { openDb } from "../../src/db/db"
import { EventLedger } from "../../src/db/ledger"
import { migrate } from "../../src/db/migrations"
import { createRepositories } from "../../src/db/repos"
import { createRunEngine, type RunEngine } from "../../src/runs/engine"
import { FakeClock, FakeFs, FakeGateway, FakeGit, SeededRng } from "../support/fakes"

export type StopCall = { readonly method: "interrupt"; readonly args: InterruptArgs } | { readonly method: "close"; readonly args: CloseArgs }

export class TestGateway extends FakeGateway {
  readonly stopCalls: StopCall[] = []
  readonly createAttempts: CreateThreadArgs[] = []
  readonly createRefusals: GatewayRefusal[] = []
  readonly closeRefusals: GatewayRefusal[] = []
  createGate: Promise<void> | null = null
  onCreateAttempt: (() => void) | null = null
  gracefulCloseTimesOut = false
  /** omo starts the turn of a create-with-prompt, so a created thread reads `running` until it settles. */
  runOnCreate = false

  override async create(args: CreateThreadArgs): Promise<GatewayResult<CreateOutcome>> {
    this.createAttempts.push(args)
    this.onCreateAttempt?.()
    const gate = this.createGate
    if (gate !== null) await gate
    const refusal = this.createRefusals.shift()
    if (refusal !== undefined) return refusal
    const created = await super.create(args)
    if (created.kind === "ok" && this.runOnCreate) this.setThreadState(created.value.thread, "running")
    return created
  }

  override async interrupt(args: InterruptArgs): Promise<GatewayAck> {
    this.stopCalls.push({ method: "interrupt", args })
    return super.interrupt(args)
  }

  override async close(args: CloseArgs): Promise<GatewayResult<CloseOutcome>> {
    this.stopCalls.push({ method: "close", args })
    const refusal = this.closeRefusals.shift()
    if (refusal !== undefined) return refusal
    if (args.graceful === true && this.gracefulCloseTimesOut) return { kind: "ok", value: { closed: false, reason: "timeout" } }
    return super.close(args)
  }
}

export type RunConfig = Pick<Config, "defaults" | "hardCaps" | "limits">

export interface RigOptions {
  readonly limits?: Partial<RunConfig["limits"]>
  readonly defaults?: Partial<RunConfig["defaults"]>
  readonly project?: Partial<ProjectSettings>
}

export interface EngineRig {
  readonly root: string
  readonly db: Database
  readonly repos: ReturnType<typeof createRepositories>
  readonly clock: FakeClock
  readonly rng: SeededRng
  readonly gateway: TestGateway
  readonly git: FakeGit
  readonly fs: FakeFs
  readonly config: RunConfig
  readonly user: User
  readonly project: Project
  readonly errors: unknown[]
  engine: RunEngine
  /** A daemon restart: the old engine stops, a new one opens the same database and gateway. */
  restart(): RunEngine
  addUser(role?: UserRole): User
  addProject(owner: User, settings?: Partial<ProjectSettings>): Promise<Project>
  addSchedule(project: Project): Schedule
  addLoop(project: Project): Loop
  close(): Promise<void>
}

const rigs: EngineRig[] = []

/** Each test file registers `afterEach(closeRigs)`. */
export async function closeRigs(): Promise<void> {
  for (const rig of rigs.splice(0)) await rig.close()
}

export async function engineRig(options: RigOptions = {}): Promise<EngineRig> {
  const root = await mkdtemp(join(tmpdir(), "omo-daemonic-runs-"))
  const db = openDb(join(root, "daemon.sqlite"))
  migrate(db)
  const ledger = new EventLedger(db)
  const repos = createRepositories(db, ledger)
  const clock = new FakeClock()
  const rng = new SeededRng(7)
  const gateway = new TestGateway()
  const git = new FakeGit()
  const fs = new FakeFs(root)
  const config: RunConfig = {
    defaults: { ...DEFAULT_DEFAULTS, ...options.defaults },
    hardCaps: DEFAULT_HARD_CAPS,
    limits: { ...DEFAULT_LIMITS, ...options.limits },
  }
  const errors: unknown[] = []
  const at = new Date(clock.now()).toISOString()

  const addUser = (role: UserRole = "member"): User => {
    const id = ulid(rng, clock.now())
    const user: User = {
      id, oidcIssuer: "https://idp.test", oidcSub: `sub-${id}`, email: `${id}@example.test`, name: id, role,
      agentDir: join(root, "agents", id), allowedRoots: [root], settings: {}, createdAt: at, updatedAt: at, lastLoginAt: null,
    }
    repos.users.put(user)
    return user
  }

  const addProject = async (owner: User, settings: Partial<ProjectSettings> = {}): Promise<Project> => {
    const id = ulid(rng, clock.now())
    const cwd = join(root, "repos", id)
    await mkdir(cwd, { recursive: true })
    git.addRepo(cwd)
    git.seedWorktree(cwd, { path: cwd, branch: "refs/heads/main", head: "abc", bare: false })
    const project: Project = {
      id, userId: owner.id, name: `project ${id}`, cwd, agentDir: owner.agentDir, stateDir: join(owner.agentDir, "projects", id, "senpi-task"),
      settings: { fullAccessOptIn: false, maxRunning: 1, worktreeForAdhoc: false, ...settings },
      state: "active", revision: 1, createdAt: at, updatedAt: at,
    }
    repos.projects.put(project)
    return project
  }

  const loopSpec: RunSpec = { prompt: "loop", timeoutMs: 60_000 }

  const addSchedule = (project: Project): Schedule => {
    const schedule: Schedule = {
      id: ulid(rng, clock.now()), userId: project.userId, projectId: project.id, name: "nightly",
      trigger: { kind: "interval", everyMs: 3_600_000, anchorAt: at }, target: { kind: "run", spec: loopSpec },
      overlap: "skip", queueMax: 1, misfire: "fire_once", misfireGraceMs: 0, maxCatchup: 1, fireCount: 0,
      state: "active", nextFireAt: clock.now() + 3_600_000, lastSlotAt: null, revision: 1,
    }
    repos.schedules.put(schedule, at)
    return schedule
  }

  const addLoop = (project: Project): Loop => {
    const loop: Loop = {
      id: ulid(rng, clock.now()), userId: project.userId, projectId: project.id, fireKey: `loop:${project.id}`, nonce: "n",
      spec: loopSpec, doneWhen: [{ kind: "marker" }], maxIterations: 10, maxConsecutiveFailures: 3, cadenceMs: 0,
      backoff: { initialMs: 1000, factor: 2, maxMs: 60_000 }, sessionMode: "fresh", carryForwardBytes: 0,
      state: "running", iteration: 1, consecutiveFailures: 0, nextIterationAt: null, revision: 1,
    }
    repos.loops.put(loop, at)
    return loop
  }

  const build = (): RunEngine => createRunEngine({
    db, repos, clock, rng, gateway, git, fs, config,
    worktreeRoot: join(root, "worktrees"),
    onError: (error) => errors.push(error),
  })

  const user = addUser()
  const project = await addProject(user, options.project)
  const rig: EngineRig = {
    root, db, repos, clock, rng, gateway, git, fs, config, user, project, errors,
    engine: build(),
    restart() {
      rig.engine.stop()
      rig.engine = build()
      return rig.engine
    },
    addUser,
    addProject,
    addSchedule,
    addLoop,
    async close() {
      rig.engine.stop()
      db.close()
      await rm(root, { recursive: true, force: true })
    },
  }
  rigs.push(rig)
  return rig
}
