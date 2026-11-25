import type { Database } from "bun:sqlite"

import { parseUlid } from "../core/ids"
import type { EventLedger } from "../db/ledger"
import { isRecord } from "./decode"
import type { CompatCheck, CompatReport } from "./probe"

/** `meta` key of the newest CompatReport; `/health` and the admin compat route read it with `readCompatReport`. */
export const COMPAT_META_KEY = "omo.compat"
export const COMPAT_EVENT_TYPE = "daemon.compat"

/** Stores the report and emits one `daemon.compat` entity event per user stream, in one transaction. */
export function saveCompatReport(db: Database, ledger: EventLedger, report: CompatReport): void {
  const users = db.query<{ id: string }, []>("SELECT id FROM users ORDER BY id").all().flatMap((row) => {
    const id = parseUlid(row.id)
    return id === null ? [] : [id]
  })
  ledger.transact((transaction) => {
    transaction.execute(
      "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [COMPAT_META_KEY, JSON.stringify(report)],
    )
    for (const userId of users) {
      transaction.emit({ at: report.checkedAt, type: COMPAT_EVENT_TYPE, entityKind: "daemon", entityId: "compat", userId, projectId: null, data: report })
    }
  })
}

export function readCompatReport(db: Database): CompatReport | null {
  const row = db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get(COMPAT_META_KEY)
  return row === null ? null : parseCompatReport(JSON.parse(row.value))
}

function parseCompatReport(value: unknown): CompatReport | null {
  if (!isRecord(value) || !Array.isArray(value.checks) || !Array.isArray(value.presets)) return null
  const { omoVersion, testedVersion, checkedAt, permissionMode } = value
  if ((omoVersion !== null && typeof omoVersion !== "string") || typeof testedVersion !== "string" || typeof checkedAt !== "string") return null
  if (permissionMode !== "agent-dir-default") return null
  const checks = value.checks.flatMap((check): CompatCheck[] => {
    if (!isRecord(check) || typeof check.name !== "string" || typeof check.ok !== "boolean" || typeof check.detail !== "string") return []
    return [{ name: check.name, ok: check.ok, detail: check.detail, agentDir: typeof check.agentDir === "string" ? check.agentDir : null }]
  })
  const presets = value.presets.filter((preset) => typeof preset === "string")
  return { omoVersion, testedVersion, presets, permissionMode, checkedAt, checks }
}
