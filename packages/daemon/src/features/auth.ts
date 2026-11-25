import { createAuth, type Auth, type AuthDeps, type AuthRoute } from "../auth"

export type { AuthRoute }

export interface AuthFeatureContext extends AuthDeps {
  addRoute(route: AuthRoute): void
}

export async function register(ctx: AuthFeatureContext): Promise<Auth> {
  const auth = await createAuth(ctx)
  for (const route of auth.routes) ctx.addRoute(route)
  return auth
}
