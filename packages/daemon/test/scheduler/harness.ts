import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Database } from "bun:sqlite"

import { DEFAULT_DEFAULTS, DEFAULT_HARD_CAPS, DEFAULT_LIMITS, type Config } from "../../src/config/types"
import { ulid } from "../../src/core/ids"
import type { DaemonEvent, JsonObject, Project, ProjectSettings, Run, Schedule, User } from "../../src/core/types"
import { openDb } from "../../src/db/db"
import { EventLedger } from "../../src/db/ledger"
import { migrate } from "../../src/db/migrations"
import { createRepositories } from "../../src/db/repos"
import { createRunEngine, type RunEngine } from "../../src/runs/engine"
import { createScheduler, type LoopLauncher, type Scheduler } from "../../src/scheduler/scheduler"
import { createScheduleService, type ScheduleInput, type ScheduleService } from "../../src/scheduler/service"
import { TestGateway } from "../runs/harness"
import { FakeClock, FakeFs, FakeGit, SeededRng } from "../support/fakes"

export type RigConfig = Pick<Config, "defaults" | "hardCaps" | "limits">

export interface RigOptions {
  readonly wallMs?: number
  readonly defaults?: Partial<RigConfig["defaults"]>
  readonly limits?: Partial<RigConfig["limits"]>
  readonly project?: Partial<ProjectSettings>
  readonly loops?: LoopLauncher
}

export interface LogLine {
  readonly event: string
  readonly fields: JsonObject
}

export interface SchedulerRig {
  readonly root: string
  readonly db: Database
  readonly ledger: EventLedger
  readonly repos: ReturnType<typeof createRepositories>
  readonly clock: FakeClock
  readonly gateway: TestGateway
  readonly git: FakeGit
  readonly user: User
  readonly project: Project
  readonly engine: RunEngine
  readonly scheduler: Scheduler
  readonly service: ScheduleService
  readonly logs: LogLine[]
  readonly errors: unknown[]
  addProject(settings?: Partial<ProjectSettings>): Promise<Project>
  create(input: Partial<ScheduleInput>, project?: Project): Schedule
  schedule(id: Schedule["id"]): Schedule
  runsOf(schedule: Schedule): readonly Run[]
  events(type: string): readonly DaemonEvent[]
  settle(): Promise<void>
}

const rigs: { close(): Promise<void> }[] = []

/** Each test file registers `afterEach(closeSchedulerRigs)`. */
export async function closeSchedulerRigs(): Promise<void> {
  for (const rig of rigs.splice(0)) await rig.close()
}

export const HOUR = 3_600_000

export async function schedulerRig(options: RigOptions = {}): Promise<SchedulerRig> {
  const root = await mkdtemp(join(tmpdir(), "omo-daemonic-sched-"))
  const db = openDb(join(root, "daemon.sqlite"))
  migrate(db)
  const ledger = new EventLedger(db)
  const repos = createRepositories(db, ledger)
  const clock = new FakeClock({ wallMs: options.wallMs ?? Date.parse("2027-01-10T00:00:00Z") })
  const rng = new SeededRng(17)
  const gateway = new TestGateway()
  const git = new FakeGit()
  const config: RigConfig = {
    defaults: { ...DEFAULT_DEFAULTS, ...options.defaults },
    hardCaps: DEFAULT_HARD_CAPS,
    limits: { ...DEFAULT_LIMITS, ...options.limits },
  }
  const logs: LogLine[] = []
  const errors: unknown[] = []
  const at = new Date(clock.now()).toISOString()

  const id = ulid(rng, clock.now())
  const user: User = {
    id, oidcIssuer: "https://idp.test", oidcSub: `sub-${id}`, email: `${id}@example.test`, name: id, role: "member",
    agentDir: join(root, "agent"), allowedRoots: [root], settings: {}, createdAt: at, updatedAt: at, lastLoginAt: null,
  }
  repos.users.put(user)

  const addProject = async (settings: Partial<ProjectSettings> = {}): Promise<Project> => {
    const projectId = ulid(rng, clock.now())
    const cwd = join(root, "repos", projectId)
    await mkdir(cwd, { recursive: true })
    git.addRepo(cwd)
    const project: Project = {
      id: projectId, userId: user.id, name: `project-${projectId}`, cwd, agentDir: user.agentDir,
      stateDir: join(user.agentDir, "projects", projectId, "senpi-task"),
      settings: { fullAccessOptIn: false, maxRunning: 1, worktreeForAdhoc: false, ...options.project, ...settings },
      state: "active", revision: 1, createdAt: at, updatedAt: at,
    }
    repos.projects.put(project)
    return project
  }

  const engine = createRunEngine({
    db, repos, clock, rng, gateway, git, fs: new FakeFs(root), config,
    worktreeRoot: join(root, "worktrees"),
    onError: (error) => errors.push(error),
  })
  const scheduler = createScheduler({
    db, repos, ledger, clock, rng,
    queueMinExpiryMs: config.defaults.queueMinExpiryMs,
    engine: () => engine,
    loops: () => options.loops,
    timing: {
      maxTickIntervalMs: config.limits.schedulerMaxTickIntervalMs,
      clockJumpMs: config.limits.schedulerClockJumpMs,
    },
    log: (event, fields) => logs.push({ event, fields }),
    onError: (error) => errors.push(error),
  })
  const service = createScheduleService({ db, repos, ledger, clock, rng, config, scheduler, engine: () => engine })
  const project = await addProject()

  const rig: SchedulerRig = {
    root, db, ledger, repos, clock, gateway, git, user, project, engine, scheduler, service, logs, errors,
    addProject,
    create(input, target = project) {
      return service.create(target, {
        name: "nightly",
        trigger: { kind: "interval", everyMs: HOUR, anchorAt: new Date(clock.now() + HOUR / 2).toISOString() },
        target: { kind: "run", spec: { prompt: "do the nightly chores", timeoutMs: 60_000 } },
        ...input,
      })
    },
    schedule(scheduleId) {
      const schedule = repos.schedules.get(scheduleId)
      if (schedule === null) throw new Error(`schedule ${scheduleId} is missing`)
      return schedule
    },
    runsOf(schedule) {
      return repos.runs.listByProject(schedule.projectId)
        .filter((run) => run.scheduleId === schedule.id)
        .sort((left, right) => (left.slotAt ?? 0) - (right.slotAt ?? 0))
    },
    events(type) {
      return ledger.readAfter(0, 100_000).filter((event) => event.type === type)
    },
    async settle() {
      await scheduler.idle()
      await engine.idle()
      await scheduler.idle()
    },
  }
  rigs.push({
    async close() {
      scheduler.stop()
      engine.stop()
      db.close()
      await rm(root, { recursive: true, force: true })
    },
  })
  return rig
}
