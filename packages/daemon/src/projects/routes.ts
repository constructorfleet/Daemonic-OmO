import { scopeFor } from "../auth"
import type { FeatureContext } from "../api/context"
import { ApiError } from "../api/errors"
import { json, userRoute, type Route } from "../api/routes"
import { parseProjectCreate, parseProjectPatch } from "./request"
import { PROJECTS } from "./service"

export function projectRoutes(ctx: FeatureContext): readonly Route[] {
  const projects = () => ctx.services.require(PROJECTS)

  return [
    userRoute(ctx, {
      method: "GET",
      path: "/api/v1/projects",
      handle: async ({ principal, url }) => {
        const scope = scopeFor(principal.user, url.searchParams.get("userId"))
        const include = url.searchParams.get("include")
        if (include !== null && include !== "discovered") {
          throw new ApiError("invalid_arguments", "include must be discovered")
        }
        if (include === "discovered" && scope.kind !== "user") {
          throw new ApiError("invalid_arguments", "include=discovered needs a single-user scope")
        }
        // The discovered scan touches the filesystem, so the head is read first: a resume from it
        // can replay a concurrent change, but can never skip one.
        const headSeq = ctx.feed.head(scope)
        const items = scope.kind === "all"
          ? projects().listAll()
          : await projects().listFor(scope.userId, include === "discovered")
        return json({ items, headSeq })
      },
    }),

    userRoute(ctx, {
      method: "POST",
      path: "/api/v1/projects",
      handle: async ({ principal, body }) => json(await projects().create(principal.user, parseProjectCreate(body)), 201),
    }),

    userRoute(ctx, {
      method: "GET",
      path: "/api/v1/projects/:id",
      handle: ({ principal, params }) => json(projects().get(principal.user, params.id ?? "")),
    }),

    userRoute(ctx, {
      method: "PATCH",
      path: "/api/v1/projects/:id",
      handle: async ({ principal, params, body }) =>
        json(await projects().patch(principal.user, params.id ?? "", parseProjectPatch(body))),
    }),

    userRoute(ctx, {
      method: "DELETE",
      path: "/api/v1/projects/:id",
      handle: ({ principal, params }) => {
        projects().remove(principal.user, params.id ?? "")
        return new Response(null, { status: 204 })
      },
    }),

    userRoute(ctx, {
      method: "POST",
      path: "/api/v1/projects/:id/archive",
      handle: async ({ principal, params, url }) => {
        const force = url.searchParams.get("force")
        if (force !== null && force !== "true" && force !== "false") {
          throw new ApiError("invalid_arguments", "force must be true or false")
        }
        return json(await projects().archive(principal.user, params.id ?? "", force === "true"))
      },
    }),
  ]
}
