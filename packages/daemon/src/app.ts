import { fileURLToPath } from "node:url"
import { join } from "node:path"
import type { FeatureContext, FeatureModule } from "./api/context"
import { coreRoutes } from "./api/core-routes"
import { createEventFeed } from "./api/feed"
import { createIdempotency } from "./api/idempotency"
import { Router } from "./api/routes"
import { createHttpHandler, type FetchHandler } from "./api/server"
import { GUARD, Services } from "./api/services"
import { createStreamHub, type StreamHub } from "./api/sse"
import type { LoadedConfig } from "./config"
import { isPlainObject } from "./config/reader"
import { ulid } from "./core/ids"
import type { Clock, Fs, Gateway, Git, Rng } from "./core/ports"
import { openDb } from "./db/db"
import { EventLedger } from "./db/ledger"
import { migrate } from "./db/migrations"
import { createRepositories } from "./db/repos"

const FEATURES_DIR = fileURLToPath(new URL("./features", import.meta.url))
const DEFAULT_STATIC_DIR = fileURLToPath(new URL("../../web/dist", import.meta.url))
const PACKAGE_JSON = new URL("../package.json", import.meta.url)

export interface AppOptions {
  readonly loaded: LoadedConfig
  readonly clock: Clock
  readonly rng: Rng
  readonly gateway: Gateway
  readonly fs: Fs
  readonly git: Git
  readonly staticDir?: string | null
}

export interface App {
  readonly ctx: FeatureContext
  readonly hub: StreamHub
  /** Fresh per start, so clients can tell a restarted daemon apart. */
  readonly incarnation: string
  readonly fetch: FetchHandler
  close(): void
}

export class FeatureLoadError extends Error {
  readonly name = "FeatureLoadError"

  constructor(readonly file: string) {
    super(`feature module ${file} does not export register(ctx)`)
  }
}

function isFeatureModule(value: unknown): value is FeatureModule {
  return typeof value === "object" && value !== null && "register" in value && typeof value.register === "function"
}

async function packageVersion(): Promise<string> {
  const manifest: unknown = await Bun.file(PACKAGE_JSON).json()
  if (!isPlainObject(manifest) || typeof manifest.version !== "string") {
    throw new TypeError("packages/daemon/package.json has no version")
  }
  return manifest.version
}

async function registerFeatures(ctx: FeatureContext): Promise<void> {
  const files = [...new Bun.Glob("*.ts").scanSync({ cwd: FEATURES_DIR })].sort()
  for (const file of files) {
    const module: unknown = await import(join(FEATURES_DIR, file))
    if (!isFeatureModule(module)) throw new FeatureLoadError(file)
    await module.register(ctx)
  }
}

export async function createApp(options: AppOptions): Promise<App> {
  const { loaded, clock, rng } = options
  const db = openDb(loaded.home.databaseFile)
  try {
    migrate(db)
    const incarnation = ulid(rng, clock.now())
    db.query("UPDATE meta SET value = ? WHERE key = 'incarnation'").run(incarnation)
    const ledger = new EventLedger(db)
    const repos = createRepositories(db, ledger)
    const services = new Services()
    const router = new Router()
    const ctx: FeatureContext = {
      config: loaded.config,
      secrets: loaded.secrets,
      home: loaded.home,
      db,
      repos,
      ledger,
      clock,
      rng,
      gateway: options.gateway,
      fs: options.fs,
      git: options.git,
      services,
      feed: createEventFeed(db, ledger),
      idempotency: createIdempotency({ repository: repos.idempotency, clock, ttlMs: loaded.config.limits.idempotencyTtlMs }),
      addRoute: (route) => router.add(route),
    }
    const hub = createStreamHub({
      feed: ctx.feed,
      ledger,
      clock,
      rng,
      services,
      maxFrames: loaded.config.limits.sseSubscriberMaxFrames,
      maxBytes: loaded.config.limits.sseSubscriberMaxBytes,
      incarnation,
    })
    for (const route of coreRoutes({ ctx, hub, version: await packageVersion(), incarnation })) router.add(route)
    await registerFeatures(ctx)
    services.require(GUARD)
    const staticDir = options.staticDir === undefined ? DEFAULT_STATIC_DIR : options.staticDir
    return {
      ctx,
      hub,
      incarnation,
      fetch: createHttpHandler({ router, services, staticDir }),
      close() {
        hub.closeAll()
        db.close()
      },
    }
  } catch (error) {
    db.close()
    throw error
  }
}
