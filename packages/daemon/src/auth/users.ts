import { createHash } from "node:crypto"
import { join } from "node:path"
import { parseUlid, ulid } from "../core/ids"
import type { User, UserId, UserRole } from "../core/types"
import { AuthError } from "./http"
import type { AuthStore } from "./store"
import type { AuthDeps, IdentityClaims } from "./types"

export type UserScope =
  | { readonly kind: "all" }
  | { readonly kind: "user"; readonly userId: UserId }

export function scopeFor(user: User, requestedUserId: string | null): UserScope {
  if (user.role === "member") {
    if (requestedUserId !== null && requestedUserId !== user.id) {
      throw new AuthError("forbidden", "members can only read their own data")
    }
    return { kind: "user", userId: user.id }
  }
  if (requestedUserId === null) return { kind: "all" }
  const userId = parseUlid(requestedUserId)
  if (userId === null) throw new AuthError("invalid_arguments", "userId must be a user id")
  return { kind: "user", userId }
}

// Until an OIDC identity is known for the bootstrap admin (no oidc config, or
// only bootstrapAdmin.email), its row holds this placeholder identity.
export const LOCAL_ISSUER = "urn:omo-daemonic:local"
const PLACEHOLDER_SUB = "bootstrap-admin"

interface OidcIdentity {
  readonly issuer: string
  readonly sub: string
}

// Characters outside [A-Za-z0-9._-] become "_"; any rewrite appends a digest of
// the raw subject so two subjects never share an agent dir and no subject can
// name a path segment such as "..".
function agentDirName(subject: string): string {
  const safe = subject.replace(/[^A-Za-z0-9._-]/g, "_")
  if (safe === subject && safe !== "." && safe !== "..") return safe
  return `${safe}-${createHash("sha256").update(subject).digest("hex").slice(0, 12)}`
}

export type Admission = { readonly kind: "admitted"; readonly user: User } | { readonly kind: "denied" }

export function createUserDirectory(deps: AuthDeps, store: AuthStore) {
  const { config, repos, clock, rng } = deps
  const bootstrapConfig = config.users.bootstrapAdmin
  const nowIso = (): string => new Date(clock.now()).toISOString()

  function save(user: User): User {
    repos.users.put(user)
    return user
  }

  function newUser(identity: OidcIdentity, fields: Pick<User, "email" | "name" | "role" | "agentDir">): User {
    const at = nowIso()
    return {
      id: ulid(rng, clock.now()),
      oidcIssuer: identity.issuer,
      oidcSub: identity.sub,
      allowedRoots: [],
      settings: {},
      createdAt: at,
      updatedAt: at,
      lastLoginAt: null,
      ...fields,
    }
  }

  function rebind(user: User, identity: OidcIdentity): User {
    return { ...user, oidcIssuer: identity.issuer, oidcSub: identity.sub, updatedAt: nowIso() }
  }

  function isPlaceholder(user: User): boolean {
    return user.oidcIssuer === LOCAL_ISSUER
  }

  function configuredIdentity(): OidcIdentity | null {
    const sub = bootstrapConfig.oidcSub
    return config.oidc === undefined || sub === undefined ? null : { issuer: config.oidc.issuer, sub }
  }

  function createBootstrapAdmin(identity: OidcIdentity | null): User {
    const adopted = identity === null ? null : repos.users.findByOidc(identity.issuer, identity.sub)
    const admin = save(adopted === null
      ? newUser(identity ?? { issuer: LOCAL_ISSUER, sub: PLACEHOLDER_SUB }, {
        email: bootstrapConfig.email ?? "",
        name: "Bootstrap admin",
        role: "admin",
        agentDir: bootstrapConfig.agentDir,
      })
      : { ...adopted, role: "admin", updatedAt: nowIso() })
    store.recordBootstrapAdmin(admin.id)
    return admin
  }

  function ensureBootstrapAdmin(): User {
    return deps.db.transaction(() => {
      const identity = configuredIdentity()
      const id = store.bootstrapAdminId()
      const current = id === null ? null : repos.users.get(id)
      if (current === null) return createBootstrapAdmin(identity)
      return identity !== null && isPlaceholder(current) ? save(rebind(current, identity)) : current
    })()
  }

  function matchesBootstrap(claims: IdentityClaims): boolean {
    if (bootstrapConfig.oidcSub !== undefined) return claims.subject === bootstrapConfig.oidcSub
    const email = bootstrapConfig.email?.toLowerCase()
    return email !== undefined && claims.emailVerified && claims.email?.toLowerCase() === email
  }

  function roleFor(claims: IdentityClaims, isBootstrap: boolean): UserRole {
    const oidc = config.oidc
    const listed = oidc?.adminSubjects.some(({ issuer, sub }) => issuer === claims.issuer && sub === claims.subject)
    const grouped = oidc?.groupsClaim !== undefined && oidc.adminGroup !== undefined
      && claims.groups.includes(oidc.adminGroup)
    return isBootstrap || listed === true || grouped ? "admin" : "member"
  }

  function signIn(user: User, claims: IdentityClaims, isBootstrap: boolean): Admission {
    const at = nowIso()
    return {
      kind: "admitted",
      user: save({
        ...user,
        email: claims.email ?? user.email,
        name: claims.name ?? user.name,
        role: roleFor(claims, isBootstrap),
        updatedAt: at,
        lastLoginAt: at,
      }),
    }
  }

  function deny(claims: IdentityClaims, owner: User): Admission {
    repos.audit.put({
      id: ulid(rng, clock.now()),
      userId: owner.id,
      at: nowIso(),
      action: "auth.login_denied",
      entityKind: "user",
      entityId: `${claims.issuer}#${claims.subject}`,
      detail: { issuer: claims.issuer, sub: claims.subject, reason: "not_provisioned" },
    })
    return { kind: "denied" }
  }

  return {
    ensureBootstrapAdmin,

    admit(claims: IdentityClaims): Admission {
      const bootstrap = ensureBootstrapAdmin()
      const identity = { issuer: claims.issuer, sub: claims.subject }
      const existing = repos.users.findByOidc(identity.issuer, identity.sub)
      if (existing !== null) return signIn(existing, claims, existing.id === bootstrap.id)
      if (isPlaceholder(bootstrap) && matchesBootstrap(claims)) return signIn(rebind(bootstrap, identity), claims, true)
      if (!config.users.allowSelfSignup) return deny(claims, bootstrap)
      return signIn(newUser(identity, {
        email: claims.email ?? "",
        name: claims.name ?? claims.email ?? claims.subject,
        role: "member",
        agentDir: join(config.users.defaultAgentDirRoot, agentDirName(claims.subject)),
      }), claims, false)
    },
  }
}

export type UserDirectory = ReturnType<typeof createUserDirectory>
