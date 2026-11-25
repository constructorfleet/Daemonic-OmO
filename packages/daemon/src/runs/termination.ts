import { resolveTaskStateDir, loadTaskRecords } from "@omo-daemonic/store"

import { sessionId as toSessionId } from "../core/ids"
import type { Gateway } from "../core/ports"
import type { Ms, OrphanChild, Project, Run, ThreadId } from "../core/types"

export interface StopWaits {
  /** `close({graceful})` wait after the interrupt of a cancel or timeout (plan: 10 s). */
  readonly graceMs: Ms
}

export type StopResult = { readonly kind: "stopped" } | { readonly kind: "unreachable"; readonly detail: string }

/**
 * Cancel and timeout: `interrupt`, then `close({graceful, wait_ms})`, then `close({force})`. A thread that is
 * already gone (`not_live`) counts as stopped; `unreachable` means even the forced close was refused.
 */
export async function stopThread(gateway: Gateway, thread: ThreadId, waits: StopWaits): Promise<StopResult> {
  await gateway.interrupt({ thread, allScope: true })
  const graceful = await gateway.close({ thread, graceful: true, waitMs: waits.graceMs })
  if (graceful.kind === "ok" && (graceful.value.closed || graceful.value.reason === "not_live")) return { kind: "stopped" }
  const forced = await gateway.close({ thread, force: true })
  if (forced.kind === "ok" && (forced.value.closed || forced.value.reason === "not_live")) return { kind: "stopped" }
  const detail = forced.kind === "error" ? `${forced.code}: ${forced.message}` : `close answered ${forced.value.reason}`
  return { kind: "unreachable", detail }
}

/**
 * Child tasks of the run's root session whose record has no `terminal_at` yet: they can outlive the close
 * (FINDINGS assertion 9) and stay listed on the run until they settle.
 */
export function orphanChildren(run: Run, project: Pick<Project, "cwd" | "stateDir" | "agentDir">): readonly OrphanChild[] {
  if (run.sessionId === undefined) return []
  const stateDir = run.cwd === project.cwd ? project.stateDir : resolveTaskStateDir(run.cwd, { agentDir: project.agentDir })
  return loadTaskRecords(stateDir).records
    .filter((record) => record.root_session_id === run.sessionId && record.terminal_at === undefined && record.task_id !== run.sessionId)
    .map((record) => ({
      taskId: record.task_id,
      sessionId: toSessionId(record.child_session_id ?? record.task_id),
      state: record.status,
    }))
}
