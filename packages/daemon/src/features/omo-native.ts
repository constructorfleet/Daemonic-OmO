import type { FeatureContext } from "../api/context"
import { dagRoutes } from "../omo-native/dag-routes"
import { scheduleRoutes } from "../omo-native/schedule-routes"

export function register(ctx: FeatureContext): void {
  for (const route of [...scheduleRoutes(ctx), ...dagRoutes(ctx)]) ctx.addRoute(route)
}
