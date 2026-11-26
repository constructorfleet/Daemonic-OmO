// Full daemon on a temp home with FakeGateway, FakeClock and a mock OIDC
// provider, for Playwright and API tests. Run:
//   bun packages/daemon/test/support/e2e-server.ts [--fixtures <agent-dir tree>] [--port <n>]
// It prints one JSON line {ready, url, home, agentDir, issuer} once listening.
// With OMO_DAEMONIC_E2E=1 it also serves the /__test/* control routes.
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import type { Server } from "bun"
import { startServer, type FetchHandler } from "../../src/api/server"
import { createApp, type App } from "../../src/app"
import { loadConfig, systemRng } from "../../src/config"
import { isPlainObject } from "../../src/config/reader"
import { CLIENT_ID, MockIdp } from "../auth/harness"
import { FakeClock, FakeFs, FakeGateway, FakeGit } from "./fakes"
import { createE2eControlHandler } from "./e2e-control"

export interface E2eServerOptions {
  readonly fixtures?: string
  readonly port?: number
  /** Sections merged one level deep over the generated config.jsonc. */
  readonly config?: Readonly<Record<string, unknown>>
  readonly staticDir?: string | null
}

export interface E2eServer {
  readonly url: string
  readonly home: string
  readonly agentDir: string
  readonly breakglassToken: string
  readonly app: App
  readonly clock: FakeClock
  readonly gateway: FakeGateway
  readonly fs: FakeFs
  readonly git: FakeGit
  readonly idp: MockIdp
  stop(): Promise<void>
}

export const E2E_ADMIN_SUB = "e2e-admin"

function merge(base: Record<string, unknown>, overrides: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const merged = { ...base }
  for (const [key, value] of Object.entries(overrides)) {
    const current = merged[key]
    merged[key] = isPlainObject(current) && isPlainObject(value) ? { ...current, ...value } : value
  }
  return merged
}

export async function startE2eServer(options: E2eServerOptions = {}): Promise<E2eServer> {
  const home = await mkdtemp(join(tmpdir(), "omo-daemonic-e2e-"))
  const agentDir = join(home, "agent")
  const controlsEnabled = process.env.OMO_DAEMONIC_E2E === "1"
  let handler: FetchHandler | null = null
  let server: Server<undefined> | null = null
  let idp: MockIdp | null = null
  let app: App | null = null
  const cleanup = async (): Promise<void> => {
    app?.close()
    await server?.stop(true)
    await idp?.stop()
    await rm(home, { recursive: true, force: true })
  }
  try {
    if (options.fixtures === undefined) await mkdir(agentDir, { recursive: true })
    else await cp(resolve(options.fixtures), agentDir, { recursive: true })
    idp = await MockIdp.start()
    server = startServer(
      async (request, bunServer) => handler === null ? new Response("starting", { status: 503 }) : handler(request, bunServer),
      { host: "127.0.0.1", port: options.port ?? 0 },
    )
    const url = `http://127.0.0.1:${server.port}`
    const secretFile = join(home, "client.secret")
    await writeFile(secretFile, "e2e-client-secret\n", { mode: 0o600 })
    const generated = {
      listen: { host: "127.0.0.1", port: server.port },
      publicUrl: url,
      oidc: { issuer: idp.issuer, clientId: CLIENT_ID, clientSecretFile: secretFile },
      users: {
        allowSelfSignup: true,
        defaultAgentDirRoot: join(home, "agents"),
        bootstrapAdmin: { oidcSub: E2E_ADMIN_SUB, agentDir },
      },
    }
    await writeFile(join(home, "config.jsonc"), JSON.stringify(merge(generated, options.config ?? {}), null, 2))
    const loaded = await loadConfig({
      env: {},
      home,
      homeDir: home,
      resolveOmo: () => ({ bin: join(home, "omo", "bin", "omo"), pluginRoot: join(home, "omo", "plugin") }),
    })
    const clock = new FakeClock({ wallMs: Date.now() })
    const gateway = new FakeGateway()
    const fs = new FakeFs(agentDir)
    const git = new FakeGit()
    const created = await createApp({
      loaded,
      clock,
      rng: systemRng(),
      gateway,
      fs,
      git,
      ...(options.staticDir === undefined ? {} : { staticDir: options.staticDir }),
    })
    app = created
    const control = controlsEnabled ? createE2eControlHandler({ clock, gateway, agentDir, app: created }) : null
    handler = (request, bunServer) => control !== null && new URL(request.url).pathname.startsWith("/__test/")
      ? control(request)
      : created.fetch(request, bunServer)
    const started = idp
    return {
      url,
      home,
      agentDir,
      breakglassToken: loaded.secrets.breakglassToken,
      app: created,
      clock,
      gateway,
      fs,
      git,
      idp: started,
      stop: cleanup,
    }
  } catch (error) {
    await cleanup()
    throw error
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      fixtures: { type: "string" },
      port: { type: "string" },
      staticDir: { type: "string" },
      sub: { type: "string" },
    },
  })
  const port = values.port === undefined ? 0 : Number(values.port)
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new RangeError(`--port must be 0-65535, got ${values.port}`)
  const running = await startE2eServer({
    ...(values.fixtures === undefined ? {} : { fixtures: values.fixtures }),
    ...(values.staticDir === undefined ? {} : { staticDir: values.staticDir }),
    port,
  })
  running.idp.identity = {
    sub: values.sub ?? E2E_ADMIN_SUB,
    email: "e2e-admin@example.test",
    email_verified: true,
    name: "E2E Admin",
  }
  console.log(JSON.stringify({
    ready: true,
    url: running.url,
    home: running.home,
    agentDir: running.agentDir,
    issuer: running.idp.issuer,
  }))
  const shutdown = (): void => {
    running.stop().then(() => process.exit(0), (error: unknown) => {
      console.error("e2e-server: shutdown failed", error)
      process.exit(1)
    })
  }
  process.once("SIGINT", shutdown)
  process.once("SIGTERM", shutdown)
}
