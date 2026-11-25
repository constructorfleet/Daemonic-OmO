import { isPlainObject } from "../config/reader"
import { AuthError, clearCookie, isHttps, readCookie, serializeCookie } from "./http"
import { randomToken, safeEqual, sign } from "./tokens"
import type { AuthDeps } from "./types"

export const LOGIN_COOKIE = "omod_login"
// No config key bounds the provider round trip, so it gets a generous fixed
// window (the user requires unconfigurable limits to be generous).
export const LOGIN_FLOW_TTL_MS = 30 * 60_000

export interface PendingLogin {
  readonly state: string
  readonly nonce: string
  readonly verifier: string
}

interface LoginPayload extends PendingLogin {
  readonly expiresAt: number
}

function parsePayload(text: string): LoginPayload | null {
  const parsed: unknown = JSON.parse(text)
  if (!isPlainObject(parsed)) return null
  const { state, nonce, verifier, expiresAt } = parsed
  if (typeof state !== "string" || typeof nonce !== "string" || typeof verifier !== "string") return null
  if (typeof expiresAt !== "number") return null
  return { state, nonce, verifier, expiresAt }
}

// The pending login rides in an HMAC-signed cookie, which binds the provider
// callback to the browser that started it (login CSRF) and survives restarts.
export function createLoginState(deps: AuthDeps, callbackPath: string) {
  const options = { path: callbackPath, secure: isHttps(deps.config.publicUrl) }
  const key = deps.secrets.sessionKey

  return {
    begin(): { readonly pending: PendingLogin; readonly cookie: string } {
      const pending = { state: randomToken(deps.rng), nonce: randomToken(deps.rng), verifier: randomToken(deps.rng) }
      const payload: LoginPayload = { ...pending, expiresAt: deps.clock.now() + LOGIN_FLOW_TTL_MS }
      const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url")
      const cookie = serializeCookie(LOGIN_COOKIE, `${encoded}.${sign(key, "login", encoded)}`, {
        ...options,
        maxAgeSeconds: LOGIN_FLOW_TTL_MS / 1000,
      })
      return { pending, cookie }
    },

    read(request: Request): PendingLogin {
      const [encoded, signature] = (readCookie(request, LOGIN_COOKIE) ?? "").split(".")
      const valid = encoded !== undefined && signature !== undefined && safeEqual(signature, sign(key, "login", encoded))
      const payload = valid ? parsePayload(Buffer.from(encoded, "base64url").toString()) : null
      if (payload === null || payload.expiresAt <= deps.clock.now()) {
        throw new AuthError("invalid_arguments", "login flow missing or expired; start again at /auth/login")
      }
      return { state: payload.state, nonce: payload.nonce, verifier: payload.verifier }
    },

    clear(): string {
      return clearCookie(LOGIN_COOKIE, options)
    },
  }
}

export type LoginState = ReturnType<typeof createLoginState>
