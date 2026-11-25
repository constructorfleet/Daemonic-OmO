export class RevisionConflictError extends Error {
  readonly name = "RevisionConflictError"
  readonly code = "revision_conflict"

  constructor(readonly entityId: string, readonly expectedRevision: number) {
    super(`revision_conflict: ${entityId} expected revision ${expectedRevision}`)
  }
}

export class IdempotencyConflictError extends Error {
  readonly name = "IdempotencyConflictError"
  readonly code = "idempotency_conflict"

  constructor(readonly key: string) {
    super(`idempotency_conflict: ${key}`)
  }
}

export class RepositoryDataError extends Error {
  readonly name = "RepositoryDataError"

  constructor(readonly entity: string) {
    super(`invalid stored ${entity} record`)
  }
}
