import { ConfigError, type ConfigIssue } from "./errors"
import { Reader } from "./reader"
import { collectUnknownKeys } from "./schema-keys"
import { readOidc, readUsers } from "./sections/auth"
import { readDefaults, readHardCaps } from "./sections/caps"
import { readLimits } from "./sections/limits"
import { readOmo } from "./sections/omo"
import {
  DEFAULT_LISTEN,
  DEFAULT_PUBLIC_URL,
  type Config,
  type OidcConfig,
  type OmoConfig,
} from "./types"

export interface ValidateContext {
  readonly home: string
  readonly homeDir: string
  readonly omo: OmoConfig
}

export function validateConfig(raw: Record<string, unknown>, context: ValidateContext): Config {
  const reader = new Reader(context.home, context.homeDir)
  collectUnknownKeys(raw, "", "", reader)

  const listenRaw = reader.section("listen", raw.listen)
  const host = reader.string("listen.host", listenRaw.host, DEFAULT_LISTEN.host)
  const port = reader.integer("listen.port", listenRaw.port, DEFAULT_LISTEN.port, {
    min: 1,
    max: 65_535,
  })
  const publicUrl = reader.url("publicUrl", raw.publicUrl, DEFAULT_PUBLIC_URL)
  const trustedHosts =
    raw.trustedHosts === undefined
      ? deriveTrustedHosts(publicUrl, port)
      : reader.stringArray("trustedHosts", raw.trustedHosts, [])
  const trustedProxies = reader.stringArray("trustedProxies", raw.trustedProxies, [])

  const hardCaps = readHardCaps(reader, reader.section("hardCaps", raw.hardCaps))
  const defaults = readDefaults(reader, reader.section("defaults", raw.defaults), hardCaps)
  const limits = readLimits(reader, reader.section("limits", raw.limits), hardCaps)
  const users = readUsers(reader, reader.section("users", raw.users))
  const omo = readOmo(reader, reader.section("omo", raw.omo), context.omo)
  const oidc =
    raw.oidc === undefined ? undefined : readOidc(reader, reader.section("oidc", raw.oidc))

  if (reader.issues.length > 0) {
    throw new ConfigError("invalid_config", summarize(reader.issues), { issues: reader.issues })
  }
  assertExposure(host, publicUrl, oidc)

  return {
    listen: { host, port },
    publicUrl,
    trustedHosts,
    oidc,
    trustedProxies,
    users,
    defaults,
    hardCaps,
    limits,
    omo,
  }
}

function deriveTrustedHosts(publicUrl: string, listenPort: number): readonly string[] {
  const url = new URL(publicUrl)
  const hosts = new Set<string>()
  hosts.add(url.host)
  if (url.hostname !== url.host) hosts.add(url.hostname)
  for (const hostname of ["127.0.0.1", "localhost"]) {
    hosts.add(`${hostname}:${listenPort}`)
    hosts.add(hostname)
  }
  return [...hosts]
}

function assertExposure(host: string, publicUrl: string, oidc: OidcConfig | undefined): void {
  if (isLoopbackHost(host)) return
  if (oidc === undefined) {
    throw new ConfigError(
      "unauthenticated_exposure_refused",
      `listen.host "${host}" is not loopback and oidc is not configured; refusing to expose an unauthenticated daemon`,
      { path: "listen.host" },
    )
  }
  if (new URL(publicUrl).protocol !== "https:") {
    throw new ConfigError(
      "insecure_exposure_refused",
      `publicUrl "${publicUrl}" must be https when listen.host "${host}" is not loopback`,
      { path: "publicUrl" },
    )
  }
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase()
  if (normalized === "localhost" || normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") {
    return true
  }
  if (normalized === "::ffff:127.0.0.1") return true
  return /^127(?:\.\d{1,3}){3}$/.test(normalized)
}

function summarize(issues: readonly ConfigIssue[]): string {
  return issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")
}
