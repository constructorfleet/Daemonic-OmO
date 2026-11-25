import { AuthError } from "./http"
import type { Sessions } from "./sessions"
import { safeEqual } from "./tokens"
import type { AuthDeps, Guard, Principal } from "./types"
import type { UserDirectory } from "./users"

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

function normalizeAddress(address: string): string {
  const lower = address.trim().toLowerCase()
  return /^::ffff:\d{1,3}(?:\.\d{1,3}){3}$/.test(lower) ? lower.slice("::ffff:".length) : lower
}

function isLoopback(address: string): boolean {
  const normalized = normalizeAddress(address)
  return normalized === "::1" || /^127(?:\.\d{1,3}){3}$/.test(normalized)
}

function headerList(request: Request, name: string): readonly string[] {
  return (request.headers.get(name) ?? "").split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0)
}

function bearerToken(request: Request): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization") ?? "")
  return match?.[1] ?? null
}

function requireJson(request: Request): void {
  const mediaType = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase()
  if (mediaType !== "application/json") {
    throw new AuthError("invalid_arguments", "mutations require Content-Type: application/json")
  }
}

export function createGuard(deps: AuthDeps, sessions: Sessions, directory: UserDirectory): Guard {
  const trustedHosts = new Set(deps.config.trustedHosts.map((host) => host.toLowerCase()))
  const trustedProxies = new Set(deps.config.trustedProxies.map(normalizeAddress))
  const publicOrigin = new URL(deps.config.publicUrl).origin
  const isTrustedProxy = (address: string): boolean => trustedProxies.has(normalizeAddress(address))

  // X-Forwarded-* is believed only when the socket peer is a configured proxy.
  function effectiveHost(request: Request, peer: string): string | null {
    const forwarded = isTrustedProxy(peer) ? headerList(request, "x-forwarded-host")[0] : undefined
    return forwarded ?? request.headers.get("host")
  }

  // The nearest X-Forwarded-For hop that is not one of our proxies.
  function clientAddress(request: Request, peer: string): string {
    if (!isTrustedProxy(peer)) return peer
    const chain = headerList(request, "x-forwarded-for")
    return [...chain].reverse().find((hop) => !isTrustedProxy(hop)) ?? chain[0] ?? peer
  }

  function admitPublic(request: Request, peer: string): void {
    const host = effectiveHost(request, peer)?.toLowerCase()
    if (host === undefined || !trustedHosts.has(host)) throw new AuthError("forbidden", "untrusted Host header")
  }

  function breakglass(request: Request, peer: string, token: string): Principal {
    const loopback = isLoopback(peer) && isLoopback(clientAddress(request, peer))
    if (!loopback || !safeEqual(token, deps.secrets.breakglassToken)) {
      throw new AuthError("unauthenticated", "invalid credentials")
    }
    if (!SAFE_METHODS.has(request.method)) requireJson(request)
    return { kind: "breakglass", user: directory.ensureBootstrapAdmin() }
  }

  return {
    admitPublic,

    authenticate(request: Request, peer: string): Principal {
      admitPublic(request, peer)
      const token = bearerToken(request)
      if (token !== null) return breakglass(request, peer, token)
      const { session, user } = sessions.resolve(request)
      if (!SAFE_METHODS.has(request.method)) {
        if (request.headers.get("origin") !== publicOrigin) throw new AuthError("forbidden", "cross-origin mutation")
        if (!safeEqual(request.headers.get("x-csrf-token") ?? "", session.csrfToken)) {
          throw new AuthError("forbidden", "missing or invalid X-CSRF-Token")
        }
        requireJson(request)
      }
      sessions.extend(session)
      return { kind: "session", user, session }
    },
  }
}
