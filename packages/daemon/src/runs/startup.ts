import type { CreateOutcome, CreateThreadArgs, GatewayErrorCode, GatewayResult } from "../core/ports"
import type { Project, Run, RunFailureReason } from "../core/types"
import type { EngineCore } from "./lifecycle"
import { findSessionFile, transcriptContainsSince } from "./session-files"

const TRANSIENT: readonly GatewayErrorCode[] = ["bridge_restarted", "bridge_timeout"]

export function failureReason(code: GatewayErrorCode): RunFailureReason {
  if (code === "host_unavailable") return "host_unavailable"
  return code === "sdk_unavailable" || code === "gateway_degraded" ? "gateway_degraded" : "create_refused"
}

/** Creates an unattended thread under its per-run idempotency key. */
export async function createRunThread(core: EngineCore, run: Run, project: Project): Promise<GatewayResult<CreateOutcome>> {
  const args: CreateThreadArgs = {
    name: run.name,
    cwd: run.cwd,
    prompt: run.spec.prompt,
    idempotencyKey: `${run.fireKey}:${run.attempt}`,
    ...(run.spec.model === undefined ? {} : { model: run.spec.model }),
    ...(run.spec.thinking === undefined ? {} : { reasoning: run.spec.thinking }),
  }
  const first = await core.gateway.create(args)
  if (first.kind === "ok") return first
  if (first.code === "host_unavailable") {
    const ensured = await core.gateway.ensureHost({ agentDir: project.agentDir })
    if (ensured.kind === "error") return { ...first, message: `${first.message}; ensureHost ${ensured.code}: ${ensured.message}` }
    return core.gateway.create(args)
  }
  return TRANSIENT.includes(first.code) ? core.gateway.create(args) : first
}

/** Sends a follow-up exactly once, resuming a held session or creating a fresh thread if it was lost. */
export async function continueRunThread(core: EngineCore, run: Run, project: Project): Promise<GatewayResult<CreateOutcome>> {
  if (run.threadId === undefined) throw new TypeError("continuation run has no thread")
  const state = await core.gateway.sessionState(run.threadId)
  if (state.kind === "ok" && state.value.held) {
    const file = run.sessionFile ?? await findSessionFile(core.fs, project.agentDir, run.threadId)
    const delivered = file !== null && await transcriptContainsSince(core.fs, {
      file,
      text: run.spec.prompt,
      baseline: run.transcriptBaselineBytes ?? 0,
      maxBytes: core.readBytes,
    })
    const released = await core.gateway.releaseHold(run.threadId, delivered ? "Resume the interrupted task." : run.spec.prompt)
    if (released.kind === "error") return released
    return { kind: "ok", value: { thread: run.threadId, sessionId: run.sessionId ?? null, created: false } }
  }
  const sent = await core.gateway.send({
    thread: run.threadId,
    text: run.spec.prompt,
    mode: "follow_up",
    idempotencyKey: `${run.fireKey}:${run.attempt}`,
  })
  if (sent.kind === "ok") {
    return { kind: "ok", value: { thread: run.threadId, sessionId: run.sessionId ?? null, created: false } }
  }
  if (sent.code !== "not_resumable") return sent
  core.records.patch(run, { transcriptBaselineBytes: 0 })
  return createRunThread(core, run, project)
}

