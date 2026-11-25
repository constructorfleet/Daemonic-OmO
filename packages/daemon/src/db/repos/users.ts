import type { Database } from "bun:sqlite"
import { parseUlid } from "../../core/ids"
import type { User, UserRole, UserSettings } from "../../core/types"
import { RepositoryDataError } from "./errors"
import { parseRecord } from "./json"

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
  for (const key of ["maxRunning", "maxRunningPerProject", "runTimeoutMs", "readBytes", "loopMaxIterations"]) {
    const setting = settings[key]
    if (setting !== undefined && typeof setting !== "number") throw new RepositoryDataError("user")
  }
  return {
    ...(typeof settings.maxRunning === "number" ? { maxRunning: settings.maxRunning } : {}),
    ...(typeof settings.maxRunningPerProject === "number"
      ? { maxRunningPerProject: settings.maxRunningPerProject } : {}),
    ...(typeof settings.runTimeoutMs === "number" ? { runTimeoutMs: settings.runTimeoutMs } : {}),
    ...(typeof settings.readBytes === "number" ? { readBytes: settings.readBytes } : {}),
    ...(typeof settings.loopMaxIterations === "number"
      ? { loopMaxIterations: settings.loopMaxIterations } : {}),
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

export function createUserRepository(db: Database) {
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
      db.query(
        `INSERT INTO users(id, oidc_issuer, oidc_sub, email, name, role, agent_dir,
          allowed_roots_json, settings_json, created_at, updated_at, last_login_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET oidc_issuer = excluded.oidc_issuer,
          oidc_sub = excluded.oidc_sub, email = excluded.email, name = excluded.name,
          role = excluded.role, agent_dir = excluded.agent_dir,
          allowed_roots_json = excluded.allowed_roots_json, settings_json = excluded.settings_json,
          updated_at = excluded.updated_at, last_login_at = excluded.last_login_at`,
      ).run(
        user.id,
        user.oidcIssuer,
        user.oidcSub,
        user.email,
        user.name,
        user.role,
        user.agentDir,
        JSON.stringify(user.allowedRoots),
        JSON.stringify(user.settings),
        user.createdAt,
        user.updatedAt,
        user.lastLoginAt,
      )
    },
  }
}
