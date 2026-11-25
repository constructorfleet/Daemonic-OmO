import type { Database } from "bun:sqlite"

import { ServiceKey } from "../api/services"
import type { Repositories } from "../auth/types"
import type { Config } from "../config"
import { ulid } from "../core/ids"
import type { Clock, CompletionStatus, Fs, Gateway, Git, Rng, ThreadState, TimerHandle } from "../core/ports"
import type { CancelReason, ProjectId, Run, RunId, ThreadId, User } from "../core/types"
import { auditRun, type AuditDeps } from "./audit"
import { newRun, retryWorkspace, type DecideInput } from "./decide"
import { planDispatch, slotHolders } from "./dispatcher"
import {
  cancelRun,
  settleRun,
  startRun,
  type CancelResult,
  type EngineCore,
  type EngineWaits,
  type Evaluator,
} from "./lifecycle"
import { createRunRecords } from "./records"
import { recoverRuns, superviseRuns } from "./recovery"
import { isSpawnHeld } from "./spawn-hold"
import type { SettleOutcome } from "./state-machine"

export type { DecideInput, RunTrigger, RunWorkspace } from "./decide"
export type { CancelResult, Evaluator } from "./lifecycle"

export type RunConfig = Pick<Config, "defaults" | "hardCaps" | "limits">

export interface RunEngineDeps {
  readonly db: Database
  readonly repos: Repositories
  readonly clock: Clock
  readonly rng: Rng
  readonly gateway: Gateway
  readonly git: Git
  readonly fs: Fs
  readonly config: RunConfig
  readonly worktreeRoot: string
  readonly waits?: Partial<EngineWaits>
  /** A lifecycle step failed outside any request (gateway exception, refused close); defaults to stderr. */
  readonly onError?: (error: unknown) => void
}

export const DEFAULT_WAITS: EngineWaits = { graceMs: 10_000, unattendedCloseMs: 30_000, superviseIntervalMs: 5_000 }

export type SpawnResult =
  | { readonly kind: "queued"; readonly run: Run }
  | { readonly kind: "held" }
  | { readonly kind: "degraded"; readonly detail: string }

export class RunStateError extends Error {
  readonly name = "RunStateError"

  constructor(readonly runId: RunId, message: string) {
    super(message)
  }
}

export interface RunEngine {
  /** Inserts the run (idempotent per fire key and attempt) and wakes the dispatcher; caps never block it. */
  decide(input: DecideInput): Run
  /** An ad-hoc spawn: refused while the owner's kill-switch hold is set or the thread SDK cannot load. */
  spawn(input: DecideInput): Promise<SpawnResult>
  retry(actor: User, run: Run): Run
  cancel(actor: User, id: RunId, reason: CancelReason): Promise<CancelResult>
  /** Cancels every unfinished run of the project; returns the runs that stayed uninterruptible. */
  cancelProject(actor: User, projectId: ProjectId): Promise<readonly RunId[]>
  dispatch(): Promise<void>
  /** Reconciles every unfinished run once on daemon start ("Recovery on daemon start" in the plan). */
  recover(): Promise<void>
  /** Arms the periodic supervision pass; `stop` disarms it. */
  start(): void
  setEvaluator(evaluator: Evaluator): void
  /** Resolves once every lifecycle step started so far (and the steps they start) has finished. */
  idle(): Promise<void>
  stop(): void
}

export const RUNS = new ServiceKey<RunEngine>("runs")

function settleOutcome(status: CompletionStatus): SettleOutcome {
  return status === "completed" || status === "idle" ? { kind: "succeeded" } : { kind: "failed", reason: "turn_error" }
}

