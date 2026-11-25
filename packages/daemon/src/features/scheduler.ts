import type { FeatureContext } from "../api/context"
import { LOOP_LAUNCHER } from "../scheduler/fire"
import { scheduleRoutes } from "../scheduler/routes"
import { createScheduleService, SCHEDULES } from "../scheduler/service"
import { createScheduler, SCHEDULER } from "../scheduler/scheduler"
import { RUNS } from "../runs/engine"

export function register(ctx: FeatureContext): void {
  const scheduler = createScheduler({
    db: ctx.db,
    repos: ctx.repos,
    ledger: ctx.ledger,
    clock: ctx.clock,
    rng: ctx.rng,
    queueMinExpiryMs: ctx.config.defaults.queueMinExpiryMs,
    engine: () => ctx.services.require(RUNS),
    loops: () => ctx.services.get(LOOP_LAUNCHER),
    timing: {
      maxTickIntervalMs: ctx.config.limits.schedulerMaxTickIntervalMs,
      clockJumpMs: ctx.config.limits.schedulerClockJumpMs,
    },
  })
  const service = createScheduleService({
    db: ctx.db,
    repos: ctx.repos,
    ledger: ctx.ledger,
    clock: ctx.clock,
    rng: ctx.rng,
    config: ctx.config,
    scheduler,
    engine: () => ctx.services.require(RUNS),
  })
  ctx.services.provide(SCHEDULER, scheduler)
  ctx.services.provide(SCHEDULES, service)
  for (const route of scheduleRoutes(ctx)) ctx.addRoute(route)
  scheduler.start()
}
