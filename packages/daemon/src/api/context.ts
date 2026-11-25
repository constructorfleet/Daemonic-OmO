import type { AuthDeps } from "../auth"
import type { HomeLayout } from "../config"
import type { Fs, Gateway, Git } from "../core/ports"
import type { EventLedger } from "../db/ledger"
import type { EventFeed } from "./feed"
import type { Idempotency } from "./idempotency"
import type { Route } from "./routes"
import type { Services } from "./services"

/**
 * What `src/app.ts` passes to every `src/features/*.ts` module's
 * `register(ctx)`, called once per module in filename order. A feature
 * declares its parameter as this type (or any subset of it), adds routes with
 * `addRoute` (usually built with `userRoute(ctx, ...)`), and shares services
 * through `services` keys. Resolve another feature's service inside handlers,
 * not at register time, so filename order never matters.
 */
export interface FeatureContext extends AuthDeps {
  readonly home: HomeLayout
  readonly ledger: EventLedger
  readonly gateway: Gateway
  readonly fs: Fs
  readonly git: Git
  readonly services: Services
  readonly feed: EventFeed
  readonly idempotency: Idempotency
  addRoute(route: Route): void
}

export interface FeatureModule {
  register(ctx: FeatureContext): unknown
}
