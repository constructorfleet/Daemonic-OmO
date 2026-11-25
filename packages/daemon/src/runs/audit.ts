import { createHash } from "node:crypto"

import { ulid } from "../core/ids"
import type { Clock, Rng } from "../core/ports"
import { PERMISSION_MODE, type JsonObject, type Run, type UserId } from "../core/types"
import type { createAuditRepository } from "../db/repos/audit"

export type RunAuditAction = "run.spawn" | "run.cancel" | "run.hold_release" | "run.steer"
export type KillSwitchAuditAction = "kill_switch.engage" | "kill_switch.release"

export interface AuditDeps {
  readonly audit: ReturnType<typeof createAuditRepository>
  readonly clock: Clock
  readonly rng: Rng
}

const PROMPT_HEAD_CHARS = 500

export interface RunAuditEntry {
  readonly action: RunAuditAction
  readonly run: Run
  /** The text the action sent; defaults to the run prompt. */
  readonly text?: string
  readonly detail: JsonObject
}

/**
 * One audit row on the run owner's log for a spawn, steer, cancel or hold release, carrying the permission
 * mode and the text's SHA-256 plus its first 500 characters (never the whole text).
 */
export function auditRun(deps: AuditDeps, { action, run, text, detail }: RunAuditEntry): void {
  const prompt = text ?? run.spec.prompt
  deps.audit.put({
    id: ulid(deps.rng, deps.clock.now()),
    at: new Date(deps.clock.now()).toISOString(),
    userId: run.userId,
    action,
    entityKind: "run",
    entityId: run.id,
    detail: {
      runId: run.id,
      projectId: run.projectId,
      permissionMode: run.permissionMode ?? PERMISSION_MODE,
      promptSha256: createHash("sha256").update(prompt).digest("hex"),
      promptHead: prompt.slice(0, PROMPT_HEAD_CHARS),
      ...detail,
    },
  })
}

export function auditKillSwitch(deps: AuditDeps, action: KillSwitchAuditAction, userId: UserId, detail: JsonObject): void {
  deps.audit.put({
    id: ulid(deps.rng, deps.clock.now()),
    at: new Date(deps.clock.now()).toISOString(),
    userId,
    action,
    entityKind: "user",
    entityId: userId,
    detail: { permissionMode: PERMISSION_MODE, ...detail },
  })
}
