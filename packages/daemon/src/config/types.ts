import type { MisfirePolicy, OverlapPolicy } from "../core/types"

export type Env = Readonly<Record<string, string | undefined>>

export interface ListenConfig {
  readonly host: string
  readonly port: number
}

export interface OidcAdminSubject {
  readonly issuer: string
  readonly sub: string
}

export interface OidcConfig {
  readonly issuer: string
  readonly clientId: string
  readonly clientSecretFile: string
  readonly scopes: readonly string[]
  readonly groupsClaim?: string
  readonly adminGroup?: string
  readonly adminSubjects: readonly OidcAdminSubject[]
  readonly redirectPath: string
}

export interface BootstrapAdminConfig {
  readonly oidcSub?: string
  readonly email?: string
  readonly agentDir: string
}

export interface UsersConfig {
  readonly defaultAgentDirRoot: string
  readonly allowSelfSignup: boolean
  readonly bootstrapAdmin: BootstrapAdminConfig
}

export interface DefaultsConfig {
  readonly maxRunning: number
  readonly maxRunningPerProject: number
  readonly loopMaxIterations: number
  readonly loopMaxWallMs: number
  readonly runTimeoutMs: number
  readonly overlap: OverlapPolicy
  readonly misfire: MisfirePolicy
  readonly misfireGraceMs: number
  readonly maxCatchup: number
  readonly readBytes: number
}

export interface HardCapsConfig {
  readonly maxRunning: number
  readonly maxRunningPerProject: number
  readonly loopMaxIterations: number
  readonly loopMaxWallMs: number
  readonly runTimeoutMs: number
  readonly readBytes: number
}

export interface LimitsConfig {
  readonly sessionTtlMs: number
  readonly eventRetentionDays: number
  readonly eventRetentionMinRows: number
  readonly sseSubscriberMaxFrames: number
  readonly sseSubscriberMaxBytes: number
  readonly idempotencyTtlMs: number
  readonly machineMaxRunning: number
  readonly maxKeptWorktreesPerProject: number
  readonly auditRetentionDays: number
  readonly loopCheckTimeoutMs: number
  readonly observerActivePollMs: number
  readonly observerIdlePollMs: number
  readonly observerMaxOpenDocs: number
  readonly observerIdleEvictMs: number
  readonly observerMaxTurns: number
  readonly observerMaxEventLines: number
  readonly observerMaxOlderTurns: number
  readonly observerPageMaxTurns: number
  readonly observerImageCacheBytes: number
  readonly threadMessageMaxBytes: number
  readonly threadQueueTtlMs: number
}

export interface OmoConfig {
  readonly bin: string
  readonly pluginRoot: string
}

export interface Config {
  readonly listen: ListenConfig
  readonly publicUrl: string
  readonly trustedHosts: readonly string[]
  readonly oidc?: OidcConfig
  readonly trustedProxies: readonly string[]
  readonly users: UsersConfig
  readonly defaults: DefaultsConfig
  readonly hardCaps: HardCapsConfig
  readonly limits: LimitsConfig
  readonly omo: OmoConfig
}

export const DEFAULT_HOME_DIR_NAME = ".omo-daemonic"
export const CONFIG_FILE_NAME = "config.jsonc"

export const DEFAULT_LISTEN: ListenConfig = { host: "127.0.0.1", port: 8787 }
export const DEFAULT_PUBLIC_URL = "http://127.0.0.1:8787"
export const DEFAULT_SCOPES: readonly string[] = ["openid", "profile", "email"]
export const DEFAULT_REDIRECT_PATH = "/auth/callback"
export const DEFAULT_AGENT_DIR_ROOT = "~/.omo-daemonic/agents"
export const DEFAULT_BOOTSTRAP_AGENT_DIR = "~/.omo/agent"
export const READ_BYTES_FLOOR = 65_536

export const DEFAULT_DEFAULTS: DefaultsConfig = {
  maxRunning: 3,
  maxRunningPerProject: 1,
  loopMaxIterations: 10,
  loopMaxWallMs: 14_400_000,
  runTimeoutMs: 7_200_000,
  overlap: "skip",
  misfire: "fire_once",
  misfireGraceMs: 3_600_000,
  maxCatchup: 50,
  readBytes: 4_194_304,
}

export const DEFAULT_HARD_CAPS: HardCapsConfig = {
  maxRunning: 32,
  maxRunningPerProject: 16,
  loopMaxIterations: 100,
  loopMaxWallMs: 172_800_000,
  runTimeoutMs: 86_400_000,
  readBytes: 67_108_864,
}

export const DEFAULT_LIMITS: LimitsConfig = {
  sessionTtlMs: 43_200_000,
  eventRetentionDays: 30,
  eventRetentionMinRows: 100_000,
  sseSubscriberMaxFrames: 5_000,
  sseSubscriberMaxBytes: 8_388_608,
  idempotencyTtlMs: 86_400_000,
  machineMaxRunning: 8,
  maxKeptWorktreesPerProject: 50,
  auditRetentionDays: 180,
  loopCheckTimeoutMs: 600_000,
  observerActivePollMs: 1_000,
  observerIdlePollMs: 10_000,
  observerMaxOpenDocs: 32,
  observerIdleEvictMs: 300_000,
  observerMaxTurns: 500,
  observerMaxEventLines: 10_000,
  observerMaxOlderTurns: 5_000,
  observerPageMaxTurns: 500,
  observerImageCacheBytes: 67_108_864,
  threadMessageMaxBytes: 1_048_576,
  threadQueueTtlMs: 86_400_000,
}
