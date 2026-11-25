import { scopeFor } from "../auth"
import type { FeatureContext } from "../api/context"
import { ApiError } from "../api/errors"
import { json, userRoute, type Route } from "../api/routes"
import { parseUlid } from "../core/ids"
import type { AuditEntry, Run, RunSpec, User, UserId } from "../core/types"
import { PROJECTS } from "../projects/service"
import { RUNS, RunStateError, type RunWorkspace } from "./engine"
import { engageKillSwitch, releaseKillSwitch } from "./kill-switch"
import { createRunRecords } from "./records"
import { parseKillSwitchTarget, parseLimit, parseRunCreate, parseRunState } from "./request"
import { isSpawnHeld } from "./spawn-hold"

const LIST_DEFAULT_LIMIT = 100
const LIST_MAX_LIMIT = 1_000

function degraded(detail: string): Response {
  return Response.json(
    { error: { code: "gateway_degraded", message: "the omo thread SDK cannot load; spawning is disabled", details: { detail } } },
    { status: 503, headers: { "cache-control": "no-store" } },
  )
}

function spawnHeld(userId: UserId): ApiError {
  return new ApiError("state_conflict", "the kill switch holds new spawns until it is released", { reason: "spawn_hold", userId })
}

export function runRoutes(ctx: FeatureContext): readonly Route[] {
  const engine = () => ctx.services.require(RUNS)
  const projects = () => ctx.services.require(PROJECTS)
  const records = createRunRecords(ctx.db, ctx.repos, ctx.clock)
  const killSwitchDeps = () => ({ db: ctx.db, repos: ctx.repos, clock: ctx.clock, rng: ctx.rng, engine: engine() })

  function visibleRun(actor: User, rawId: string): Run {
    const id = parseUlid(rawId)
    const run = id === null ? null : records.get(id)
    if (run === null || (run.userId !== actor.id && actor.role !== "admin")) throw new ApiError("not_found", "run not found")
    return run
  }

  function killTargets(actor: User, requested: string | null): readonly UserId[] {
    if (requested === null || requested === actor.id) return [actor.id]
    if (actor.role !== "admin") throw new ApiError("forbidden", "members can only stop their own runs")
    if (requested === "all") {
      return ctx.db.query<{ readonly id: string }, []>("SELECT id FROM users ORDER BY id").all().flatMap(({ id }) => {
        const parsed = parseUlid(id)
        return parsed === null ? [] : [parsed]
      })
    }
    const userId = parseUlid(requested)
    if (userId === null || ctx.repos.users.get(userId) === null) throw new ApiError("not_found", "user not found")
    return [userId]
  }

  function auditPage(scope: ReturnType<typeof scopeFor>, limit: number): readonly AuditEntry[] {
    if (scope.kind === "user") return ctx.repos.audit.listByUser(scope.userId, limit)
    return ctx.db.query<{ readonly id: string }, [number]>("SELECT id FROM audit ORDER BY at DESC, id LIMIT ?").all(limit).flatMap(({ id }) => {
      const parsed = parseUlid(id)
      const entry = parsed === null ? null : ctx.repos.audit.get(parsed)
      return entry === null ? [] : [entry]
    })
  }

  return [
    userRoute(ctx, {
      method: "POST",
      path: "/api/v1/projects/:id/runs",
      handle: async ({ principal, params, body }) => {
        const project = projects().get(principal.user, params.id ?? "")
        const input = parseRunCreate(body, ctx.config.hardCaps.runTimeoutMs)
        if (project.state !== "active") throw new ApiError("state_conflict", "project is archived", { projectId: project.id })
        const owner = ctx.repos.users.get(project.userId)
        const worktree = input.worktree ?? project.settings.worktreeForAdhoc
        if (worktree && !await ctx.git.isRepo(project.cwd)) {
          throw new ApiError("invalid_arguments", "worktree runs need a git project", { cwd: project.cwd })
        }
        const model = input.model ?? project.settings.defaultModel
        const thinking = input.reasoning ?? project.settings.defaultReasoning
        const spec: RunSpec = {
          prompt: input.prompt,
          timeoutMs: input.timeoutMs ?? Math.min(owner?.settings.runTimeoutMs ?? ctx.config.defaults.runTimeoutMs, ctx.config.hardCaps.runTimeoutMs),
          ...(model === undefined ? {} : { model }),
          ...(thinking === undefined ? {} : { thinking }),
        }
        const workspace: RunWorkspace = worktree ? { kind: "run_worktree", name: project.name } : { kind: "checkout" }
        const result = await engine().spawn({ project, spec, workspace, trigger: { kind: "adhoc", actor: principal.user.id } })
        switch (result.kind) {
          case "queued":
            return json(result.run, 201)
          case "held":
            throw spawnHeld(project.userId)
          case "degraded":
            return degraded(result.detail)
          default:
            throw new TypeError(`unexpected spawn result: ${JSON.stringify(result)}`)
        }
      },
    }),

    userRoute(ctx, {
      method: "GET",
      path: "/api/v1/runs",
      handle: ({ principal, url }) => {
        const scope = scopeFor(principal.user, url.searchParams.get("userId"))
        const rawProject = url.searchParams.get("projectId")
        const projectId = rawProject === null ? null : parseUlid(rawProject)
        if (rawProject !== null && projectId === null) throw new ApiError("invalid_arguments", "projectId must be a project id")
        const filter = {
          userId: scope.kind === "user" ? scope.userId : null,
          projectId,
          state: parseRunState(url.searchParams.get("state")),
          limit: parseLimit(url.searchParams.get("limit"), LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT),
        }
        return json(ctx.feed.list(scope, () => ({ items: records.list(filter) })))
      },
    }),

    userRoute(ctx, {
      method: "GET",
      path: "/api/v1/runs/:id",
      handle: ({ principal, params }) => json(visibleRun(principal.user, params.id ?? "")),
    }),

    userRoute(ctx, {
      method: "POST",
      path: "/api/v1/runs/:id/cancel",
      handle: async ({ principal, params }) => {
        const run = visibleRun(principal.user, params.id ?? "")
        return json(await engine().cancel(principal.user, run.id, "user"))
      },
    }),

    userRoute(ctx, {
      method: "POST",
      path: "/api/v1/runs/:id/retry",
      handle: ({ principal, params }) => {
        const run = visibleRun(principal.user, params.id ?? "")
        if (isSpawnHeld(ctx.db, run.userId)) throw spawnHeld(run.userId)
        try {
          return json(engine().retry(principal.user, run), 201)
        } catch (error) {
          if (error instanceof RunStateError) throw new ApiError("state_conflict", error.message, { runId: error.runId })
          throw error
        }
      },
    }),

    userRoute(ctx, {
      method: "POST",
      path: "/api/v1/kill-switch",
      handle: async ({ principal, body }) =>
        json(await engageKillSwitch(killSwitchDeps(), principal.user, killTargets(principal.user, parseKillSwitchTarget(body)))),
    }),

    userRoute(ctx, {
      method: "POST",
      path: "/api/v1/kill-switch/release",
      handle: ({ principal, body }) =>
        json(releaseKillSwitch(killSwitchDeps(), principal.user, killTargets(principal.user, parseKillSwitchTarget(body)))),
    }),

    userRoute(ctx, {
      method: "GET",
      path: "/api/v1/audit",
      handle: ({ principal, url }) => {
        const scope = scopeFor(principal.user, url.searchParams.get("userId"))
        const limit = parseLimit(url.searchParams.get("limit"), LIST_DEFAULT_LIMIT, LIST_MAX_LIMIT)
        return json({ items: auditPage(scope, limit), headSeq: ctx.feed.head(scope) })
      },
    }),
  ]
}
