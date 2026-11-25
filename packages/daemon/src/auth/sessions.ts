import type { User } from "../core/types"
import type { DaemonSession } from "../db/repos/sessions"
import { AuthError, clearCookie, isHttps, readCookie, serializeCookie } from "./http"
import type { AuthStore } from "./store"
import { randomToken, sign } from "./tokens"
import type { AuthDeps } from "./types"

export const SESSION_COOKIE = "omod_session"

export interface ActiveSession {
  readonly session: DaemonSession
  readonly user: User
}

export function createSessions(deps: AuthDeps, store: AuthStore) {
  const { clock, rng, repos } = deps
  const cookieOptions = { path: "/", secure: isHttps(deps.config.publicUrl) }
  const ttlMs = deps.config.limits.sessionTtlMs
  // The cookie carries the opaque id; the table keys on its HMAC so a leaked
  // database cannot be replayed as cookies.
  const rowId = (cookieValue: string): string => sign(deps.secrets.sessionKey, "session", cookieValue)
  const expiry = (): string => new Date(clock.now() + ttlMs).toISOString()

  return {
    open(user: User): string {
      const cookieValue = randomToken(rng)
      repos.sessions.put({
        id: rowId(cookieValue),
        userId: user.id,
        expiresAt: expiry(),
        csrfToken: randomToken(rng),
        createdAt: new Date(clock.now()).toISOString(),
      })
      return serializeCookie(SESSION_COOKIE, cookieValue, cookieOptions)
    },

    resolve(request: Request): ActiveSession {
      const cookieValue = readCookie(request, SESSION_COOKIE)
      if (cookieValue === null) throw new AuthError("unauthenticated", "sign in required")
      const session = repos.sessions.get(rowId(cookieValue))
      if (session === null) throw new AuthError("unauthenticated", "session not found")
      if (Date.parse(session.expiresAt) <= clock.now()) {
        store.deleteSession(session.id)
        throw new AuthError("unauthenticated", "session expired")
      }
      const user = repos.users.get(session.userId)
      if (user === null) throw new AuthError("unauthenticated", "session user no longer exists")
      return { session, user }
    },

    extend(session: DaemonSession): void {
      store.extendSession(session.id, expiry())
    },

    close(session: DaemonSession): string {
      store.deleteSession(session.id)
      return clearCookie(SESSION_COOKIE, cookieOptions)
    },
  }
}

export type Sessions = ReturnType<typeof createSessions>
