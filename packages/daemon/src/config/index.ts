import { homedir } from "node:os"
import { basename } from "node:path"
import type { Rng } from "../core/ports"
import { resolveHome, ensureHome, homeLayout } from "./home"
import { parseConfig, readConfigText } from "./jsonc"
import { resolveOmoDefaults } from "./omo-defaults"
import { redactSecrets, type LoadedConfig } from "./redact"
import { ensureSecrets } from "./secrets"
import { validateConfig } from "./validate"
import type { Env, OmoConfig } from "./types"

export interface LoadConfigOptions {
  readonly env?: Env
  readonly home?: string
  readonly homeDir?: string
  readonly rng?: Rng
  readonly resolveOmo?: () => OmoConfig
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<LoadedConfig> {
  const env = options.env ?? process.env
  const homeDir = options.homeDir ?? homedir()
  const layout = homeLayout(options.home ?? resolveHome(env, homeDir))

  const text = await readConfigText(layout.configFile)
  const raw = text === null ? {} : parseConfig(text, basename(layout.configFile))
  const omo = options.resolveOmo === undefined ? resolveOmoDefaults(env, homeDir) : options.resolveOmo()

  const config = validateConfig(raw, { home: layout.home, homeDir, omo })
  const ensured = await ensureHome(layout.home)
  const secrets = await ensureSecrets(ensured, options.rng)
  return { config, home: ensured, secrets }
}

export { ConfigError, CONFIG_ERROR_CODES } from "./errors"
export type { ConfigErrorCode, ConfigErrorOptions, ConfigIssue } from "./errors"
export { ensureHome, homeLayout, resolveHome } from "./home"
export type { HomeLayout } from "./home"
export { redactSecrets, SECRET_PLACEHOLDER } from "./redact"
export type { LoadedConfig, RedactedConfig } from "./redact"
export { BREAKGLASS_TOKEN_FILE, ensureSecrets, SECRET_BYTES, SESSION_KEY_FILE, systemRng } from "./secrets"
export type { Secrets } from "./secrets"
export type * from "./types"
