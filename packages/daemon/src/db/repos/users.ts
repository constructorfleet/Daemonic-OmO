import type { Database } from "bun:sqlite"
import { parseUlid } from "../../core/ids"
import type { User, UserRole, UserSettings } from "../../core/types"
import type { EventLedger } from "../ledger"
import { RepositoryDataError } from "./errors"
import { parseJsonObject, parseRecord } from "./json"

type UserRow = {
  readonly id: string
  readonly oidc_issuer: string
  readonly oidc_sub: string
  readonly email: string
  readonly name: string
  readonly role: string
  readonly agent_dir: string
  readonly allowed_roots_json: string
  readonly settings_json: string
  readonly created_at: string
  readonly updated_at: string
  readonly last_login_at: string | null
}

function role(value: string): UserRole {
  if (value === "admin" || value === "member") return value
  throw new RepositoryDataError("user")
}

function parseAllowedRoots(value: string): readonly string[] {
  const parsed: unknown = JSON.parse(value)
  if (!Array.isArray(parsed)) {
    throw new RepositoryDataError("user")
  }
  const roots: string[] = []
  for (const root of parsed) {
    if (typeof root !== "string") throw new RepositoryDataError("user")
    roots.push(root)
  }
  return roots
}

function parseSettings(value: string): UserSettings {
  const settings = parseRecord(value, "user")
  const keys = [
    "maxRunning",
    "maxRunningPerProject",
    "runTimeoutMs",
    "readBytes",
    "loopMaxIterations",
    "loopMaxWallMs",
    "loopMaxConsecutiveFailures",
    "loopCheckTimeoutMs",
    "loopCadenceMs",
    "loopBackoffInitialMs",
    "loopBackoffFactor",
    "loopBackoffMaxMs",
    "loopCarryForwardBytes",
  ] as const
  for (const key of keys) {
    const setting = settings[key]
    if (setting !== undefined && typeof setting !== "number") throw new RepositoryDataError("user")
  }
  for (const key of [
    "loopMaxIterations",
    "loopMaxWallMs",
    "loopMaxConsecutiveFailures",
    "loopCheckTimeoutMs",
    "loopCadenceMs",
    "loopBackoffInitialMs",
    "loopBackoffMaxMs",
    "loopCarryForwardBytes",
  ] as const) {
    const setting = settings[key]
    const minimum = key === "loopCadenceMs" || key === "loopBackoffInitialMs" ||
      key === "loopBackoffMaxMs" || key === "loopCarryForwardBytes" ? 0 : 1
    if (setting !== undefined && (typeof setting !== "number" || !Number.isSafeInteger(setting) || setting < minimum)) {
      throw new RepositoryDataError("user")
    }
  }
  if (settings.loopBackoffFactor !== undefined && (typeof settings.loopBackoffFactor !== "number" ||
    !Number.isFinite(settings.loopBackoffFactor) || settings.loopBackoffFactor < 1)) {
    throw new RepositoryDataError("user")
  }
  return {
    ...(typeof settings.maxRunning === "number" ? { maxRunning: settings.maxRunning } : {}),
    ...(typeof settings.maxRunningPerProject === "number"
      ? { maxRunningPerProject: settings.maxRunningPerProject } : {}),
    ...(typeof settings.runTimeoutMs === "number" ? { runTimeoutMs: settings.runTimeoutMs } : {}),
    ...(typeof settings.readBytes === "number" ? { readBytes: settings.readBytes } : {}),
    ...(typeof settings.loopMaxIterations === "number"
      ? { loopMaxIterations: settings.loopMaxIterations } : {}),
    ...(typeof settings.loopMaxWallMs === "number" ? { loopMaxWallMs: settings.loopMaxWallMs } : {}),
    ...(typeof settings.loopMaxConsecutiveFailures === "number"
      ? { loopMaxConsecutiveFailures: settings.loopMaxConsecutiveFailures } : {}),
    ...(typeof settings.loopCheckTimeoutMs === "number" ? { loopCheckTimeoutMs: settings.loopCheckTimeoutMs } : {}),
    ...(typeof settings.loopCadenceMs === "number" ? { loopCadenceMs: settings.loopCadenceMs } : {}),
    ...(typeof settings.loopBackoffInitialMs === "number"
      ? { loopBackoffInitialMs: settings.loopBackoffInitialMs } : {}),
    ...(typeof settings.loopBackoffFactor === "number" ? { loopBackoffFactor: settings.loopBackoffFactor } : {}),
    ...(typeof settings.loopBackoffMaxMs === "number" ? { loopBackoffMaxMs: settings.loopBackoffMaxMs } : {}),
    ...(typeof settings.loopCarryForwardBytes === "number"
      ? { loopCarryForwardBytes: settings.loopCarryForwardBytes } : {}),
  }
}

function decodeUser(row: UserRow): User {
  const id = parseUlid(row.id)
  if (id === null) throw new RepositoryDataError("user")
  return {
    id,
    oidcIssuer: row.oidc_issuer,
    oidcSub: row.oidc_sub,
    email: row.email,
    name: row.name,
    role: role(row.role),
    agentDir: row.agent_dir,
    allowedRoots: parseAllowedRoots(row.allowed_roots_json),
    settings: parseSettings(row.settings_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
  }
}

export function createUserRepository(db: Database, ledger: EventLedger) {
  return {
    get(id: User["id"]): User | null {
      const row = db.query<UserRow, [string]>("SELECT * FROM users WHERE id = ?").get(id)
      return row === null ? null : decodeUser(row)
    },
    findByOidc(issuer: string, subject: string): User | null {
      const row = db.query<UserRow, [string, string]>(
        "SELECT * FROM users WHERE oidc_issuer = ? AND oidc_sub = ?",
      ).get(issuer, subject)
      return row === null ? null : decodeUser(row)
    },
    put(user: User): void {
      ledger.transact((transaction) => {
        transaction.execute(
          `INSERT INTO users(id, oidc_issuer, oidc_sub, email, name, role, agent_dir,
            allowed_roots_json, settings_json, created_at, updated_at, last_login_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET oidc_issuer = excluded.oidc_issuer,
            oidc_sub = excluded.oidc_sub, email = excluded.email, name = excluded.name,
            role = excluded.role, agent_dir = excluded.agent_dir,
            allowed_roots_json = excluded.allowed_roots_json, settings_json = excluded.settings_json,
            updated_at = excluded.updated_at, last_login_at = excluded.last_login_at`,
          [
            user.id, user.oidcIssuer, user.oidcSub, user.email, user.name, user.role, user.agentDir,
            JSON.stringify(user.allowedRoots), JSON.stringify(user.settings), user.createdAt,
            user.updatedAt, user.lastLoginAt,
          ],
        )
        transaction.emit({
          at: user.updatedAt,
          type: "user.upserted",
          entityKind: "user",
          entityId: user.id,
          userId: user.id,
          projectId: null,
          data: parseJsonObject(JSON.stringify(user), "user"),
        })
      })
    },
  }
}
