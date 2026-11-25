import type { Database } from "bun:sqlite"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OAuth2Server } from "oauth2-mock-server"
import { errorResponse, AuthError } from "../../src/auth/http"
import type { Auth } from "../../src/auth"
import type { Config } from "../../src/config"
import { validateConfig } from "../../src/config/validate"
import { ulid } from "../../src/core/ids"
import type { User } from "../../src/core/types"
import { openDb } from "../../src/db/db"
import { migrate } from "../../src/db/migrations"
import { createRepositories } from "../../src/db/repos"
import { register, type AuthRoute } from "../../src/features/auth"
import { FakeClock, SeededRng } from "../support/fakes"

export const BREAKGLASS_TOKEN = "b".repeat(64)
export const SESSION_KEY = "5e".repeat(32)
// oauth2-mock-server copies the form-encoded Basic username into `aud` without
// decoding it (RFC 6749 2.3.1), so the test client id stays alphanumeric.
export const CLIENT_ID = "omodaemonictest"

export interface Identity {
  readonly sub: string
  readonly email?: string
  readonly email_verified?: boolean
  readonly name?: string
  readonly groups?: readonly string[]
  readonly nonce?: string
}

export class MockIdp {
  identity: Identity = { sub: "johndoe" }

  private constructor(readonly server: OAuth2Server) {}

  static async start(): Promise<MockIdp> {
    const server = new OAuth2Server()
    await server.issuer.keys.generate("RS256")
    await server.start(0, "127.0.0.1")
    const idp = new MockIdp(server)
    server.service.on("beforeTokenSigning", (token: { payload: Record<string, unknown> }) => {
      Object.assign(token.payload, idp.identity)
    })
    return idp
  }

  get issuer(): string {
    const url = this.server.issuer.url
    if (url === undefined) throw new Error("mock issuer is not listening")
    return url
  }

  async stop(): Promise<void> {
    await this.server.stop()
  }
}

export interface HarnessOptions {
  readonly users?: Record<string, unknown>
  readonly oidc?: Record<string, unknown>
  readonly trustedProxies?: readonly string[]
  readonly publicUrl?: string
}

export interface LoginResult {
  readonly callback: Response
  readonly cookie: string | null
}

const PROBE_PATH = "/api/v1/probe"

/**
 * In-test Bun.serve that mounts only the auth feature routes, the guard and a
 * guarded probe route standing in for todo 11's API.
 */
export class AuthHarness {
  private constructor(
    readonly clock: FakeClock,
    readonly server: ReturnType<typeof Bun.serve>,
    readonly origin: string,
    readonly config: Config,
    readonly db: Database,
    readonly repos: ReturnType<typeof createRepositories>,
    readonly auth: Auth,
    private readonly home: string,
  ) {}

