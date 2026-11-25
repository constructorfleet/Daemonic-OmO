import { ApiError } from "../api/errors"
import type { Repositories } from "../auth/types"
import type { LimitsConfig } from "../config"
import { ulid } from "../core/ids"
import type {
  Clock,
  Gateway,
  GatewayErrorCode,
  GatewayResult,
  ThreadSnapshot,
} from "../core/ports"
import type { Project, Run, ThreadId, User } from "../core/types"
import type { Rng } from "../core/ports"

export interface ThreadListDeps {
  readonly gateway: Gateway
  readonly repos: Repositories
  readonly clock: Clock
  readonly rng: Rng
  readonly limits: LimitsConfig
}

export class ControlsGatewayError extends Error {
  readonly name = "ControlsGatewayError"

  constructor(readonly code: GatewayErrorCode, message: string) {
    super(message)
  }
}

function visibleProjects(actor: User, repos: Repositories): readonly Project[] {
  return actor.role === "admin" ? repos.projects.listAll() : repos.projects.listByUser(actor.id)
}

export function runsByThread(actor: User, repos: Repositories): ReadonlyMap<ThreadId, Run> {
  const runs = visibleProjects(actor, repos).flatMap((project) => repos.runs.listByProject(project.id))
  const links = new Map<ThreadId, Run>()
  for (const run of runs) {
    if (run.threadId !== undefined && (actor.role === "admin" || run.userId === actor.id)) {
      links.set(run.threadId, run)
    }
  }
  return links
}

function gatewayValue<T>(result: GatewayResult<T>): T {
  if (result.kind === "error") throw new ControlsGatewayError(result.code, result.message)
  return result.value
}

async function threadFromGateway(deps: ThreadListDeps, thread: ThreadId): Promise<ThreadSnapshot> {
  const snapshot = gatewayValue(await deps.gateway.list({ allScope: true }))
    .find((row) => row.thread === thread)
  if (snapshot === undefined) throw new ApiError("not_found", "thread not found")
  return snapshot
}

function runForThread(deps: ThreadListDeps, actor: User, thread: ThreadId): Run | null {
  const run = runsByThread({ ...actor, role: "admin" }, deps.repos).get(thread)
  if (run === undefined) return null
  if (actor.role !== "admin" && run.userId !== actor.id) throw new ApiError("not_found", "thread not found")
  return run
}

function requireControl(snapshot: ThreadSnapshot, control: string): void {
  if (!snapshot.controls.includes(control)) {
    throw new ApiError("state_conflict", `thread does not support ${control}`, { missingControl: control })
  }
}

interface ThreadAudit {
  readonly actor: User
  readonly thread: ThreadId
  readonly run: Run | null
  readonly action: string
  readonly detail: Readonly<Record<string, string | number | boolean | null>>
}

function audit(deps: ThreadListDeps, input: ThreadAudit): void {
  deps.repos.audit.put({
    id: ulid(deps.rng, deps.clock.now()),
    at: new Date(deps.clock.now()).toISOString(),
    userId: input.actor.id,
    action: `thread.${input.action}`,
    entityKind: input.run === null ? "daemon" : "run",
    entityId: input.run?.id ?? input.thread,
    detail: { threadId: input.thread, ...input.detail },
  })
}

export type ThreadSendMode = "auto" | "steer" | "follow_up"

export interface ThreadSendInput {
  readonly actor: User
  readonly thread: ThreadId
  readonly text: string
  readonly mode: ThreadSendMode
  readonly idempotencyKey: string
}

export interface ThreadSendOutcome {
  readonly thread: ThreadId
  readonly delivery: "sent" | "released" | "queued_offline"
  readonly queuedForNextStart: boolean
  readonly expiresAt: string | null
  readonly deduplicated: boolean
}

