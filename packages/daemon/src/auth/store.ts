import type { Database } from "bun:sqlite"
import { parseUlid } from "../core/ids"
import type { UserId } from "../core/types"

const BOOTSTRAP_ADMIN_KEY = "auth.bootstrap_admin_user_id"

// Auth writes the Todo 7 repositories do not expose yet (session sliding and
// deletion, the bootstrap admin pointer). Follow-up: move into db/repos.
export function createAuthStore(db: Database) {
  return {
    extendSession(id: string, expiresAt: string): void {
      db.query("UPDATE sessions SET expires_at = ? WHERE id = ?").run(expiresAt, id)
    },
    deleteSession(id: string): void {
      db.query("DELETE FROM sessions WHERE id = ?").run(id)
    },
    bootstrapAdminId(): UserId | null {
      const row = db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?")
        .get(BOOTSTRAP_ADMIN_KEY)
      return row === null ? null : parseUlid(row.value)
    },
    recordBootstrapAdmin(id: UserId): void {
      db.query(
        "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(BOOTSTRAP_ADMIN_KEY, id)
    },
  }
}

export type AuthStore = ReturnType<typeof createAuthStore>
