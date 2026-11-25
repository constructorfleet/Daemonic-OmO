import type { JsonObject } from "../core/types"

const STATUS_BY_CODE = {
  invalid_arguments: 400,
  unauthenticated: 401,
  forbidden: 403,
  internal: 500,
} as const

export type AuthErrorCode = keyof typeof STATUS_BY_CODE

export class AuthError extends Error {
  readonly name = "AuthError"
  readonly status: number

  constructor(
    readonly code: AuthErrorCode,
    message: string,
    readonly details?: JsonObject,
  ) {
    super(message)
    this.status = STATUS_BY_CODE[code]
  }
}

export function errorResponse(error: AuthError, headers: Headers = new Headers()): Response {
  const details = error.details === undefined ? {} : { details: error.details }
  return Response.json(
    { error: { code: error.code, message: error.message, ...details } },
    { status: error.status, headers },
  )
}

export interface AuthRoute {
  readonly method: "GET" | "POST"
  readonly path: string
  handle(request: Request, peer: string): Promise<Response>
}

export interface CookieOptions {
  readonly path: string
  readonly secure: boolean
  readonly maxAgeSeconds?: number
}

export function serializeCookie(name: string, value: string, options: CookieOptions): string {
  const parts = [`${name}=${value}`, `Path=${options.path}`, "HttpOnly", "SameSite=Lax"]
  if (options.maxAgeSeconds !== undefined) parts.push(`Max-Age=${options.maxAgeSeconds}`)
  if (options.secure) parts.push("Secure")
  return parts.join("; ")
}

export function clearCookie(name: string, options: Omit<CookieOptions, "maxAgeSeconds">): string {
  return serializeCookie(name, "", { ...options, maxAgeSeconds: 0 })
}

export function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const separator = part.indexOf("=")
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue
    const value = part.slice(separator + 1).trim()
    return value.length > 0 ? value : null
  }
  return null
}

export function isHttps(url: string): boolean {
  return new URL(url).protocol === "https:"
}
