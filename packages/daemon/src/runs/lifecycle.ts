import { join } from "node:path"

import type { Repositories } from "../auth/types"
import { sessionId as toSessionId } from "../core/ids"
import { GitError, type Clock, type CreateThreadArgs, type CreateOutcome, type Fs, type Gateway, type GatewayErrorCode, type GatewayResult, type Git, type TimerHandle } from "../core/ports"
import type { CancelReason, Ms, Project, Run, RunFailureReason, RunId, User } from "../core/types"
import type { AuditDeps } from "./audit"
import { auditRun } from "./audit"
import type { RunRecords } from "./records"
import { findSessionFile } from "./session-files"
import { isFinished, type EndOutcome, type SettleOutcome } from "./state-machine"
import { orphanChildren, stopThread } from "./termination"
import { ensureWorktree } from "./worktree"

export interface EngineWaits {
  /** Graceful-close wait of a cancel or timeout (plan: 10 s). */
  readonly graceMs: Ms
  /** Graceful-close wait when an unattended run's thread is closed after it settles (plan: 30 s). */
  readonly unattendedCloseMs: Ms
  /** Period of the supervision pass: completion fallback, overdue timeouts, lost threads, orphan children. */
  readonly superviseIntervalMs: Ms
}

/** Called once per settled loop iteration before its thread is closed (todo 18 registers it). */
export type Evaluator = (run: Run) => Promise<void>

export interface CancelResult {
  readonly run: Run
  /** True when even a forced close was refused: the run stays nonterminal with `cancelRequested`. */
  readonly uninterruptible: boolean
}

/** What the lifecycle flows share with the engine; every flow runs inside `serial(run.id)`. */
export interface EngineCore {
  readonly repos: Repositories
  readonly clock: Clock
  readonly gateway: Gateway
  readonly git: Git
  readonly fs: Fs
  readonly records: RunRecords
  readonly audit: AuditDeps
  readonly waits: EngineWaits
  readonly worktreeRoot: string
  readonly maxKeptWorktreesPerProject: number
  readonly readBytes: number
  readonly pendingCancel: ReadonlyMap<RunId, CancelReason>
  readonly timers: Map<RunId, TimerHandle>
  serial<T>(id: RunId, work: () => Promise<T>): Promise<T>
  track(work: Promise<unknown>): void
  requestDispatch(): void
  evaluator(): Evaluator | null
  report(error: unknown): void
}

export class RunStopError extends Error {
  readonly name = "RunStopError"

  constructor(readonly runId: RunId, readonly detail: string) {
    super(`run ${runId}: thread could not be stopped: ${detail}`)
  }
}

export class RunCloseError extends Error {
  readonly name = "RunCloseError"

  constructor(readonly runId: RunId, readonly detail: string) {
    super(`run ${runId}: settled thread could not be closed: ${detail}`)
  }
}

export function requireProject(core: EngineCore, run: Run): Project {
  const project = core.repos.projects.get(run.projectId)
  if (project === null) throw new RangeError(`run ${run.id} names missing project ${run.projectId}`)
  return project
}

const TRANSIENT: readonly GatewayErrorCode[] = ["bridge_restarted", "bridge_timeout"]

function failureReason(code: GatewayErrorCode): RunFailureReason {
  if (code === "host_unavailable") return "host_unavailable"
  return code === "sdk_unavailable" || code === "gateway_degraded" ? "gateway_degraded" : "create_refused"
}

/** `create` under the fire key; on `host_unavailable` the host is ensured once and the create retried once. */
async function createThread(core: EngineCore, run: Run, project: Project): Promise<GatewayResult<CreateOutcome>> {
  const args: CreateThreadArgs = {
    name: run.name,
    cwd: run.cwd,
    prompt: run.spec.prompt,
    idempotencyKey: `${run.fireKey}:${run.attempt}`,
    ...(run.spec.model === undefined ? {} : { model: run.spec.model }),
    ...(run.spec.thinking === undefined ? {} : { reasoning: run.spec.thinking }),
  }
  const first = await core.gateway.create(args)
  if (first.kind === "ok") return first
  if (first.code === "host_unavailable") {
    const ensured = await core.gateway.ensureHost({ agentDir: project.agentDir })
    if (ensured.kind === "error") return { ...first, message: `${first.message}; ensureHost ${ensured.code}: ${ensured.message}` }
    return core.gateway.create(args)
  }
  return TRANSIENT.includes(first.code) ? core.gateway.create(args) : first
}

function end(core: EngineCore, run: Run, outcome: EndOutcome, patch: Parameters<RunRecords["step"]>[2] = {}): Run {
  clearTimeout(core, run.id)
  const ended = core.records.step(run, { kind: "end", outcome }, patch)
  core.requestDispatch()
  return ended
}

