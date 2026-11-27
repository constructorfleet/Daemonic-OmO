import type { TranscriptTurn } from "@omo-daemonic/store"
import { parseSessionTurns } from "@omo-daemonic/store"
import { join } from "node:path"

import { FsError, type Clock, type Fs, type Rng } from "../core/ports"
import type { Loop, LoopBackoff, Run } from "../core/types"
import { tail } from "../omo/command"
import type { LoopCheckRunner } from "./check"

interface PredicateError {
  readonly errorDetail: string
}

type GoalResult =
  | { readonly kind: "missing" | "not_complete" | "complete" }
  | { readonly kind: "error"; readonly detail: string }

export type LoopDecision =
  | { readonly kind: "cancelled"; readonly stopReason: string }
  | { readonly kind: "exhausted"; readonly stopReason: string }
  | { readonly kind: "succeeded" }
  | { readonly kind: "blocked"; readonly stopReason: string }
  | { readonly kind: "failed"; readonly stopReason: string; readonly consecutiveFailures: number; readonly errorDetail?: string }
  | { readonly kind: "continue"; readonly delayMs: number; readonly consecutiveFailures: number; readonly errorDetail?: string }

export interface LoopEvaluationDeps {
  readonly fs: Fs
  readonly clock: Clock
  readonly rng: Rng
  readonly check: LoopCheckRunner
  readonly readBytes: number
  readonly errorTailChars: number
  readonly defaultMaxWallMs: number
  readonly hardMaxIterations: number
  readonly hardMaxWallMs: number
  readonly hardMaxConsecutiveFailures: number
  readonly hardMaxCheckTimeoutMs: number
  readonly hardMaxCadenceMs: number
  readonly hardMaxBackoffMs: number
  readonly hardMaxBackoffFactor: number
}

export interface LoopEvaluationInput {
  readonly loop: Loop
  readonly run: Run
}

/** Applies cancel, budgets, done predicates, and failure policy in the contract order. */
export async function evaluateLoop(deps: LoopEvaluationDeps, input: LoopEvaluationInput): Promise<LoopDecision> {
  const { loop, run } = input
  if (loop.state === "cancelling" || run.cancelRequested || run.outcome?.kind === "cancelled") {
    return { kind: "cancelled", stopReason: loop.stopReason ?? "cancelled" }
  }
  if (loop.iteration >= Math.min(loop.maxIterations, deps.hardMaxIterations)) {
    return { kind: "exhausted", stopReason: "max_iterations" }
  }
  const startedAt = loop.startedAt === undefined ? deps.clock.now() : Date.parse(loop.startedAt)
  const wallBudget = Math.min(loop.maxWallMs ?? deps.defaultMaxWallMs, deps.hardMaxWallMs)
  if (deps.clock.now() - startedAt >= wallBudget) return { kind: "exhausted", stopReason: "max_wall_time" }

  for (const predicate of loop.doneWhen) {
    switch (predicate.kind) {
      case "marker": {
        const marker = await readMarker(deps.fs, loop, run, deps.readBytes)
        if (marker === "done") return { kind: "succeeded" }
        if (typeof marker === "object") return { kind: "blocked", stopReason: marker.reason }
        break
      }
      case "goal": {
        if (run.sessionId === undefined) break
        const goal = await readGoal(deps.fs, { cwd: run.cwd, sessionId: run.sessionId, maxBytes: deps.readBytes })
        if (goal.kind === "complete") return { kind: "succeeded" }
        if (goal.kind === "error") {
          return failureDecision(deps, loop, { errorDetail: goal.detail })
        }
        break
      }
      case "check": {
        const result = await deps.check({
          command: predicate.command,
          cwd: loop.worktreePath ?? run.cwd,
          timeoutMs: Math.min(predicate.timeoutMs, deps.hardMaxCheckTimeoutMs),
        })
        if (result.exitCode === 0 && !result.timedOut) return { kind: "succeeded" }
        if (result.exitCode === null || result.timedOut) {
          const detail = result.timedOut
            ? "loop check timed out"
            : `loop check could not start: ${tail(result.stderr || result.stdout, deps.errorTailChars)}`
          return failureDecision(deps, loop, { errorDetail: detail })
        }
        break
      }
      default:
        return assertNever(predicate)
    }
  }

  if (run.outcome?.kind !== "succeeded") {
    return failureDecision(deps, loop, {
      errorDetail: run.errorDetail ?? `iteration ${run.iteration ?? loop.iteration} ended ${run.outcome?.kind ?? "without an outcome"}`,
    })
  }
  return { kind: "continue", consecutiveFailures: 0, delayMs: Math.min(loop.cadenceMs, deps.hardMaxCadenceMs) }
}

