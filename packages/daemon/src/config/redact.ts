import type { HomeLayout } from "./home"
import type { Secrets } from "./secrets"
import type { Config } from "./types"

export const SECRET_PLACEHOLDER = "[redacted]"

export interface LoadedConfig {
  readonly config: Config
  readonly home: HomeLayout
  readonly secrets: Secrets
}

export interface RedactedConfig {
  readonly config: Config
  readonly home: HomeLayout
  readonly secrets: Secrets
}

export function redactSecrets(loaded: LoadedConfig): RedactedConfig {
  return {
    config: loaded.config,
    home: loaded.home,
    secrets: {
      breakglassToken: SECRET_PLACEHOLDER,
      sessionKey: SECRET_PLACEHOLDER,
    },
  }
}
