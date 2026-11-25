import { isPlainObject, type Reader } from "./reader"

const ALLOWED_KEYS: Readonly<Record<string, readonly string[]>> = {
  "": [
    "listen",
    "publicUrl",
    "trustedHosts",
    "oidc",
    "trustedProxies",
    "users",
    "defaults",
    "hardCaps",
    "limits",
    "omo",
  ],
  listen: ["host", "port"],
  oidc: [
    "issuer",
    "clientId",
    "clientSecretFile",
    "scopes",
    "groupsClaim",
    "adminGroup",
    "adminSubjects",
    "redirectPath",
  ],
  "oidc.adminSubjects": ["issuer", "sub"],
  users: ["defaultAgentDirRoot", "allowSelfSignup", "bootstrapAdmin"],
  "users.bootstrapAdmin": ["oidcSub", "email", "agentDir"],
  defaults: [
    "maxRunning",
    "maxRunningPerProject",
    "loopMaxIterations",
    "loopMaxWallMs",
    "runTimeoutMs",
    "overlap",
    "misfire",
    "misfireGraceMs",
    "skipMisfireGraceMs",
    "onceMisfireGraceMs",
    "queueMax",
    "queueMinExpiryMs",
    "maxCatchup",
    "readBytes",
  ],
  hardCaps: [
    "maxRunning",
    "maxRunningPerProject",
    "loopMaxIterations",
    "loopMaxWallMs",
    "runTimeoutMs",
    "readBytes",
  ],
  limits: [
    "sessionTtlMs",
    "eventRetentionDays",
    "eventRetentionMinRows",
    "sseSubscriberMaxFrames",
    "sseSubscriberMaxBytes",
    "idempotencyTtlMs",
    "machineMaxRunning",
    "maxKeptWorktreesPerProject",
    "auditRetentionDays",
    "loopCheckTimeoutMs",
    "observerActivePollMs",
    "observerIdlePollMs",
    "observerMaxOpenDocs",
    "observerIdleEvictMs",
    "observerMaxTurns",
    "observerMaxEventLines",
    "observerMaxOlderTurns",
    "observerPageMaxTurns",
    "observerImageCacheBytes",
    "threadMessageMaxBytes",
    "threadQueueTtlMs",
    "omoCommandTimeoutMs",
    "omoCommandStderrTailChars",
    "schedulerMaxTickIntervalMs",
    "schedulerClockJumpMs",
    "scheduleHorizonMs",
    "schedulePreviewMaxCount",
  ],
  omo: ["bin", "pluginRoot"],
}

export function collectUnknownKeys(
  value: Record<string, unknown>,
  schemaPath: string,
  displayPath: string,
  reader: Reader,
): void {
  const allowed = ALLOWED_KEYS[schemaPath]
  if (allowed === undefined) return
  for (const key of Object.keys(value)) {
    const childDisplay = displayPath.length === 0 ? key : `${displayPath}.${key}`
    if (!allowed.includes(key)) {
      reader.issue(childDisplay, "unknown key")
      continue
    }
    const child = value[key]
    const childSchema = schemaPath.length === 0 ? key : `${schemaPath}.${key}`
    if (ALLOWED_KEYS[childSchema] === undefined) continue
    if (Array.isArray(child) && childSchema === "oidc.adminSubjects") {
      child.forEach((entry, index) => {
        if (isPlainObject(entry)) {
          collectUnknownKeys(entry, childSchema, `${childDisplay}[${index}]`, reader)
        }
      })
    } else if (isPlainObject(child)) {
      collectUnknownKeys(child, childSchema, childDisplay, reader)
    }
  }
}
