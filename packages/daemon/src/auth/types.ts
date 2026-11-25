import type { Database } from "bun:sqlite"
import type { Config, Secrets } from "../config"
import type { Clock, Rng } from "../core/ports"
import type { User } from "../core/types"
import type { createRepositories } from "../db/repos"
import type { DaemonSession } from "../db/repos/sessions"

export type Repositories = ReturnType<typeof createRepositories>

export interface AuthDeps {
  readonly config: Config
  readonly secrets: Secrets
  readonly db: Database
  readonly repos: Repositories
  readonly clock: Clock
  readonly rng: Rng
}

export type Principal =
  | { readonly kind: "session"; readonly user: User; readonly session: DaemonSession }
  | { readonly kind: "breakglass"; readonly user: User }

export interface Guard {
  /** Host allowlist only; for routes reachable before sign-in. Throws AuthError. */
  admitPublic(request: Request, peer: string): void
  /** Host allowlist, credentials, and the mutation checks. Throws AuthError. */
  authenticate(request: Request, peer: string): Principal
}

export interface IdentityClaims {
  readonly issuer: string
  readonly subject: string
  readonly email: string | null
  readonly emailVerified: boolean
  readonly name: string | null
  readonly groups: readonly string[]
}
