export const CONFIG_ERROR_CODES = [
  "invalid_config",
  "unauthenticated_exposure_refused",
  "insecure_exposure_refused",
  "secrets_unavailable",
] as const
export type ConfigErrorCode = (typeof CONFIG_ERROR_CODES)[number]

export interface ConfigIssue {
  readonly path: string
  readonly message: string
}

export interface ConfigErrorOptions {
  readonly path?: string
  readonly issues?: readonly ConfigIssue[]
  readonly cause?: unknown
}

export class ConfigError extends Error {
  readonly code: ConfigErrorCode
  readonly path: string | null
  readonly issues: readonly ConfigIssue[]

  constructor(code: ConfigErrorCode, summary: string, options: ConfigErrorOptions = {}) {
    super(summary, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = "ConfigError"
    this.code = code
    this.path = options.path ?? options.issues?.[0]?.path ?? null
    this.issues = options.issues ?? []
  }
}
