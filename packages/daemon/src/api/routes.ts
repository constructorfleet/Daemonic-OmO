import type { Principal } from "../auth"
import { ApiError } from "./errors"
import { IDEMPOTENCY_HEADER, type Idempotency } from "./idempotency"
import { GUARD, type Services } from "./services"

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE"
export type RouteParams = Readonly<Record<string, string>>

/**
 * One endpoint. `path` segments starting with ":" capture params. A handler
 * may throw ApiError, AuthError or the repositories' conflict errors; the
 * server turns them into the error envelope.
 */
export interface Route {
  readonly method: HttpMethod
  readonly path: string
  handle(request: Request, peer: string, params: RouteParams): Promise<Response> | Response
}

export class RouteConflictError extends Error {
  readonly name = "RouteConflictError"

  constructor(readonly method: HttpMethod, readonly path: string) {
    super(`route ${method} ${path} is already registered`)
  }
}

interface Entry {
  readonly route: Route
  readonly segments: readonly string[]
}

function segmentsOf(path: string): readonly string[] {
  return path.split("/").filter((segment) => segment.length > 0)
}

function shape(segments: readonly string[]): string {
  return segments.map((segment) => (segment.startsWith(":") ? ":" : segment)).join("/")
}

function capture(pattern: readonly string[], actual: readonly string[]): RouteParams | null {
  if (pattern.length !== actual.length) return null
  const params: Record<string, string> = {}
  for (const [index, segment] of pattern.entries()) {
    const value = actual[index] ?? ""
    if (segment.startsWith(":")) {
      try {
        params[segment.slice(1)] = decodeURIComponent(value)
      } catch (error) {
        if (error instanceof URIError) return null
        throw error
      }
    } else if (segment !== value) {
      return null
    }
  }
  return params
}

export class Router {
  readonly #entries: Entry[] = []

  add(route: Route): void {
    const segments = segmentsOf(route.path)
    const duplicate = this.#entries.some((entry) =>
      entry.route.method === route.method && shape(entry.segments) === shape(segments))
    if (duplicate) throw new RouteConflictError(route.method, route.path)
    this.#entries.push({ route, segments })
  }

  match(method: string, pathname: string): { readonly route: Route; readonly params: RouteParams } | null {
    const actual = segmentsOf(pathname)
    for (const entry of this.#entries) {
      if (entry.route.method !== method) continue
      const params = capture(entry.segments, actual)
      if (params !== null) return { route: entry.route, params }
    }
    return null
  }
}

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } })
}

export interface UserRequest {
  readonly principal: Principal
  readonly request: Request
  readonly url: URL
  readonly params: RouteParams
  readonly body: unknown
}

export interface UserRouteSpec {
  readonly method: HttpMethod
  readonly path: string
  handle(input: UserRequest): Promise<Response> | Response
}

export interface UserRouteDeps {
  readonly services: Services
  readonly idempotency: Idempotency
}

function parseBody(text: string): unknown {
  if (text.length === 0) return undefined
  try {
    return JSON.parse(text)
  } catch (error) {
    if (error instanceof SyntaxError) throw new ApiError("invalid_arguments", "request body must be valid JSON")
    throw error
  }
}

/**
 * An authenticated route: the guard (Host allowlist, session or break-glass
 * credentials, CSRF/Origin/JSON checks on mutations) runs first, and a
 * mutation carrying `Idempotency-Key` goes through the per-user replay store.
 */
export function userRoute(deps: UserRouteDeps, spec: UserRouteSpec): Route {
  return {
    method: spec.method,
    path: spec.path,
    async handle(request, peer, params) {
      const principal = deps.services.require(GUARD).authenticate(request, peer)
      const url = new URL(request.url)
      if (spec.method === "GET") return spec.handle({ principal, request, url, params, body: undefined })
      const text = await request.text()
      const input = { principal, request, url, params, body: parseBody(text) }
      const key = request.headers.get(IDEMPOTENCY_HEADER)
      if (key === null) return spec.handle(input)
      return deps.idempotency.run(
        { userId: principal.user.id, key, method: spec.method, url, body: text },
        async () => spec.handle(input),
      )
    },
  }
}
