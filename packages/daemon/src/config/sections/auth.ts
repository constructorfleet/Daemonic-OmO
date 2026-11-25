import { isPlainObject, type Reader } from "../reader"
import { collectUnknownKeys } from "../schema-keys"
import {
  DEFAULT_AGENT_DIR_ROOT,
  DEFAULT_BOOTSTRAP_AGENT_DIR,
  DEFAULT_REDIRECT_PATH,
  DEFAULT_SCOPES,
  type OidcAdminSubject,
  type OidcConfig,
  type UsersConfig,
} from "../types"

export function readUsers(reader: Reader, raw: Record<string, unknown>): UsersConfig {
  const bootstrap = reader.section("users.bootstrapAdmin", raw.bootstrapAdmin)
  return {
    defaultAgentDirRoot: reader.homePath(
      "users.defaultAgentDirRoot",
      raw.defaultAgentDirRoot,
      DEFAULT_AGENT_DIR_ROOT,
    ),
    allowSelfSignup: reader.boolean("users.allowSelfSignup", raw.allowSelfSignup, false),
    bootstrapAdmin: {
      oidcSub: reader.optionalString("users.bootstrapAdmin.oidcSub", bootstrap.oidcSub),
      email: reader.optionalString("users.bootstrapAdmin.email", bootstrap.email),
      agentDir: reader.homePath(
        "users.bootstrapAdmin.agentDir",
        bootstrap.agentDir,
        DEFAULT_BOOTSTRAP_AGENT_DIR,
      ),
    },
  }
}

export function readOidc(reader: Reader, raw: Record<string, unknown>): OidcConfig {
  const groupsClaim = reader.optionalString("oidc.groupsClaim", raw.groupsClaim)
  const adminGroup = reader.optionalString("oidc.adminGroup", raw.adminGroup)
  if (adminGroup !== undefined && groupsClaim === undefined) {
    reader.issue("oidc.adminGroup", "requires oidc.groupsClaim to be set")
  }
  const redirectPath = reader.string("oidc.redirectPath", raw.redirectPath, DEFAULT_REDIRECT_PATH)
  if (!redirectPath.startsWith("/")) {
    reader.issue("oidc.redirectPath", 'must start with "/"')
  }
  return {
    issuer: reader.requiredUrl("oidc.issuer", raw.issuer),
    clientId: reader.requiredString("oidc.clientId", raw.clientId),
    clientSecretFile: reader.requiredHomePath("oidc.clientSecretFile", raw.clientSecretFile),
    scopes: reader.stringArray("oidc.scopes", raw.scopes, DEFAULT_SCOPES),
    groupsClaim,
    adminGroup,
    adminSubjects: readAdminSubjects(reader, raw.adminSubjects),
    redirectPath,
  }
}

function readAdminSubjects(reader: Reader, value: unknown): readonly OidcAdminSubject[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    reader.issue("oidc.adminSubjects", "must be an array of {issuer, sub} objects")
    return []
  }
  return value.map((entry, index) => {
    const path = `oidc.adminSubjects[${index}]`
    if (!isPlainObject(entry)) {
      reader.issue(path, "must be an {issuer, sub} object")
      return { issuer: "", sub: "" }
    }
    collectUnknownKeys(entry, "oidc.adminSubjects", path, reader)
    return {
      issuer: reader.requiredUrl(`${path}.issuer`, entry.issuer),
      sub: reader.requiredString(`${path}.sub`, entry.sub),
    }
  })
}
