import { createHmac, timingSafeEqual } from "node:crypto"
import type { Rng } from "../core/ports"

const TOKEN_BYTES = 32

export function randomToken(rng: Rng): string {
  return Buffer.from(rng.nextBytes(TOKEN_BYTES)).toString("base64url")
}

export function sign(key: string, purpose: "session" | "login", value: string): string {
  return createHmac("sha256", key).update(`${purpose}\u0000${value}`).digest("base64url")
}

export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}
