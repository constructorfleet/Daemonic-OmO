// Full daemon on a temp home with FakeGateway, FakeClock and a mock OIDC
// provider, for Playwright and API tests. Run:
//   bun packages/daemon/test/support/e2e-server.ts [--fixtures <agent-dir tree>] [--port <n>]
// It prints one JSON line {ready, url, home, agentDir, issuer} once listening.
// With OMO_DAEMONIC_E2E=1 it also serves the /__test/* control routes.
import { appendFile, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve, sep } from "node:path"
import { parseArgs } from "node:util"
import type { Server } from "bun"
import { ApiError, knownErrorResponse } from "../../src/api/errors"
import { json, Router } from "../../src/api/routes"
import { startServer, type FetchHandler } from "../../src/api/server"
import { createApp, type App } from "../../src/app"
import { loadConfig, systemRng } from "../../src/config"
import { isPlainObject } from "../../src/config/reader"
import { threadId } from "../../src/core/ids"
import type { ThreadState } from "../../src/core/ports"
import { CLIENT_ID, MockIdp } from "../auth/harness"
import { FakeClock, FakeFs, FakeGateway, FakeGit } from "./fakes"

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
const THREAD_STATES: readonly ThreadState[] = ["running", "idle", "inactive"]

function merge(base: Record<string, unknown>, overrides: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const merged = { ...base }
  for (const [key, value] of Object.entries(overrides)) {
    const current = merged[key]
    merged[key] = isPlainObject(current) && isPlainObject(value) ? { ...current, ...value } : value
  }
  return merged
}

function bodyRecord(body: unknown): Record<string, unknown> {
  if (!isPlainObject(body)) throw new ApiError("invalid_arguments", "body must be a JSON object")
  return body
}

function controlRouter(target: { clock: FakeClock; gateway: FakeGateway; agentDir: string }): Router {
  const router = new Router()
  const read = async (request: Request): Promise<Record<string, unknown>> => bodyRecord(await request.json())
  router.add({
    method: "POST",
    path: "/__test/clock/advance",
    handle: async (request) => {
      const { ms } = await read(request)
      if (typeof ms !== "number" || !Number.isSafeInteger(ms) || ms < 0) {
        throw new ApiError("invalid_arguments", "ms must be a non-negative integer")
      }
      target.clock.advance(ms)
      return json({ now: target.clock.now() })
    },
  })
  router.add({
    method: "POST",
    path: "/__test/gateway/threads",
    handle: async (request) => {
      const { name, cwd } = await read(request)
      const thread = target.gateway.seedThread({
        ...(typeof name === "string" ? { name } : {}),
        ...(typeof cwd === "string" ? { cwd } : {}),
      })
      return json({ thread }, 201)
    },
  })
  router.add({
    method: "POST",
    path: "/__test/gateway/threads/:thread/state",
    handle: async (request, _peer, params) => {
      const { state } = await read(request)
      const parsed = THREAD_STATES.find((candidate) => candidate === state)
      if (parsed === undefined) throw new ApiError("invalid_arguments", `state must be one of ${THREAD_STATES.join(", ")}`)
      target.gateway.setThreadState(threadId(params.thread ?? ""), parsed)
      return new Response(null, { status: 204 })
    },
  })
  router.add({
    method: "POST",
    path: "/__test/fixtures/append",
    handle: async (request) => {
      const { path, line } = await read(request)
      if (typeof path !== "string" || typeof line !== "string") {
        throw new ApiError("invalid_arguments", "body must be {path, line}")
      }
      const file = resolve(target.agentDir, path)
      if (!file.startsWith(target.agentDir + sep)) throw new ApiError("invalid_arguments", "path must stay inside the fixture tree")
      await mkdir(dirname(file), { recursive: true })
      await appendFile(file, `${line}\n`)
      return new Response(null, { status: 204 })
    },
  })
  return router
}

function controlHandler(router: Router): (request: Request) => Promise<Response> {
  return async (request) => {
    try {
      const matched = router.match(request.method, new URL(request.url).pathname)
      if (matched === null) throw new ApiError("not_found", "unknown control route")
      return await matched.route.handle(request, "", matched.params)
    } catch (error) {
      const known = knownErrorResponse(error)
      if (known === null) throw error
      return known
    }
  }
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
    const control = controlsEnabled ? controlHandler(controlRouter({ clock, gateway, agentDir })) : null
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
  const { values } = parseArgs({ args: Bun.argv.slice(2), options: { fixtures: { type: "string" }, port: { type: "string" } } })
  const port = values.port === undefined ? 0 : Number(values.port)
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new RangeError(`--port must be 0-65535, got ${values.port}`)
  const running = await startE2eServer({ ...(values.fixtures === undefined ? {} : { fixtures: values.fixtures }), port })
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