  static async start(idp: MockIdp | null, options: HarnessOptions = {}): Promise<AuthHarness> {
    const routes: AuthRoute[] = []
    let ready: AuthHarness | null = null
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request, bunServer) => {
        if (ready === null) return new Response("starting", { status: 503 })
        const peer = bunServer.requestIP(request)?.address ?? ""
        return ready.dispatch(routes, request, peer)
      },
    })
    const origin = `http://127.0.0.1:${server.port}`
    const home = await mkdtemp(join(tmpdir(), "omo-daemonic-auth-"))
    const secretFile = join(home, "client.secret")
    await writeFile(secretFile, "test-client-secret\n", { mode: 0o600 })
    const config = validateConfig(
      {
        listen: { host: "127.0.0.1", port: server.port },
        publicUrl: options.publicUrl ?? origin,
        trustedProxies: options.trustedProxies ?? [],
        users: { defaultAgentDirRoot: join(home, "agents"), ...options.users },
        ...(idp === null
          ? {}
          : { oidc: { issuer: idp.issuer, clientId: CLIENT_ID, clientSecretFile: secretFile, ...options.oidc } }),
      },
      { home, homeDir: home, omo: { bin: "/opt/omo/bin/omo", pluginRoot: "/opt/omo-ai/plugin" } },
    )
    const db = openDb(":memory:")
    migrate(db)
    const repos = createRepositories(db)
    const clock = new FakeClock({ wallMs: Date.now() })
    const auth = await register({
      config,
      secrets: { breakglassToken: BREAKGLASS_TOKEN, sessionKey: SESSION_KEY },
      db,
      repos,
      clock,
      rng: new SeededRng(10),
      addRoute: (route: AuthRoute) => routes.push(route),
    })
    ready = new AuthHarness(clock, server, origin, config, db, repos, auth, home)
    return ready
  }

  private async dispatch(routes: readonly AuthRoute[], request: Request, peer: string): Promise<Response> {
    const url = new URL(request.url)
    const route = routes.find((entry) => entry.method === request.method && entry.path === url.pathname)
    if (route !== undefined) return route.handle(request, peer)
    if (url.pathname !== PROBE_PATH) return new Response("not found", { status: 404 })
    try {
      const principal = this.auth.guard.authenticate(request, peer)
      return Response.json({ userId: principal.user.id, kind: principal.kind })
    } catch (error) {
      if (error instanceof AuthError) return errorResponse(error)
      throw error
    }
  }

  private readonly idRng = new SeededRng(99)

  provision(issuer: string, sub: string): User {
    const at = new Date(this.clock.now()).toISOString()
    const user: User = {
      id: ulid(this.idRng, this.clock.now()),
      oidcIssuer: issuer,
      oidcSub: sub,
      email: `${sub}@example.test`,
      name: sub,
      role: "member",
      agentDir: `/agents/${sub}`,
      allowedRoots: ["/work"],
      settings: {},
      createdAt: at,
      updatedAt: at,
      lastLoginAt: null,
    }
    this.repos.users.put(user)
    return user
  }

  async breakglassMe(): Promise<Record<string, unknown>> {
    const response = await this.fetch("/api/v1/me", { headers: { authorization: `Bearer ${BREAKGLASS_TOKEN}` } })
    const body: unknown = await response.json()
    if (response.status !== 200 || !isRecord(body)) throw new Error(`break-glass /me failed: ${response.status}`)
    return body
  }

  url(path: string): string {
    return `${this.origin}${path}`
  }

  fetch(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(this.url(path), { redirect: "manual", ...init })
  }

  async login(idp: MockIdp, identity: Identity, tamper: (callback: URL) => void = () => {}): Promise<LoginResult> {
    idp.identity = identity
    const start = await this.fetch("/auth/login")
    const loginCookie = cookiePair(start, "omod_login")
    const authorize = await fetch(requiredLocation(start), { redirect: "manual" })
    const callbackUrl = new URL(requiredLocation(authorize))
    tamper(callbackUrl)
    const callback = await fetch(callbackUrl, {
      redirect: "manual",
      headers: loginCookie === null ? {} : { cookie: loginCookie },
    })
    return { callback, cookie: cookiePair(callback, "omod_session") }
  }

  async session(idp: MockIdp, identity: Identity): Promise<{ cookie: string; csrf: string }> {
    const { cookie } = await this.login(idp, identity)
    if (cookie === null) throw new Error(`login for ${identity.sub} set no session cookie`)
    const me = await this.fetch("/api/v1/me", { headers: { cookie } })
    const body: unknown = await me.json()
    const csrf = isRecord(body) && typeof body.csrfToken === "string" ? body.csrfToken : null
    if (csrf === null) throw new Error(`/api/v1/me returned no csrf token for ${identity.sub}`)
    return { cookie, csrf }
  }

  mutation(cookie: string, csrf: string | null, overrides: Record<string, string> = {}): RequestInit {
    return {
      method: "POST",
      headers: {
        cookie,
        origin: this.origin,
        "content-type": "application/json",
        ...(csrf === null ? {} : { "x-csrf-token": csrf }),
        ...overrides,
      },
      body: "{}",
    }
  }

  async stop(): Promise<void> {
    await this.server.stop(true)
    this.db.close()
    await rm(this.home, { recursive: true, force: true })
  }
}

export const PROBE = PROBE_PATH

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function requiredLocation(response: Response): string {
  const location = response.headers.get("location")
  if (location === null) throw new Error(`expected a redirect, got ${response.status}`)
  return location
}

export function setCookie(response: Response, name: string): string | null {
  return response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`)) ?? null
}

export function cookiePair(response: Response, name: string): string | null {
  const header = setCookie(response, name)
  if (header === null) return null
  const pair = header.split(";")[0] ?? ""
  return pair.endsWith("=") ? null : pair
}

export async function errorCode(response: Response): Promise<string | null> {
  const body: unknown = await response.json()
  if (!isRecord(body) || !isRecord(body.error)) return null
  return typeof body.error.code === "string" ? body.error.code : null
}
