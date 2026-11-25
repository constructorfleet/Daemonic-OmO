import { AuthError, errorResponse, type AuthRoute } from "./http"
import type { LoginState } from "./login-state"
import type { OidcClient } from "./oidc"
import type { Sessions } from "./sessions"
import type { Guard } from "./types"
import type { UserDirectory } from "./users"

export const LOGIN_PATH = "/auth/login"
export const LOGOUT_PATH = "/auth/logout"
export const ME_PATH = "/api/v1/me"

export interface RouteParts {
  readonly guard: Guard
  readonly sessions: Sessions
  readonly directory: UserDirectory
}

export interface OidcRouteParts extends RouteParts {
  readonly oidc: OidcClient
  readonly loginState: LoginState
  readonly callbackPath: string
}

type Handler = (request: Request, peer: string) => Promise<Response> | Response

function route(method: AuthRoute["method"], path: string, handler: Handler): AuthRoute {
  return {
    method,
    path,
    async handle(request, peer) {
      try {
        return await handler(request, peer)
      } catch (error) {
        if (error instanceof AuthError) return errorResponse(error)
        throw error
      }
    },
  }
}

function headersWithCookies(cookies: readonly string[], extra: Record<string, string> = {}): Headers {
  const headers = new Headers(extra)
  for (const cookie of cookies) headers.append("set-cookie", cookie)
  return headers
}

export function sessionRoutes({ guard, sessions }: RouteParts): readonly AuthRoute[] {
  return [
    route("GET", ME_PATH, (request, peer) => {
      const principal = guard.authenticate(request, peer)
      return Response.json(
        {
          user: principal.user,
          role: principal.user.role,
          csrfToken: principal.kind === "session" ? principal.session.csrfToken : null,
        },
        { headers: { "cache-control": "no-store" } },
      )
    }),
    route("POST", LOGOUT_PATH, (request, peer) => {
      const principal = guard.authenticate(request, peer)
      const cookies = principal.kind === "session" ? [sessions.close(principal.session)] : []
      return new Response(null, { status: 204, headers: headersWithCookies(cookies) })
    }),
  ]
}

export function oidcRoutes(parts: OidcRouteParts): readonly AuthRoute[] {
  const { guard, sessions, directory, oidc, loginState } = parts
  const clearLogin = (): Headers => headersWithCookies([loginState.clear()])
  return [
    route("GET", LOGIN_PATH, async (request, peer) => {
      guard.admitPublic(request, peer)
      const { pending, cookie } = loginState.begin()
      const location = (await oidc.authorizationUrl(pending)).href
      return new Response(null, { status: 302, headers: headersWithCookies([cookie], { location }) })
    }),
    route("GET", parts.callbackPath, async (request, peer) => {
      guard.admitPublic(request, peer)
      try {
        const claims = await oidc.complete(new URL(request.url), loginState.read(request))
        const admission = directory.admit(claims)
        if (admission.kind === "denied") {
          throw new AuthError("forbidden", "this account is not provisioned on this daemon")
        }
        const cookies = [sessions.open(admission.user), loginState.clear()]
        return new Response(null, { status: 303, headers: headersWithCookies(cookies, { location: "/" }) })
      } catch (error) {
        if (error instanceof AuthError) return errorResponse(error, clearLogin())
        throw error
      }
    }),
  ]
}
