import { randomBytes } from "node:crypto"
import { chmod, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Rng } from "../core/ports"
import { ConfigError } from "./errors"
import type { HomeLayout } from "./home"

export interface Secrets {
  readonly breakglassToken: string
  readonly sessionKey: string
}

export const BREAKGLASS_TOKEN_FILE = "breakglass.token"
export const SESSION_KEY_FILE = "session.key"
export const SECRET_BYTES = 32

export function systemRng(): Rng {
  const next = (): number => randomBytes(4).readUInt32BE(0) / 4_294_967_296
  return {
    next,
    nextInt: (maxExclusive: number): number => {
      if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
        throw new RangeError(`nextInt: maxExclusive must be a positive integer, got ${maxExclusive}`)
      }
      return Math.floor(next() * maxExclusive)
    },
    nextBytes: (count: number): Uint8Array => {
      if (!Number.isInteger(count) || count < 0) {
        throw new RangeError(`nextBytes: count must be a non-negative integer, got ${count}`)
      }
      return new Uint8Array(randomBytes(count))
    },
  }
}

export async function ensureSecrets(
  layout: HomeLayout,
  rng: Rng = systemRng(),
): Promise<Secrets> {
  const breakglassToken = await ensureSecret(join(layout.secretsDir, BREAKGLASS_TOKEN_FILE), rng)
  const sessionKey = await ensureSecret(join(layout.secretsDir, SESSION_KEY_FILE), rng)
  return { breakglassToken, sessionKey }
}

async function ensureSecret(path: string, rng: Rng): Promise<string> {
  const existing = await readSecret(path)
  if (existing !== null) {
    await tighten(path)
    return existing
  }
  const value = Buffer.from(rng.nextBytes(SECRET_BYTES)).toString("hex")
  try {
    await writeFile(path, `${value}\n`, { mode: 0o600, flag: "wx" })
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw secretsError(path, error)
    const raced = await readSecret(path)
    if (raced !== null) {
      await tighten(path)
      return raced
    }
    await writeFile(path, `${value}\n`, { mode: 0o600 })
  }
  await tighten(path)
  return value
}

async function readSecret(path: string): Promise<string | null> {
  try {
    const text = (await readFile(path, "utf8")).trim()
    return text.length > 0 ? text : null
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null
    throw secretsError(path, error)
  }
}

async function tighten(path: string): Promise<void> {
  try {
    await chmod(path, 0o600)
  } catch (error) {
    throw secretsError(path, error)
  }
}

function secretsError(path: string, error: unknown): ConfigError {
  const detail = error instanceof Error ? error.message : String(error)
  return new ConfigError("secrets_unavailable", `cannot use secret file ${path}: ${detail}`, {
    path,
    cause: error,
  })
}

function errorCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code
    if (typeof code === "string") return code
  }
  return null
}