export async function startRun(core: EngineCore, id: RunId): Promise<void> {
  const run = core.records.require(id)
  if (run.state !== "creating") return
  const cancelReason = core.pendingCancel.get(id)
  if (cancelReason !== undefined) {
    end(core, run, { kind: "cancelled" }, { cancelRequested: true, cancelReason })
    return
  }
  const project = requireProject(core, run)
  if (run.worktreePath === join(core.worktreeRoot, run.projectId, run.id) && run.branch !== undefined) {
    const deps = { git: core.git, root: core.worktreeRoot, maxKeptPerProject: core.maxKeptWorktreesPerProject }
    try {
      const placed = await ensureWorktree(deps, project, { path: run.worktreePath, branch: run.branch })
      if (placed.kind === "capped") {
        end(core, core.records.require(id), { kind: "skipped", reason: "worktree_cap" }, { errorDetail: `${placed.kept} kept worktrees` })
        return
      }
    } catch (error) {
      if (!(error instanceof GitError)) throw error
      end(core, core.records.require(id), { kind: "failed", reason: "create_refused" }, { errorDetail: `git: ${error.message}: ${error.stderr}` })
      return
    }
  }
  const answer = await createThread(core, run, project)
  const latest = core.records.require(id)
  if (answer.kind === "error") {
    end(core, latest, { kind: "failed", reason: failureReason(answer.code) }, { errorDetail: `${answer.code}: ${answer.message}` })
    return
  }
  const identity = { threadId: answer.value.thread, sessionId: answer.value.sessionId ?? toSessionId(answer.value.thread) }
  const lateCancel = core.pendingCancel.get(id)
  if (lateCancel !== undefined) {
    await stopAndEnd(core, core.records.patch(latest, { ...identity, cancelRequested: true, cancelReason: lateCancel }), { kind: "cancelled" })
    return
  }
  await armRun(core, core.records.step(latest, { kind: "activate" }, identity))
}

export async function armRun(core: EngineCore, run: Run): Promise<void> {
  if (run.threadId === undefined) return
  const project = requireProject(core, run)
  const file = run.sessionFile ?? await findSessionFile(core.fs, project.agentDir, run.threadId)
  const current = file !== null && run.sessionFile === undefined ? core.records.patch(run, { sessionFile: file }) : run
  await core.gateway.bindCompletion({ thread: run.threadId, events: ["completion"] })
  armTimeout(core, current)
  core.requestDispatch()
}

function armTimeout(core: EngineCore, run: Run): void {
  clearTimeout(core, run.id)
  const at = Date.parse(run.activeAt ?? run.updatedAt) + run.spec.timeoutMs
  core.timers.set(run.id, core.clock.setTimer(at, () => {
    core.timers.delete(run.id)
    core.track(core.serial(run.id, () => expireRun(core, run.id)))
  }))
}

function clearTimeout(core: EngineCore, id: RunId): void {
  const timer = core.timers.get(id)
  if (timer === undefined) return
  core.clock.clearTimer(timer)
  core.timers.delete(id)
}

export async function stopAndEnd(core: EngineCore, run: Run, outcome: EndOutcome): Promise<CancelResult> {
  if (run.threadId === undefined) return { run: end(core, run, outcome), uninterruptible: false }
  const stopped = await stopThread(core.gateway, run.threadId, { graceMs: core.waits.graceMs })
  const latest = core.records.require(run.id)
  if (stopped.kind === "unreachable") {
    core.report(new RunStopError(run.id, stopped.detail))
    return { run: core.records.patch(latest, { errorDetail: stopped.detail }), uninterruptible: true }
  }
  return { run: end(core, latest, outcome, { orphanChildren: orphanChildren(latest, requireProject(core, latest)) }), uninterruptible: false }
}

export function loseRun(core: EngineCore, run: Run): Run {
  return end(core, run, { kind: "lost", reason: "thread_missing" })
}

export async function expireRun(core: EngineCore, id: RunId): Promise<void> {
  const run = core.records.require(id)
  if (run.state === "active") await stopAndEnd(core, run, { kind: "timed_out" })
}

export async function cancelRun(core: EngineCore, id: RunId, reason: CancelReason, actor: User): Promise<CancelResult> {
  const run = core.records.require(id)
  if (isFinished(run.state)) return { run, uninterruptible: false }
  auditRun(core.audit, { action: "run.cancel", run, detail: { actorId: actor.id, reason } })
  return stopAndEnd(core, core.records.patch(run, { cancelRequested: true, cancelReason: reason }), { kind: "cancelled" })
}

export async function settleRun(core: EngineCore, id: RunId, outcome: SettleOutcome): Promise<void> {
  const run = core.records.require(id)
  if (run.state !== "active" || core.pendingCancel.has(id)) return
  clearTimeout(core, id)
  core.records.step(run, { kind: "settle", outcome })
  await finishRun(core, id)
}

export async function finishRun(core: EngineCore, id: RunId): Promise<void> {
  const settled = core.records.require(id)
  const run = settled.state === "settled" ? core.records.step(settled, { kind: "evaluate" }) : settled
  if (run.state !== "evaluating") return
  const evaluator = core.evaluator()
  if (run.loopId !== undefined && evaluator !== null) await evaluator(run)
  const unattended = run.scheduleId !== undefined || run.loopId !== undefined
  if (unattended && run.threadId !== undefined) {
    const closed = await core.gateway.close({ thread: run.threadId, graceful: true, waitMs: core.waits.unattendedCloseMs })
    if (closed.kind === "error") {
      core.report(new RunCloseError(id, `${closed.code}: ${closed.message}`))
      return
    }
  }
  core.records.step(core.records.require(id), { kind: unattended ? "close" : "keep" })
  core.requestDispatch()
}
