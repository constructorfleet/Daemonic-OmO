import { scopeFor } from "../auth"
import type { FeatureContext } from "../api/context"
import { ApiError } from "../api/errors"
import { json, userRoute, type Route } from "../api/routes"
import { parseUlid } from "../core/ids"
import { LOOP_STATES, type Loop, type LoopId, type User } from "../core/types"
import { PROJECTS } from "../projects/service"
import { isSpawnHeld } from "../runs/spawn-hold"
import { LOOP_ENGINE } from "./engine"

function parseState(value: string | null): Loop["state"] | null {
  if (value === null) return null
  const state = LOOP_STATES.find((candidate) => candidate === value)
  if (state === undefined) throw new ApiError("invalid_arguments", `state must be one of ${LOOP_STATES.join(", ")}`)
  return state
}

export function loopRoutes(ctx: FeatureContext): readonly Route[] {
  const loops = () => ctx.services.require(LOOP_ENGINE)
  const projects = () => ctx.services.require(PROJECTS)

  function visibleLoop(actor: User, value: string): Loop {
    const id: LoopId | null = parseUlid(value)
    const loop = id === null ? null : loops().get(id)
    if (loop === null || (loop.userId !== actor.id && actor.role !== "admin")) {
      throw new ApiError("not_found", "loop not found")
    }
    return loop
  }

  return [
    userRoute(ctx, {
      method: "GET",
      path: "/api/v1/loops",
      handle: ({ principal, url }) => {
        const scope = scopeFor(principal.user, url.searchParams.get("userId"))
        const rawProjectId = url.searchParams.get("projectId")
        const projectId = rawProjectId === null ? undefined : parseUlid(rawProjectId)
        if (rawProjectId !== null && projectId === null) throw new ApiError("invalid_arguments", "projectId must be a project id")
        const state = parseState(url.searchParams.get("state"))
        return json(ctx.feed.list(scope, () => ({
          items: loops().list(projectId ?? undefined, state ?? undefined)
            .filter((loop) => scope.kind === "all" || loop.userId === scope.userId),
        })))
      },
    }),
    userRoute(ctx, {
      method: "POST",
      path: "/api/v1/projects/:id/loops",
      handle: async ({ principal, params, body }) => {
        const project = projects().get(principal.user, params.id ?? "")
        if (project.state !== "active") throw new ApiError("state_conflict", "project is archived", { projectId: project.id })
        if (isSpawnHeld(ctx.db, project.userId)) {
          throw new ApiError("state_conflict", "the kill switch holds new spawns until it is released", {
            reason: "spawn_hold",
            userId: project.userId,
          })
        }
        if (!await ctx.git.isRepo(project.cwd)) {
          throw new ApiError("invalid_arguments", "loops need a git project", { cwd: project.cwd })
        }
        const template = loops().parseTemplate(body, principal.user, project)
        return json(await loops().create({ actor: principal.user, project, template }), 201)
      },
    }),
    userRoute(ctx, {
      method: "GET",
      path: "/api/v1/loops/:id",
      handle: ({ principal, params }) => json(visibleLoop(principal.user, params.id ?? "")),
    }),
    userRoute(ctx, {
      method: "POST",
      path: "/api/v1/loops/:id/cancel",
      handle: async ({ principal, params }) =>
        json(await loops().cancel(principal.user, visibleLoop(principal.user, params.id ?? "").id)),
    }),
  ]
}
