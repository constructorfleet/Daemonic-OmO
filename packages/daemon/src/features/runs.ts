import { join } from "node:path"

import type { FeatureContext } from "../api/context"
import { createRunEngine, RUNS, type RunEngine } from "../runs/engine"
import { runRoutes } from "../runs/routes"

export function register(ctx: FeatureContext): RunEngine {
  const engine = createRunEngine({
    db: ctx.db,
    repos: ctx.repos,
    clock: ctx.clock,
    rng: ctx.rng,
    gateway: ctx.gateway,
    git: ctx.git,
    fs: ctx.fs,
    config: ctx.config,
    worktreeRoot: join(ctx.home.home, "worktrees"),
  })
  ctx.services.provide(RUNS, engine)
  for (const route of runRoutes(ctx)) ctx.addRoute(route)
  engine.start()
  return engine
}