export function createRunEngine(deps: RunEngineDeps): RunEngine {
  const { db, repos, clock, rng, gateway, config } = deps
  const waits: EngineWaits = { ...DEFAULT_WAITS, ...deps.waits }
  const report = deps.onError ?? ((error: unknown) => console.error("omo-daemonic: run engine step failed", error))
  const records = createRunRecords(db, repos, clock)
  const audit: AuditDeps = { audit: repos.audit, clock, rng }
  const locks = new Map<RunId, Promise<unknown>>()
  const inflight = new Set<Promise<void>>()
  const timers = new Map<RunId, TimerHandle>()
  const pendingCancel = new Map<RunId, CancelReason>()
  let evaluator: Evaluator | null = null
  let cursor: ProjectId | null = null
  let dispatching: Promise<void> | null = null
  let dispatchAgain = false
  let supervisor: TimerHandle | null = null
  let running = false

  const track = (work: Promise<unknown>): void => {
    const settled: Promise<void> = work.then(() => undefined, report).finally(() => inflight.delete(settled))
    inflight.add(settled)
  }

  const serial = <T>(id: RunId, work: () => Promise<T>): Promise<T> => {
    const next = (locks.get(id) ?? Promise.resolve()).then(work)
    const settled = next.then(() => undefined, () => undefined)
    locks.set(id, settled)
    void settled.then(() => {
      if (locks.get(id) === settled) locks.delete(id)
    })
    return next
  }

  const core: EngineCore = {
    repos, clock, gateway, git: deps.git, fs: deps.fs, records, audit, waits,
    worktreeRoot: deps.worktreeRoot,
    maxKeptWorktreesPerProject: config.limits.maxKeptWorktreesPerProject,
    readBytes: config.defaults.readBytes,
    pendingCancel, timers, serial, track, report,
    requestDispatch: () => track(dispatch()),
    evaluator: () => evaluator,
  }

  async function threadStates(live: readonly Run[]): Promise<ReadonlyMap<ThreadId, ThreadState>> {
    if (!live.some((run) => run.state !== "creating" && run.threadId !== undefined)) return new Map()
    const listed = await gateway.list({ allScope: true })
    if (listed.kind === "ok") return new Map(listed.value.map((snapshot) => [snapshot.thread, snapshot.state]))
    // Without a listing every unfinished thread is assumed busy, so a degraded gateway never over-dispatches.
    return new Map(live.flatMap((run): [ThreadId, ThreadState][] =>
      run.threadId === undefined || run.state === "kept" ? [] : [[run.threadId, "running"]]))
  }

  async function dispatchOnce(): Promise<void> {
    const queued = records.queued()
    if (queued.length === 0) return
    const live = records.live()
    const holders = slotHolders(live, await threadStates(live))
    const plan = planDispatch({
      queued,
      holders,
      cursor,
      caps: {
        machine: config.limits.machineMaxRunning,
        perUser: (userId) => Math.min(repos.users.get(userId)?.settings.maxRunning ?? config.defaults.maxRunning, config.hardCaps.maxRunning),
        perProject: (projectId) => repos.projects.get(projectId)?.settings.maxRunning ?? config.defaults.maxRunningPerProject,
      },
    })
    cursor = plan.cursor
    for (const id of plan.start) {
      const run = records.require(id)
      if (run.state !== "queued") continue
      records.step(run, { kind: "start" })
      track(serial(id, () => startRun(core, id)))
    }
  }

  function dispatch(): Promise<void> {
    if (dispatching !== null) {
      dispatchAgain = true
      return dispatching
    }
    dispatching = (async () => {
      try {
        do {
          dispatchAgain = false
          await dispatchOnce()
        } while (dispatchAgain)
      } finally {
        dispatching = null
      }
    })()
    return dispatching
  }

  function decide(input: DecideInput): Run {
    const run = newRun(input, { id: ulid(rng, clock.now()), at: new Date(clock.now()).toISOString(), worktreeRoot: deps.worktreeRoot })
    const existing = records.byFireKey(run.fireKey, run.attempt)
    if (existing !== null) return existing
    records.insert(run)
    const actorId = input.trigger.kind === "adhoc" || input.trigger.kind === "retry" ? input.trigger.actor : null
    auditRun(audit, { action: "run.spawn", run, detail: { actorId, trigger: input.trigger.kind, fireKey: run.fireKey, attempt: run.attempt } })
    core.requestDispatch()
    return run
  }

  const unsubscribe = gateway.onCompletion((event) => {
    const run = records.activeByThread(event.thread)
    if (run !== null) track(serial(run.id, () => settleRun(core, run.id, settleOutcome(event.outcome.status))))
  })

  async function cancel(actor: User, id: RunId, reason: CancelReason): Promise<CancelResult> {
    pendingCancel.set(id, reason)
    try {
      return await serial(id, () => cancelRun(core, id, reason, actor))
    } finally {
      pendingCancel.delete(id)
    }
  }

  return {
    decide,

    async spawn(input) {
      if (isSpawnHeld(db, input.project.userId)) return { kind: "held" }
      const probe = await gateway.probe()
      if (probe.sdkLoad === "fail") return { kind: "degraded", detail: probe.detail ?? "sdk.load failed" }
      return { kind: "queued", run: decide(input) }
    },

    retry(actor, run) {
      if (run.state !== "closed" || run.outcome === null || run.outcome.kind === "succeeded") {
        throw new RunStateError(run.id, "only a closed run that did not succeed can be retried")
      }
      const project = repos.projects.get(run.projectId)
      if (project === null || project.state !== "active") throw new RunStateError(run.id, "the run's project is not active")
      return decide({ project, spec: run.spec, workspace: retryWorkspace(run, project.name), trigger: { kind: "retry", of: run, actor: actor.id } })
    },

    cancel,

    async cancelProject(actor, projectId) {
      const stuck: RunId[] = []
      for (const run of records.unfinishedInProject(projectId)) {
        if ((await cancel(actor, run.id, "user")).uninterruptible) stuck.push(run.id)
      }
      return stuck
    },

    dispatch,

    recover: () => recoverRuns(core),

    start() {
      running = true
      const arm = (): void => {
        supervisor = clock.setTimer(clock.now() + waits.superviseIntervalMs, () => {
          supervisor = null
          track(superviseRuns(core).finally(() => {
            if (running) arm()
          }))
        })
      }
      if (supervisor === null) arm()
    },

    setEvaluator(next) {
      evaluator = next
    },

    async idle() {
      while (inflight.size > 0) await Promise.all([...inflight])
    },

    stop() {
      running = false
      if (supervisor !== null) clock.clearTimer(supervisor)
      supervisor = null
      unsubscribe()
      for (const timer of timers.values()) clock.clearTimer(timer)
      timers.clear()
    },
  }
}


