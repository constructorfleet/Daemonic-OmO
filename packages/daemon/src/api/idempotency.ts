import { createHash } from "node:crypto"
import { isPlainObject } from "../config/reader"
import type { Clock } from "../core/ports"
import type { UserId } from "../core/types"
import type { createIdempotencyRepository } from "../db/repos/idempotency"
import { RepositoryDataError } from "../db/repos/errors"
import { ApiError } from "./errors"

export const IDEMPOTENCY_HEADER = "idempotency-key"
export const REPLAYED_HEADER = "idempotent-replayed"
const KEY_PATTERN = /^[\x21-\x7e]{1,255}$/

interface StoredResponse {
  readonly status: number
  readonly contentType: string | null
  readonly body: string
}

export interface IdempotentRequest {
  readonly userId: UserId
  readonly key: string
  readonly method: string
  readonly url: URL
  readonly body: string
}

export interface IdempotencyDeps {
  readonly repository: ReturnType<typeof createIdempotencyRepository>
  readonly clock: Clock
  readonly ttlMs: number
}

function requestHash(request: IdempotentRequest): string {
  return createHash("sha256")
    .update(`${request.method}\n${request.url.pathname}${request.url.search}\n${request.body}`)
    .digest("hex")
}

function parseStored(text: string): StoredResponse {
  const value: unknown = JSON.parse(text)
  if (!isPlainObject(value) || typeof value.status !== "number" || typeof value.body !== "string" ||
    (value.contentType !== null && typeof value.contentType !== "string")) {
    throw new RepositoryDataError("idempotency response")
  }
  return { status: value.status, contentType: value.contentType, body: value.body }
}

function toResponse(stored: StoredResponse, replayed: boolean): Response {
  const headers = new Headers({ "cache-control": "no-store" })
  if (stored.contentType !== null) headers.set("content-type", stored.contentType)
  if (replayed) headers.set(REPLAYED_HEADER, "true")
  return new Response(stored.body, { status: stored.status, headers })
}

function conflict(key: string): ApiError {
  return new ApiError("idempotency_conflict", "Idempotency-Key was used with a different request", { key })
}

/**
 * Per-user Idempotency-Key handling: the first response (below 500) is kept
 * for `ttlMs` and replayed for the same key and request; the same key with a
 * different method, path or body is 422. Concurrent duplicates wait for the
 * first execution instead of running twice. Thrown errors are not stored, so
 * a retry after a failure executes again.
 */
export function createIdempotency(deps: IdempotencyDeps) {
  const inFlight = new Map<string, { readonly hash: string; readonly result: Promise<StoredResponse> }>()

  async function execute(request: IdempotentRequest, hash: string, run: () => Promise<Response>): Promise<StoredResponse> {
    const response = await run()
    const stored = {
      status: response.status,
      contentType: response.headers.get("content-type"),
      body: await response.text(),
    }
    if (stored.status < 500) {
      deps.repository.put({
        userId: request.userId,
        key: request.key,
        requestHash: hash,
        response: JSON.stringify(stored),
        expiresAt: deps.clock.now() + deps.ttlMs,
      })
    }
    return stored
  }

  return {
    async run(request: IdempotentRequest, handler: () => Promise<Response>): Promise<Response> {
      if (!KEY_PATTERN.test(request.key)) {
        throw new ApiError("invalid_arguments", "Idempotency-Key must be 1-255 visible ASCII characters")
      }
      const hash = requestHash(request)
      deps.repository.pruneExpired(deps.clock.now())
      const recorded = deps.repository.get(request.userId, request.key)
      if (recorded !== null) {
        if (recorded.requestHash !== hash) throw conflict(request.key)
        return toResponse(parseStored(recorded.response), true)
      }
      const slot = `${request.userId}\u0000${request.key}`
      const pending = inFlight.get(slot)
      if (pending !== undefined) {
        if (pending.hash !== hash) throw conflict(request.key)
        return toResponse(await pending.result, true)
      }
      const result = execute(request, hash, handler)
      inFlight.set(slot, { hash, result })
      try {
        return toResponse(await result, false)
      } finally {
        inFlight.delete(slot)
      }
    },
  }
}

export type Idempotency = ReturnType<typeof createIdempotency>
