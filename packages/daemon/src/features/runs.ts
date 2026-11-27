import { join } from "node:path"

import type { FeatureContext } from "../api/context"
import { createRunEngine, RUNS, type RunEngine } from "../runs/engine"
import { runRoutes } from "../runs/routes"
import { LOOP_ENGINE } from "../loops/engine"

export async function register(ctx: FeatureContext): Promise<RunEngine> {
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
    dispatchEnabled: false,
  })
  const loops = ctx.services.get(LOOP_ENGINE)
  if (loops !== undefined) engine.setEvaluator((run) => loops.settled(run))
  ctx.services.provide(RUNS, engine)
  for (const route of runRoutes(ctx)) ctx.addRoute(route)
  await loops?.recover()
  await engine.recover()
  await loops?.recover()
  await loops?.tick(ctx.clock.now())
  engine.start()
  return engine
}
