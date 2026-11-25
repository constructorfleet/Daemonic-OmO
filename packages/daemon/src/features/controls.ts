import type { FeatureContext } from "../api/context"
import { ApiError } from "../api/errors"
import { json, userRoute, type Route } from "../api/routes"
import type { Repositories } from "../auth/types"
import { isPlainObject } from "../config/reader"
import { parseUlid, threadId } from "../core/ids"
import type { GatewayErrorCode, GatewayRefusal, ThreadSnapshot, ThreadState } from "../core/ports"
import type { Project, ProjectId, Run, User } from "../core/types"
import {
  closeThread,
  ControlsGatewayError,
  interruptThread,
  runsByThread,
  sendThread,
  setThreadModel,
  type ThreadListDeps,
  type ThreadSendMode,
} from "../runs/controls"

function parseThreadState(value: string | null): ThreadState | null {
  if (value === null) return null
  if (value === "running" || value === "idle" || value === "inactive") return value
  throw new ApiError("invalid_arguments", "state must be running, idle or inactive")
}

function parseProjectId(value: string | null): ProjectId | null {
  if (value === null) return null
  const parsed = parseUlid(value)
  if (parsed === null) throw new ApiError("invalid_arguments", "projectId must be a ULID")
  return parsed
}

function objectBody(body: unknown): Record<string, unknown> {
  if (!isPlainObject(body)) {
    throw new ApiError("invalid_arguments", "body must be a JSON object")
  }
  return body
}

function textValue(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  if (typeof value !== "string" || value.length === 0) {
    throw new ApiError("invalid_arguments", `${key} must be a non-empty string`)
  }
  return value
}

function sendMode(body: Record<string, unknown>): ThreadSendMode {
  const value = body.mode
  if (value === undefined || value === "auto") return "auto"
  if (value === "steer" || value === "follow_up") return value
  throw new ApiError("invalid_arguments", "mode must be auto, steer or follow_up")
}

interface ThreadListInput {
  readonly actor: User
  readonly projectId: ProjectId | null
  readonly state: ThreadState | null
}

function visibleProject(repos: Repositories, actor: User, projectId: ProjectId | null): Project | null {
  if (projectId === null) return null
  const project = repos.projects.get(projectId)
  if (project === null || (project.userId !== actor.id && actor.role !== "admin")) {
    throw new ApiError("not_found", "project not found")
  }
  return project
}

async function listThreads(
  deps: ThreadListDeps,
  input: ThreadListInput,
): Promise<readonly (ThreadSnapshot & { readonly runId?: string; readonly projectId?: string })[]> {
  const project = visibleProject(deps.repos, input.actor, input.projectId)
  const listed = await deps.gateway.list({ allScope: true })
  if (listed.kind === "error") throw new ControlsGatewayError(listed.code, listed.message)
  const links = runsByThread(input.actor, deps.repos)
  const allLinks = runsByThread({ ...input.actor, role: "admin" }, deps.repos)
  return listed.value.flatMap((thread) => {
    const owner = allLinks.get(thread.thread)
    if (owner !== undefined && input.actor.role !== "admin" && owner.userId !== input.actor.id) return []
    const run = links.get(thread.thread)
    if (input.state !== null && thread.state !== input.state) return []
    if (project !== null && thread.cwd !== project.cwd && run?.projectId !== project.id) return []
    return [{
      ...thread,
      ...(run === undefined ? {} : { runId: run.id, projectId: run.projectId }),
    }]
  })
}

function gatewayError(refusal: GatewayRefusal): Response {
  const { code, message } = refusal
  let status: number
  let apiCode: string
  let details: Record<string, string | number>
  switch (code) {
    case "not_found":
    case "not_resumable":
      status = 404
      apiCode = "not_found"
      details = {}
      break
    case "scope_denied":
      status = 403
      apiCode = "forbidden"
      details = { gatewayCode: code }
      break
    case "turn_conflict":
    case "loop_detected":
      status = 409
      apiCode = "state_conflict"
      details = { gatewayCode: code }
      break
    case "host_unavailable":
    case "sdk_unavailable":
    case "gateway_degraded":
    case "bridge_restarted":
    case "bridge_timeout":
      status = 503
      apiCode = code
      details = { retryAfterMs: 1_000 }
      break
    case "invalid_arguments":
      status = 400
      apiCode = code
      details = {}
      break
    case "caller_context_missing":
    case "unsupported":
      status = 403
      apiCode = "forbidden"
      details = { gatewayCode: code }
      break
    case "internal":
      status = 500
      apiCode = code
      details = {}
      break
    default:
      return assertNever(code)
  }
  return json({ error: { code: apiCode, message, details } }, status)
}

