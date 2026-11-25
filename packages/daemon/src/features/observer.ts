import type { FeatureContext } from "../api/context"
import { DOC_PROVIDER } from "../api/services"
import { ImageCache } from "../observer/images"
import { createObserver, type Observer } from "../observer/observer"
import { observerRoutes } from "../observer/routes"

export function register(ctx: FeatureContext): Observer {
  const { limits } = ctx.config
  const observer = createObserver({
    repos: ctx.repos,
    config: ctx.config,
    clock: ctx.clock,
    images: new ImageCache(limits.observerImageCacheBytes),
  })
  ctx.services.provide(DOC_PROVIDER, observer.provider)
  for (const route of observerRoutes(ctx, observer, limits.observerPageMaxTurns)) ctx.addRoute(route)
  return observer
}
