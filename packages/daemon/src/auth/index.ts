import { createGuard } from "./guard"
import type { AuthRoute } from "./http"
import { createLoginState } from "./login-state"
import { createOidcClient, readClientSecret } from "./oidc"
import { oidcRoutes, sessionRoutes } from "./routes"
import { createSessions } from "./sessions"
import { createAuthStore } from "./store"
import type { AuthDeps, Guard } from "./types"
import { createUserDirectory } from "./users"

export interface Auth {
  readonly guard: Guard
  readonly routes: readonly AuthRoute[]
}

export async function createAuth(deps: AuthDeps): Promise<Auth> {
  const store = createAuthStore(deps.db)
  const sessions = createSessions(deps, store)
  const directory = createUserDirectory(deps, store)
  const guard = createGuard(deps, sessions, directory)
  const parts = { guard, sessions, directory }
  const oidcConfig = deps.config.oidc
  if (oidcConfig === undefined) return { guard, routes: sessionRoutes(parts) }

  const callbackPath = oidcConfig.redirectPath
  const oidc = createOidcClient(oidcConfig, {
    clientSecret: await readClientSecret(oidcConfig.clientSecretFile),
    redirectUri: new URL(callbackPath, deps.config.publicUrl).href,
    clock: deps.clock,
  })
  const loginState = createLoginState(deps, callbackPath)
  return {
    guard,
    routes: [...sessionRoutes(parts), ...oidcRoutes({ ...parts, oidc, loginState, callbackPath })],
  }
}

export { AuthError, errorResponse } from "./http"
export type { AuthErrorCode, AuthRoute } from "./http"
export { scopeFor } from "./users"
export type { UserScope } from "./users"
export type { AuthDeps, Guard, Principal } from "./types"
