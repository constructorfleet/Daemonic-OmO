import type { GatewayResult, ThreadSnapshot } from "../core/ports"
import type { RunId, ThreadId } from "../core/types"
import { auditRun } from "./audit"
import { armRun, expireRun, finishRun, loseRun, requireProject, settleRun, startRun, type EngineCore } from "./lifecycle"
import { orphanChildren } from "./termination"
import { endsWithAssistant, findSessionFile, transcriptContains } from "./session-files"

/** Engine input that releases an `unattended` hold when the session already holds the run prompt. */
export const RESUME_TEXT = "Resume the interrupted task."

export class RunRecoveryError extends Error {
  readonly name = "RunRecoveryError"

  constructor(readonly runId: RunId, readonly step: string, readonly detail: string) {
    super(`run ${runId}: recovery ${step} failed: ${detail}`)
  }
}

type Listing = ReadonlyMap<ThreadId, ThreadSnapshot> | null

async function listThreads(core: EngineCore): Promise<Listing> {
  const listed: GatewayResult<readonly ThreadSnapshot[]> = await core.gateway.list({ allScope: true })
  return listed.kind === "ok" ? new Map(listed.value.map((snapshot) => [snapshot.thread, snapshot])) : null
}

/**
 * After an operator restart a restored session is held `unattended` and an SDK send runs no turn (FINDINGS
 * assertion 7). The hold is released with engine input: the run prompt when the transcript does not hold it
 * yet, otherwise RESUME_TEXT, so the prompt is never delivered twice; then the run's model is re-applied
 * because the restore reverts it.
 */
async function releaseHold(core: EngineCore, id: RunId): Promise<void> {
  const run = core.records.require(id)
  if (run.state !== "active" || run.threadId === undefined) return
  const state = await core.gateway.sessionState(run.threadId)
  if (state.kind === "error" || !state.value.held) return
  const project = requireProject(core, run)
  const file = run.sessionFile ?? await findSessionFile(core.fs, project.agentDir, run.threadId)
  const delivered = file !== null && await transcriptContains(core.fs, file, run.spec.prompt, core.readBytes)
  const text = delivered ? RESUME_TEXT : run.spec.prompt
  const released = await core.gateway.releaseHold(run.threadId, text)
  if (released.kind === "error") {
    core.report(new RunRecoveryError(id, "releaseHold", `${released.code}: ${released.message}`))
    return
  }
  auditRun(core.audit, { action: "run.hold_release", run, text, detail: { disposition: released.value.disposition, promptDelivered: delivered } })
  if (run.spec.model === undefined) return
  const remodeled = await core.gateway.setModel({ thread: run.threadId, model: run.spec.model })
  if (remodeled.kind === "error") core.report(new RunRecoveryError(id, "setModel", `${remodeled.code}: ${remodeled.message}`))
}

async function recoverActive(core: EngineCore, id: RunId, listing: Listing): Promise<void> {
  const run = core.records.require(id)
  if (run.state !== "active" || run.threadId === undefined) return
  if (listing !== null && !listing.has(run.threadId)) {
    loseRun(core, run)
    return
  }
  await releaseHold(core, id)
  await armRun(core, core.records.require(id))
}

/**
 * Daemon start: `creating` calls `create` again under the same key (it reopens the thread; a prompt inside
 * create is not redelivered), `active` is reconciled with `list` (missing -> lost, never respawned),
 * `settled`/`evaluating` are evaluated again, held sessions are released, and threads the daemon had closed
 * that the restore lists again are closed again.
 */
export async function recoverRuns(core: EngineCore): Promise<void> {
  const listing = await listThreads(core)
  for (const run of core.records.unfinished()) {
    switch (run.state) {
      case "creating":
        await core.serial(run.id, async () => {
          await startRun(core, run.id)
          await releaseHold(core, run.id)
        })
        break
      case "active":
        await core.serial(run.id, () => recoverActive(core, run.id, listing))
        break
      case "settled":
      case "evaluating":
        await core.serial(run.id, () => finishRun(core, run.id))
        break
      case "queued":
      case "closed":
      case "kept":
        break
      default:
        throw new TypeError(`unexpected run state: ${JSON.stringify(run.state)}`)
    }
  }
  if (listing !== null) await recloseResurrected(core, listing)
  core.requestDispatch()
}

async function recloseResurrected(core: EngineCore, listing: NonNullable<Listing>): Promise<void> {
  const live = [...listing.values()].filter((snapshot) => snapshot.state !== "inactive").map((snapshot) => snapshot.thread)
  for (const run of core.records.closedOnThreads(live)) {
    if (run.threadId === undefined) continue
    const closed = await core.gateway.close({ thread: run.threadId, graceful: true, waitMs: core.waits.unattendedCloseMs })
    if (closed.kind === "error") core.report(new RunRecoveryError(run.id, "reclose", `${closed.code}: ${closed.message}`))
  }
}

async function superviseActive(core: EngineCore, id: RunId, listing: Listing): Promise<void> {
  const run = core.records.require(id)
  if (run.state !== "active" || run.threadId === undefined) return
  if (core.clock.now() >= Date.parse(run.activeAt ?? run.updatedAt) + run.spec.timeoutMs) {
    await expireRun(core, id)
    return
  }
  const snapshot = listing?.get(run.threadId)
  if (listing !== null && snapshot === undefined) {
    loseRun(core, run)
    return
  }
  const project = requireProject(core, run)
  const file = run.sessionFile ?? await findSessionFile(core.fs, project.agentDir, run.threadId)
  if (file === null) return
  const current = run.sessionFile === undefined ? core.records.patch(run, { sessionFile: file }) : run
  if (snapshot?.state === "idle" && await endsWithAssistant(core.fs, file)) {
    await settleRun(core, current.id, { kind: "succeeded" })
  }
}

/**
 * The periodic pass: the idle-plus-final-assistant completion fallback, overdue timeouts (a timeout whose stop
 * was refused is retried here), threads that vanished, and orphan children that settled since the close.
 */
export async function superviseRuns(core: EngineCore): Promise<void> {
  const active = core.records.unfinished().filter((run) => run.state === "active")
  if (active.length > 0) {
    const listing = await listThreads(core)
    for (const run of active) await core.serial(run.id, () => superviseActive(core, run.id, listing))
  }
  for (const run of core.records.withOrphans()) {
    await core.serial(run.id, async () => {
      const latest = core.records.require(run.id)
      const orphans = orphanChildren(latest, requireProject(core, latest))
      if (orphans.length !== latest.orphanChildren.length) core.records.patch(latest, { orphanChildren: orphans })
    })
  }
}
