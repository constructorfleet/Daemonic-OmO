import { GUARD, type Services } from "../api/services"
import { createAuth, type Auth, type AuthDeps, type AuthRoute } from "../auth"

export type { AuthRoute }

export interface AuthFeatureContext extends AuthDeps {
  addRoute(route: AuthRoute): void
  /** The app's registry; test/auth/harness.ts mounts the auth routes alone and passes none. */
  readonly services?: Services
}

export async function register(ctx: AuthFeatureContext): Promise<Auth> {
  const auth = await createAuth(ctx)
  for (const route of auth.routes) ctx.addRoute(route)
  ctx.services?.provide(GUARD, auth.guard)
  return auth
}
