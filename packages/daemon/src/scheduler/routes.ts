import { scopeFor } from "../auth"
import type { FeatureContext } from "../api/context"
import { ApiError } from "../api/errors"
import { json, userRoute, type Route } from "../api/routes"
import { parseUlid } from "../core/ids"
import type { Project, Schedule, ScheduleId, User } from "../core/types"
import { PROJECTS } from "../projects/service"
import { LOOP_LAUNCHER } from "./fire"
import { parsePreviewCount, parseScheduleCreate, parseSchedulePatch } from "./request"
import { ScheduleStateError, SCHEDULES } from "./service"

function stateConflict(error: ScheduleStateError): ApiError {
  return new ApiError("state_conflict", `schedule cannot ${error.conflict}`, {
    scheduleId: error.scheduleId,
    reason: error.conflict,
  })
}

export function scheduleRoutes(ctx: FeatureContext): readonly Route[] {
  const schedules = () => ctx.services.require(SCHEDULES)
  const projects = () => ctx.services.require(PROJECTS)
  const visibleProject = (actor: User, rawId: string): Project => projects().get(actor, rawId)

  function visibleSchedule(actor: User, rawId: string): Schedule {
    const id: ScheduleId | null = parseUlid(rawId)
    const schedule = id === null ? null : schedules().get(id)
    if (schedule === null || (schedule.userId !== actor.id && actor.role !== "admin")) {
      throw new ApiError("not_found", "schedule not found")
    }
    return schedule
  }

  function parseContext(project: Project) {
    const owner = ctx.repos.users.get(project.userId)
    return {
      now: ctx.clock.now(),
      maxTimeoutMs: ctx.config.hardCaps.runTimeoutMs,
      defaultTimeoutMs: Math.min(owner?.settings.runTimeoutMs ?? ctx.config.defaults.runTimeoutMs, ctx.config.hardCaps.runTimeoutMs),
      ...(project.settings.defaultModel === undefined ? {} : { defaultModel: project.settings.defaultModel }),
      ...(project.settings.defaultReasoning === undefined ? {} : { defaultReasoning: project.settings.defaultReasoning }),
      loops: ctx.services.get(LOOP_LAUNCHER),
    }
  }

  return [
    userRoute(ctx, {
      method: "GET",
      path: "/api/v1/projects/:id/schedules",
      handle: ({ principal, params, url }) => {
        const project = visibleProject(principal.user, params.id ?? "")
        const scope = scopeFor(principal.user, url.searchParams.get("userId"))
        if (scope.kind === "user" && scope.userId !== project.userId) throw new ApiError("not_found", "project not found")
        return json(ctx.feed.list(scope, () => ({ items: schedules().listByProject(project.id) })))
      },
    }),

    userRoute(ctx, {
      method: "POST",
      path: "/api/v1/projects/:id/schedules",
      handle: async ({ principal, params, body }) => {
        const project = visibleProject(principal.user, params.id ?? "")
        if (project.state !== "active") throw new ApiError("state_conflict", "project is archived", { projectId: project.id })
        if (!await ctx.git.isRepo(project.cwd)) {
          throw new ApiError("invalid_arguments", "schedules need a git project", { cwd: project.cwd })
        }
        try {
          return json(schedules().create(project, parseScheduleCreate(body, parseContext(project))), 201)
        } catch (error) {
          if (error instanceof ScheduleStateError) throw stateConflict(error)
          throw error
        }
      },
    }),

    userRoute(ctx, {
      method: "GET",
      path: "/api/v1/schedules/:id",
      handle: ({ principal, params }) => json(visibleSchedule(principal.user, params.id ?? "")),
    }),

    userRoute(ctx, {
      method: "PATCH",
      path: "/api/v1/schedules/:id",
      handle: ({ principal, params, body }) => {
        const schedule = visibleSchedule(principal.user, params.id ?? "")
        const project = visibleProject(principal.user, schedule.projectId)
        try {
          return json(schedules().patch(schedule, parseSchedulePatch(body, parseContext(project))))
        } catch (error) {
          if (error instanceof ScheduleStateError) throw stateConflict(error)
          throw error
        }
      },
    }),

    userRoute(ctx, {
      method: "DELETE",
      path: "/api/v1/schedules/:id",
      handle: async ({ principal, params, url }) => {
        const cancelRuns = url.searchParams.get("cancelRuns")
        if (cancelRuns !== null && cancelRuns !== "true" && cancelRuns !== "false") {
          throw new ApiError("invalid_arguments", "cancelRuns must be true or false")
        }
        await schedules().remove(principal.user, visibleSchedule(principal.user, params.id ?? ""), cancelRuns === "true")
        return new Response(null, { status: 204 })
      },
    }),

    userRoute(ctx, {
      method: "POST",
      path: "/api/v1/schedules/:id/pause",
      handle: ({ principal, params }) => {
        try {
          return json(schedules().pause(visibleSchedule(principal.user, params.id ?? "")))
        } catch (error) {
          if (error instanceof ScheduleStateError) throw stateConflict(error)
          throw error
        }
      },
    }),

    userRoute(ctx, {
      method: "POST",
      path: "/api/v1/schedules/:id/resume",
      handle: ({ principal, params }) => {
        try {
          return json(schedules().resume(visibleSchedule(principal.user, params.id ?? "")))
        } catch (error) {
          if (error instanceof ScheduleStateError) throw stateConflict(error)
          throw error
        }
      },
    }),

    userRoute(ctx, {
      method: "POST",
      path: "/api/v1/schedules/:id/fire",
      handle: async ({ principal, params }) => json(await schedules().fire(visibleSchedule(principal.user, params.id ?? "")), 201),
    }),

    userRoute(ctx, {
      method: "GET",
      path: "/api/v1/schedules/:id/preview",
      handle: ({ principal, params, url }) => {
        const schedule = visibleSchedule(principal.user, params.id ?? "")
        return json({
          items: schedules().preview(
            schedule,
            parsePreviewCount(url.searchParams.get("count"), ctx.config.limits.schedulePreviewMaxCount),
          ),
        })
      },
    }),
  ]
}