export async function sendThread(deps: ThreadListDeps, input: ThreadSendInput): Promise<ThreadSendOutcome> {
  const maxBytes = deps.limits.threadMessageMaxBytes
  if (new TextEncoder().encode(input.text).byteLength > maxBytes) {
    throw new ApiError("invalid_arguments", `text must be at most ${maxBytes} bytes`)
  }
  const snapshot = await threadFromGateway(deps, input.thread)
  const run = runForThread(deps, input.actor, input.thread)
  requireControl(snapshot, "send")
  if (input.mode === "steer" && snapshot.state !== "running") {
    throw new ControlsGatewayError("turn_conflict", "thread has no running turn to steer")
  }
  if (run !== null && snapshot.state !== "running") {
    const reopened = gatewayValue(await deps.gateway.create({
      name: run.name,
      cwd: run.cwd,
      ...(run.spec.model === undefined ? {} : { model: run.spec.model }),
      ...(run.spec.thinking === undefined ? {} : { reasoning: run.spec.thinking }),
      idempotencyKey: `${run.fireKey}:${run.attempt}`,
    }))
    if (reopened.thread !== input.thread) throw new ControlsGatewayError("internal", "reopened thread address changed")
    const host = gatewayValue(await deps.gateway.sessionState(input.thread))
    if (host.held) {
      gatewayValue(await deps.gateway.releaseHold(input.thread, input.text))
      audit(deps, {
        actor: input.actor,
        thread: input.thread,
        run,
        action: "send",
        detail: { mode: input.mode, delivery: "released" },
      })
      return {
        thread: input.thread,
        delivery: "released",
        queuedForNextStart: false,
        expiresAt: null,
        deduplicated: false,
      }
    }
  }
  const sent = gatewayValue(await deps.gateway.send({
    thread: input.thread,
    text: input.text,
    ...(input.mode === "follow_up" ? { mode: "follow_up" as const } : {}),
    idempotencyKey: input.idempotencyKey,
  }))
  const expiresAt = sent.delivered
    ? null
    : new Date(deps.clock.now() + deps.limits.threadQueueTtlMs).toISOString()
  const delivery = sent.delivered ? "sent" : "queued_offline"
  audit(deps, {
    actor: input.actor,
    thread: input.thread,
    run,
    action: "send",
    detail: { mode: input.mode, delivery },
  })
  return {
    thread: input.thread,
    delivery,
    queuedForNextStart: !sent.delivered,
    expiresAt,
    deduplicated: sent.deduplicated,
  }
}

export interface ThreadActionInput {
  readonly actor: User
  readonly thread: ThreadId
}

export async function interruptThread(
  deps: ThreadListDeps,
  input: ThreadActionInput,
): Promise<{ readonly interrupted: true }> {
  const snapshot = await threadFromGateway(deps, input.thread)
  const run = runForThread(deps, input.actor, input.thread)
  requireControl(snapshot, "interrupt")
  const result = await deps.gateway.interrupt({ thread: input.thread, allScope: true })
  if (result.kind === "error") throw new ControlsGatewayError(result.code, result.message)
  audit(deps, {
    actor: input.actor,
    thread: input.thread,
    run,
    action: "interrupt",
    detail: {},
  })
  return { interrupted: true }
}

export interface ThreadCloseInput extends ThreadActionInput {
  readonly graceful: boolean
  readonly waitMs: number
  readonly idempotencyKey: string | null
}

export async function closeThread(
  deps: ThreadListDeps,
  input: ThreadCloseInput,
): Promise<{ readonly closed: boolean; readonly reason: string }> {
  const snapshot = await threadFromGateway(deps, input.thread)
  const run = runForThread(deps, input.actor, input.thread)
  requireControl(snapshot, "close")
  const result = gatewayValue(await deps.gateway.close({
    thread: input.thread,
    graceful: input.graceful,
    waitMs: input.waitMs,
    ...(input.idempotencyKey === null ? {} : { idempotencyKey: input.idempotencyKey }),
  }))
  audit(deps, {
    actor: input.actor,
    thread: input.thread,
    run,
    action: "close",
    detail: { graceful: input.graceful, waitMs: input.waitMs, closed: result.closed },
  })
  return result
}

export interface ThreadModelInput extends ThreadActionInput {
  readonly model: string
  readonly provider?: string
}

export async function setThreadModel(
  deps: ThreadListDeps,
  input: ThreadModelInput,
): Promise<{ readonly updated: true }> {
  const snapshot = await threadFromGateway(deps, input.thread)
  const run = runForThread(deps, input.actor, input.thread)
  requireControl(snapshot, "set_model")
  const result = await deps.gateway.setModel({
    thread: input.thread,
    model: input.model,
    ...(input.provider === undefined ? {} : { provider: input.provider }),
  })
  if (result.kind === "error") throw new ControlsGatewayError(result.code, result.message)
  audit(deps, {
    actor: input.actor,
    thread: input.thread,
    run,
    action: "model",
    detail: { model: input.model, provider: input.provider ?? null },
  })
  return { updated: true }
}
