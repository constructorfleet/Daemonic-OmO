import type { Guard } from "../auth"
import type { JsonValue, User } from "../core/types"

/**
 * A typed slot one feature fills and others read. The value lives in a
 * WeakMap keyed by the app's `Services`, so keys are module constants while
 * every app instance (and every test server) keeps its own values.
 */
export class ServiceKey<T> {
  readonly #values = new WeakMap<Services, T>()

  constructor(readonly name: string) {}

  set(services: Services, value: T): void {
    if (this.#values.has(services)) throw new ServiceError(this.name, "is already provided")
    this.#values.set(services, value)
  }

  get(services: Services): T | undefined {
    return this.#values.get(services)
  }
}

export class ServiceError extends Error {
  readonly name = "ServiceError"

  constructor(readonly service: string, problem: string) {
    super(`service ${service} ${problem}`)
  }
}

export class Services {
  provide<T>(key: ServiceKey<T>, value: T): void {
    key.set(this, value)
  }

  get<T>(key: ServiceKey<T>): T | undefined {
    return key.get(this)
  }

  require<T>(key: ServiceKey<T>): T {
    const value = key.get(this)
    if (value === undefined) throw new ServiceError(key.name, "is not provided")
    return value
  }
}

/** Provided by features/auth.ts; the server authenticates every API request through it. */
export const GUARD = new ServiceKey<Guard>("guard")

export interface DocFrame {
  readonly docId: string
  readonly epoch: number
  readonly fromRev: number
  readonly toRev: number
  readonly ops: readonly JsonValue[]
}

export interface DocOpenRequest {
  readonly user: User
  readonly docId: string
  readonly epoch: number | null
  readonly rev: number | null
}

/**
 * Source of document streams (the observer). `open` authorizes `user` for the
 * doc and returns an unsubscribe function, or null when the doc is unknown or
 * not the user's. `emit` may be called synchronously from `open` to catch up
 * from `{epoch, rev}`.
 */
export interface DocProvider {
  open(request: DocOpenRequest, emit: (frame: DocFrame) => void): (() => void) | null
}

export const DOC_PROVIDER = new ServiceKey<DocProvider>("docProvider")
