import { AuthError } from "../auth"
import type { JsonObject } from "../core/types"
import { IdempotencyConflictError, RevisionConflictError } from "../db/repos/errors"

export const ERROR_STATUS = {
  invalid_arguments: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  revision_conflict: 409,
  state_conflict: 409,
  idempotency_conflict: 422,
  internal: 500,
} as const

export type ApiErrorCode = keyof typeof ERROR_STATUS

export class ApiError extends Error {
  readonly name = "ApiError"
  readonly status: number

  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: JsonObject,
  ) {
    super(message)
    this.status = ERROR_STATUS[code]
  }
}

export function errorResponse(error: ApiError): Response {
  const details = error.details === undefined ? {} : { details: error.details }
  return Response.json(
    { error: { code: error.code, message: error.message, ...details } },
    { status: error.status, headers: { "cache-control": "no-store" } },
  )
}

export function knownErrorResponse(error: unknown): Response | null {
  if (error instanceof ApiError) return errorResponse(error)
  if (error instanceof AuthError) return errorResponse(new ApiError(error.code, error.message, error.details))
  if (error instanceof RevisionConflictError) {
    return errorResponse(new ApiError("revision_conflict", "the entity changed since it was read", {
      entityId: error.entityId,
      expectedRevision: error.expectedRevision,
    }))
  }
  if (error instanceof IdempotencyConflictError) {
    return errorResponse(new ApiError("idempotency_conflict", "Idempotency-Key was used with a different request"))
  }
  return null
}
