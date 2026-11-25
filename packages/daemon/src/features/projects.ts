import type { FeatureContext } from "../api/context"
import { projectRoutes } from "../projects/routes"
import { createProjectsService, PROJECTS } from "../projects/service"
import { cancelRunsForArchive } from "../runs/archive"
import { RUNS } from "../runs/engine"

export function register(ctx: FeatureContext): void {
  const service = createProjectsService({
    repos: ctx.repos,
    clock: ctx.clock,
    rng: ctx.rng,
    config: ctx.config,
    git: ctx.git,
    cancelRuns: (actor, project) => cancelRunsForArchive(ctx.services.require(RUNS), actor, project),
  })
  ctx.services.provide(PROJECTS, service)
  for (const route of projectRoutes(ctx)) ctx.addRoute(route)
}
