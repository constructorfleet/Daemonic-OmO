import { cookiePair, isRecord, requiredLocation } from "../auth/harness"
import { startE2eServer, type E2eServer, type E2eServerOptions } from "../support/e2e-server"
import { parseUlid } from "../../src/core/ids"
import type { DaemonEvent, User, UserId } from "../../src/core/types"

const running: E2eServer[] = []

/** Each test file registers `afterEach(stopServers)`: a hook in this shared module would bind to the first importer only. */
export async function stopServers(): Promise<void> {
  for (const server of running.splice(0)) await server.stop()
}

export async function server(options: E2eServerOptions = {}): Promise<E2eServer> {
  const started = await startE2eServer(options)
  running.push(started)
  return started
}

export interface Member {
  readonly user: User
  readonly cookie: string
  readonly csrf: string
}

export async function member(target: E2eServer, sub: string): Promise<Member> {
  target.idp.identity = { sub, email: `${sub}@example.test`, email_verified: true, name: sub }
  const start = await fetch(`${target.url}/auth/login`, { redirect: "manual" })
  const loginCookie = cookiePair(start, "omod_login")
  const authorize = await fetch(requiredLocation(start), { redirect: "manual" })
  const callback = await fetch(requiredLocation(authorize), {
    redirect: "manual",
    headers: loginCookie === null ? {} : { cookie: loginCookie },
  })
  const cookie = cookiePair(callback, "omod_session")
  if (cookie === null) throw new Error(`login for ${sub} set no session cookie (${callback.status})`)
  const me: unknown = await (await fetch(`${target.url}/api/v1/me`, { headers: { cookie } })).json()
  if (!isRecord(me) || typeof me.csrfToken !== "string" || !isRecord(me.user) || typeof me.user.id !== "string") {
    throw new Error(`/api/v1/me returned no user for ${sub}`)
  }
  const id = parseUlid(me.user.id)
  const user = id === null ? null : target.app.ctx.repos.users.get(id)
  if (user === null) throw new Error(`member ${sub} was not stored`)
  return { user, cookie, csrf: me.csrfToken }
}

export function memberHeaders(target: E2eServer, who: Member, extra: Record<string, string> = {}): Record<string, string> {
  return {
    cookie: who.cookie,
    origin: target.url,
    "x-csrf-token": who.csrf,
    "content-type": "application/json",
    ...extra,
  }
}

export function adminHeaders(target: E2eServer, extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${target.breakglassToken}`, ...extra }
}

export function emit(target: E2eServer, userId: UserId, count: number, at?: string): readonly DaemonEvent[] {
  const { ledger, clock } = target.app.ctx
  const committed: DaemonEvent[] = []
  const unsubscribe = ledger.subscribe((event) => committed.push(event))
  try {
    for (let index = 0; index < count; index += 1) {
      ledger.transact((transaction) => transaction.emit({
        at: at ?? new Date(clock.now()).toISOString(),
        type: "test.event",
        entityKind: "daemon",
        entityId: `event-${index}`,
        userId,
        projectId: null,
        data: { index },
      }))
    }
  } finally {
    unsubscribe()
  }
  return committed
}

export interface SseFrame {
  readonly id: string | null
  readonly event: string
  readonly data: unknown
}

/** Reads SSE frames; each `next()` reads the body only when no whole frame is buffered. */
export class SseReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>
  readonly #decoder = new TextDecoder()
  #buffer = ""

  constructor(stream: ReadableStream<Uint8Array>) {
    this.#reader = stream.getReader()
  }

  static async open(target: E2eServer, headers: Record<string, string>, query = ""): Promise<SseReader> {
    const response = await fetch(`${target.url}/api/v1/stream${query}`, { headers })
    if (response.status !== 200 || response.body === null) {
      throw new Error(`stream open failed: ${response.status} ${await response.text()}`)
    }
    return new SseReader(response.body)
  }

  async next(): Promise<SseFrame | null> {
    for (;;) {
      const end = this.#buffer.indexOf("\n\n")
      if (end >= 0) {
        const raw = this.#buffer.slice(0, end)
        this.#buffer = this.#buffer.slice(end + 2)
        return parseFrame(raw)
      }
      const { done, value } = await this.#reader.read()
      if (done) return null
      this.#buffer += this.#decoder.decode(value, { stream: true })
    }
  }

  async take(count: number): Promise<readonly SseFrame[]> {
    const frames: SseFrame[] = []
    while (frames.length < count) {
      const frame = await this.next()
      if (frame === null) throw new Error(`stream ended after ${frames.length} of ${count} frames`)
      frames.push(frame)
    }
    return frames
  }

  async entitiesThrough(lastId: number): Promise<readonly SseFrame[]> {
    const frames: SseFrame[] = []
    for (;;) {
      const frame = await this.next()
      if (frame === null) throw new Error(`stream ended before id ${lastId}`)
      if (frame.event !== "entity") continue
      frames.push(frame)
      if (Number(frame.id) >= lastId) return frames
    }
  }

  async cancel(): Promise<void> {
    await this.#reader.cancel()
  }
}

function parseFrame(raw: string): SseFrame {
  let id: string | null = null
  let event = "message"
  const data: string[] = []
  for (const line of raw.split("\n")) {
    const separator = line.indexOf(":")
    const field = separator < 0 ? line : line.slice(0, separator)
    const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, "")
    if (field === "id") id = value
    else if (field === "event") event = value
    else if (field === "data") data.push(value)
  }
  return { id, event, data: JSON.parse(data.join("\n")) }
}

export function ids(frames: readonly SseFrame[]): number[] {
  return frames.map((frame) => Number(frame.id))
}

export function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, index) => from + index)
}

export function field(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined
}
