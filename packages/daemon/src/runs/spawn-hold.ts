import type { Database } from "bun:sqlite"

import type { Iso, UserId } from "../core/types"

const KEY_PREFIX = "runs.spawn_hold:"

/** Set by the kill switch and cleared only by `POST /api/v1/kill-switch/release`; kept in `meta` so it survives restarts. */
export function isSpawnHeld(db: Database, userId: UserId): boolean {
  return db.query<{ readonly key: string }, [string]>("SELECT key FROM meta WHERE key = ?").get(`${KEY_PREFIX}${userId}`) !== null
}

export function setSpawnHold(db: Database, userId: UserId, at: Iso): void {
  db.query("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(`${KEY_PREFIX}${userId}`, JSON.stringify({ at }))
}

export function clearSpawnHold(db: Database, userId: UserId): boolean {
  return db.query("DELETE FROM meta WHERE key = ?").run(`${KEY_PREFIX}${userId}`).changes > 0
}