function failureDecision(
  deps: LoopEvaluationDeps,
  loop: Loop,
  error: PredicateError,
): LoopDecision {
  const consecutiveFailures = loop.consecutiveFailures + 1
  if (consecutiveFailures >= Math.min(loop.maxConsecutiveFailures, deps.hardMaxConsecutiveFailures)) {
    return { kind: "failed", stopReason: `consecutive_failures:${consecutiveFailures}`, consecutiveFailures, errorDetail: error.errorDetail }
  }
  return {
    kind: "continue",
    consecutiveFailures,
    delayMs: backoffDelay({
      initialMs: Math.min(loop.backoff.initialMs, deps.hardMaxBackoffMs),
      factor: Math.min(loop.backoff.factor, deps.hardMaxBackoffFactor),
      maxMs: Math.min(loop.backoff.maxMs, deps.hardMaxBackoffMs),
    }, consecutiveFailures, deps.rng.next()),
    errorDetail: error.errorDetail,
  }
}

export type MarkerResult = "done" | "continue" | { readonly kind: "blocked"; readonly reason: string }

/** Only exact marker lines in the last assistant turn can end an iteration. */
export function markerResult(turns: readonly Pick<TranscriptTurn, "parts">[], nonce: string): MarkerResult {
  const finalTurn = turns.at(-1)
  if (finalTurn === undefined) return "continue"
  const lines = finalTurn.parts.flatMap((part) => part.kind === "text" ? part.text.split("\n") : [])
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (line === `LOOP_DONE ${nonce}`) return "done"
    if (line === `LOOP_CONTINUE ${nonce}`) return "continue"
    const blocked = new RegExp(`^LOOP_BLOCKED ${escapeRegExp(nonce)}: (.+)$`).exec(line ?? "")
    if (blocked !== null) return { kind: "blocked", reason: blocked[1] ?? "" }
  }
  return "continue"
}

/** Exponential ceiling with full jitter: a uniform fraction of the capped delay. */
export function backoffDelay(backoff: LoopBackoff, consecutiveFailures: number, random: number): number {
  const ceiling = Math.min(backoff.maxMs, backoff.initialMs * backoff.factor ** (consecutiveFailures - 1))
  return Math.floor(ceiling * random)
}

async function readMarker(fs: Fs, loop: Loop, run: Run, maxBytes: number): Promise<MarkerResult> {
  if (run.sessionFile === undefined) return "continue"
  try {
    const size = (await fs.stat(run.sessionFile)).size
    const baseline = run.transcriptBaselineBytes ?? 0
    const start = Math.max(baseline, size - maxBytes)
    const bytes = await fs.readFileRange(run.sessionFile, start, size - start)
    let text = new TextDecoder().decode(bytes)
    if (start > baseline) {
      const firstNewline = text.indexOf("\n")
      text = firstNewline === -1 ? "" : text.slice(firstNewline + 1)
    }
    return markerResult(parseSessionTurns(text), loop.nonce)
  } catch (error) {
    if (error instanceof FsError && error.code === "not_found") return "continue"
    throw error
  }
}

async function readGoal(
  fs: Fs,
  input: { readonly cwd: string; readonly sessionId: string; readonly maxBytes: number },
): Promise<GoalResult> {
  const path = join(input.cwd, ".omo", "goal", `${encodeURIComponent(input.sessionId)}.json`)
  try {
    const { size } = await fs.stat(path)
    if (size > input.maxBytes) return { kind: "error", detail: "goal file exceeds the configured read budget" }
    const text = new TextDecoder().decode(await fs.readFileRange(path, 0, size))
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch (error) {
      if (error instanceof SyntaxError) return { kind: "error", detail: "goal file is malformed JSON" }
      throw error
    }
    if (!isRecord(raw) || raw.version !== 1 || !("goal" in raw)) {
      return { kind: "error", detail: "goal file does not match schema version 1" }
    }
    if (raw.goal === null) return { kind: "not_complete" }
    if (!isRecord(raw.goal)) return { kind: "error", detail: "goal file has an invalid goal record" }
    const goal = raw.goal
    const valid = goal.sessionID === input.sessionId &&
      typeof goal.id === "string" &&
      typeof goal.objective === "string" &&
      (goal.status === "active" || goal.status === "paused" || goal.status === "complete") &&
      isNonnegativeInteger(goal.tokensUsed) &&
      isNonnegativeInteger(goal.timeUsedSeconds) &&
      isNonnegativeInteger(goal.createdAt) &&
      isNonnegativeInteger(goal.updatedAt) &&
      (goal.lastStartedAt === undefined || isNonnegativeInteger(goal.lastStartedAt)) &&
      (goal.completedAt === undefined || isNonnegativeInteger(goal.completedAt))
    if (!valid) return { kind: "error", detail: "goal file does not match schema version 1" }
    return goal.status === "complete" ? { kind: "complete" } : { kind: "not_complete" }
  } catch (error) {
    if (error instanceof FsError && error.code === "not_found") return { kind: "missing" }
    if (error instanceof FsError) return { kind: "error", detail: `goal file ${error.code}: ${error.path}` }
    throw error
  }
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function assertNever(value: never): never {
  throw new TypeError(`unexpected done predicate: ${JSON.stringify(value)}`)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