function assertNever(value: never): never {
  throw new Error(`unhandled gateway refusal: ${value}`)
}

async function controlResponse(run: () => Promise<unknown>, status = 200): Promise<Response> {
  try {
    return json(await run(), status)
  } catch (error) {
    if (error instanceof ControlsGatewayError) {
      return gatewayError({ kind: "error", code: error.code, message: error.message })
    }
    throw error
  }
}

export function register(ctx: FeatureContext): void {
  const deps = {
    gateway: ctx.gateway,
    repos: ctx.repos,
    clock: ctx.clock,
    rng: ctx.rng,
    limits: ctx.config.limits,
  }
  ctx.addRoute(userRoute(ctx, {
    method: "GET",
    path: "/api/v1/threads",
    handle: ({ principal, url }) => controlResponse(async () => {
      const headSeq = ctx.feed.head({ kind: "user", userId: principal.user.id })
      const items = await listThreads(deps, {
        actor: principal.user,
        projectId: parseProjectId(url.searchParams.get("projectId")),
        state: parseThreadState(url.searchParams.get("state")),
      })
      return { items, headSeq }
    }),
  }))

  const routes: readonly Route[] = [
    userRoute(ctx, {
      method: "POST",
      path: "/api/v1/threads/:thread/send",
      handle: ({ principal, params, body, request }) => controlResponse(async () => {
        const input = objectBody(body)
        const text = textValue(input, "text")
        const idempotencyKey = request.headers.get("idempotency-key")
        if (idempotencyKey === null) throw new ApiError("invalid_arguments", "send requires Idempotency-Key")
        return sendThread(deps, {
          actor: principal.user,
          thread: threadId(params.thread ?? ""),
          text,
          mode: sendMode(input),
          idempotencyKey,
        })
      }),
    }),
    userRoute(ctx, {
      method: "POST",
      path: "/api/v1/threads/:thread/interrupt",
      handle: ({ principal, params }) => controlResponse(() => interruptThread(deps, {
        actor: principal.user,
        thread: threadId(params.thread ?? ""),
      })),
    }),
    userRoute(ctx, {
      method: "POST",
      path: "/api/v1/threads/:thread/close",
      handle: ({ principal, params, body, request }) => controlResponse(() => {
        const input = objectBody(body)
        if (typeof input.graceful !== "boolean" ||
          typeof input.wait_ms !== "number" || !Number.isSafeInteger(input.wait_ms) || input.wait_ms < 0) {
          throw new ApiError("invalid_arguments", "body must contain graceful and non-negative integer wait_ms")
        }
        return closeThread(deps, {
          actor: principal.user,
          thread: threadId(params.thread ?? ""),
          graceful: input.graceful,
          waitMs: input.wait_ms,
          idempotencyKey: request.headers.get("idempotency-key"),
        })
      }),
    }),
    userRoute(ctx, {
      method: "POST",
      path: "/api/v1/threads/:thread/model",
      handle: ({ principal, params, body }) => controlResponse(() => {
        const input = objectBody(body)
        const model = textValue(input, "model")
        if (input.provider !== undefined && (typeof input.provider !== "string" || input.provider.length === 0)) {
          throw new ApiError("invalid_arguments", "provider must be a non-empty string")
        }
        return setThreadModel(deps, {
          actor: principal.user,
          thread: threadId(params.thread ?? ""),
          model,
          ...(typeof input.provider === "string" ? { provider: input.provider } : {}),
        })
      }),
    }),
  ]
  for (const route of routes) ctx.addRoute(route)
}
