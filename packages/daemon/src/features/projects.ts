import type { FeatureContext } from "../api/context"
import { projectRoutes } from "../projects/routes"
import { createProjectsService, PROJECTS } from "../projects/service"

export function register(ctx: FeatureContext): void {
  const service = createProjectsService({
    repos: ctx.repos,
    clock: ctx.clock,
    rng: ctx.rng,
    config: ctx.config,
    git: ctx.git,
  })
  ctx.services.provide(PROJECTS, service)
  for (const route of projectRoutes(ctx)) ctx.addRoute(route)
}
