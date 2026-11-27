import { join } from "node:path"

import type { FeatureContext } from "../api/context"
import { LOOP_LAUNCHER } from "../scheduler/fire"
import { createLoopEngine, LOOP_ENGINE } from "../loops/engine"
import { loopRoutes } from "../loops/routes"
import { RUNS } from "../runs/engine"

export function register(ctx: FeatureContext): void {
  const loops = createLoopEngine({
    db: ctx.db,
    repos: ctx.repos,
    clock: ctx.clock,
    rng: ctx.rng,
    git: ctx.git,
    fs: ctx.fs,
    config: ctx.config,
    worktreeRoot: join(ctx.home.home, "worktrees"),
    engine: () => ctx.services.require(RUNS),
  })
  ctx.services.provide(LOOP_ENGINE, loops)
  ctx.services.provide(LOOP_LAUNCHER, loops)
  for (const route of loopRoutes(ctx)) ctx.addRoute(route)
}
