import type { Rng } from "./ports"
import type { Ms, SessionId, ThreadId, Ulid, Uuid } from "./types"

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
const ULID_LENGTH = 26
const ULID_TIME_CHARS = 10

function assertTimestamp(at: Ms): number {
  if (!Number.isFinite(at) || at < 0) {
    throw new RangeError(`invalid epoch milliseconds: ${at}`)
  }
  return Math.floor(at)
}

function writeTimestamp(bytes: Uint8Array, at: Ms): void {
  let remaining = assertTimestamp(at)
  for (let i = 5; i >= 0; i--) {
    bytes[i] = remaining % 256
    remaining = Math.floor(remaining / 256)
  }
}

// ULID packs 128 bits into 26 Crockford base32 chars (2 padding bits), least
// significant group last, so encoding walks the bytes back to front.
function encodeUlid(bytes: Uint8Array): string {
  const chars = new Array<string>(ULID_LENGTH).fill("0")
  let buffer = 0
  let bits = 0
  let index = ULID_LENGTH - 1
  for (let i = bytes.length - 1; i >= 0; i--) {
    buffer |= (bytes[i] ?? 0) << bits
    bits += 8
    while (bits >= 5) {
      chars[index] = ULID_ALPHABET[buffer & 31] ?? "0"
      index -= 1
      buffer >>>= 5
      bits -= 5
    }
  }
  if (bits > 0) {
    chars[index] = ULID_ALPHABET[buffer & 31] ?? "0"
  }
  return chars.join("")
}

function decodeUlidChar(char: string): number {
  return ULID_ALPHABET.indexOf(char)
}

function formatUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

export function ulid(rng: Rng, at: Ms): Ulid {
  const bytes = new Uint8Array(16)
  writeTimestamp(bytes, at)
  bytes.set(rng.nextBytes(10), 6)
  return encodeUlid(bytes) as Ulid
}

export function parseUlid(value: string): Ulid | null {
  if (value.length !== ULID_LENGTH) return null
  for (const char of value) {
    if (decodeUlidChar(char) < 0) return null
  }
  if (decodeUlidChar(value[0] ?? "") > 7) return null
  return value as Ulid
}

export function ulidTime(id: Ulid): Ms {
  let encoded = 0
  for (let i = 0; i < ULID_TIME_CHARS; i++) {
    encoded = encoded * 32 + decodeUlidChar(id[i] ?? "")
  }
  return encoded
}

export function uuidv7(rng: Rng, at: Ms): Uuid {
  const bytes = new Uint8Array(16)
  writeTimestamp(bytes, at)
  const random = rng.nextBytes(10)
  bytes[6] = 0x70 | ((random[0] ?? 0) & 0x0f)
  bytes[7] = random[1] ?? 0
  bytes[8] = 0x80 | ((random[2] ?? 0) & 0x3f)
  for (let i = 3; i < 10; i++) {
    bytes[i + 6] = random[i] ?? 0
  }
  return formatUuid(bytes) as Uuid
}

export function isUuidv7(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}

export function uuidv7Time(id: Uuid): Ms {
  if (!isUuidv7(id)) {
    throw new RangeError(`not a UUIDv7: ${id}`)
  }
  return Number.parseInt(id.slice(0, 13).replace("-", ""), 16)
}

export function threadId(value: string): ThreadId {
  if (value.length === 0) {
    throw new RangeError("thread id must not be empty")
  }
  return value as ThreadId
}

export function sessionId(value: string): SessionId {
  if (value.length === 0) {
    throw new RangeError("session id must not be empty")
  }
  return value as SessionId
}
