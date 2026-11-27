import { ApiError } from "../api/errors"
import { isPlainObject } from "../config/reader"
import type { Config } from "../config"
import type { DonePredicate, LoopBackoff, LoopTemplate, Project, RunSpec, User, UserSettings } from "../core/types"
import { THINKING_LEVELS } from "../core/types"
import { MAX_PROMPT_BYTES } from "../runs/request"
import { effectiveLoopLimits } from "./limits"

const FIELDS = [
  "prompt",
  "model",
  "reasoning",
  "timeoutMs",
  "doneWhen",
  "maxIterations",
  "maxWallMs",
  "maxConsecutiveFailures",
  "cadenceMs",
  "backoff",
  "sessionMode",
  "carryForwardBytes",
] as const

export interface LoopParseContext {
  readonly actor: User
  readonly project: Project
  readonly config: Pick<Config, "defaults" | "hardCaps" | "limits">
  readonly ownerSettings: UserSettings
}

function invalid(message: string): never {
  throw new ApiError("invalid_arguments", message)
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainObject(value)) return invalid(`${label} must be an object`)
  return value
}

function integer(value: unknown, label: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    return invalid(`${label} must be an integer from ${min} to ${max}`)
  }
  return value
}

function parseDoneWhen(
  value: unknown,
  context: LoopParseContext,
  defaultTimeoutMs: number,
): readonly DonePredicate[] {
  if (!Array.isArray(value) || value.length === 0) return invalid("doneWhen must contain at least one predicate")
  return value.map((entry, index) => {
    const predicate = object(entry, `doneWhen[${index}]`)
    switch (predicate.kind) {
      case "marker":
      case "goal":
        if (Object.keys(predicate).some((key) => key !== "kind")) return invalid(`doneWhen[${index}] only accepts kind`)
        return { kind: predicate.kind }
      case "check": {
        if (context.actor.role !== "admin" && !context.project.settings.fullAccessOptIn) {
          throw new ApiError("forbidden", "check predicates require an admin or a full-access project")
        }
        if (Object.keys(predicate).some((key) => key !== "kind" && key !== "command" && key !== "timeoutMs")) {
          return invalid(`doneWhen[${index}] only accepts kind, command and timeoutMs`)
        }
        if (!Array.isArray(predicate.command) || predicate.command.length === 0 ||
          predicate.command.some((part) => typeof part !== "string" || part.trim().length === 0)) {
          return invalid(`doneWhen[${index}].command must be a non-empty string array`)
        }
        return {
          kind: "check",
          command: predicate.command,
          timeoutMs: integer(
            predicate.timeoutMs ?? defaultTimeoutMs,
            `doneWhen[${index}].timeoutMs`,
            1,
            context.config.hardCaps.loopCheckTimeoutMs,
          ),
        }
      }
      default:
        return invalid(`doneWhen[${index}].kind must be marker, goal or check`)
    }
  })
}

function parseBackoff(value: unknown, context: LoopParseContext, defaults: LoopBackoff): LoopBackoff {
  const raw = object(value, "backoff")
  if (Object.keys(raw).some((key) => key !== "initialMs" && key !== "factor" && key !== "maxMs")) {
    return invalid("backoff only accepts initialMs, factor and maxMs")
  }
  const maxMs = context.config.hardCaps.loopBackoffMs
  const maxFactor = context.config.hardCaps.loopBackoffFactor
  const factor = raw.factor ?? defaults.factor
  if (typeof factor !== "number" || !Number.isFinite(factor) || factor < 1 || factor > maxFactor) {
    return invalid(`backoff.factor must be a finite number from 1 to ${maxFactor}`)
  }
  return {
    initialMs: integer(raw.initialMs ?? defaults.initialMs, "backoff.initialMs", 0, maxMs),
    factor,
    maxMs: integer(raw.maxMs ?? defaults.maxMs, "backoff.maxMs", 0, maxMs),
  }
}

/** Parses the loop creation body once at the authenticated HTTP boundary. */
export function parseLoopTemplate(body: unknown, context: LoopParseContext): LoopTemplate {
  const raw = object(body, "body")
  const unknown = Object.keys(raw).find((key) => !FIELDS.some((field) => field === key))
  if (unknown !== undefined) return invalid(`unknown loop field: ${unknown}`)
  const { prompt, model, reasoning, timeoutMs } = raw
  if (typeof prompt !== "string" || prompt.trim().length === 0) return invalid("prompt must be a non-empty string")
  if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) return invalid(`prompt exceeds ${MAX_PROMPT_BYTES} bytes`)
  if (model !== undefined && (typeof model !== "string" || model.trim().length === 0)) return invalid("model must be a non-empty string")
  const level = reasoning === undefined ? undefined : THINKING_LEVELS.find((item) => item === reasoning)
  if (reasoning !== undefined && level === undefined) return invalid(`reasoning must be one of ${THINKING_LEVELS.join(", ")}`)
  const limits = effectiveLoopLimits(context.config, context.ownerSettings)
  const selectedTimeout = timeoutMs === undefined
    ? limits.runTimeoutMs
    : integer(timeoutMs, "timeoutMs", 1, context.config.hardCaps.runTimeoutMs)
  const spec: RunSpec = {
    prompt,
    timeoutMs: selectedTimeout,
    ...(typeof model === "string" ? { model } : context.project.settings.defaultModel === undefined ? {} : { model: context.project.settings.defaultModel }),
    ...(level !== undefined
      ? { thinking: level }
      : context.project.settings.defaultReasoning === undefined
        ? {}
        : { thinking: context.project.settings.defaultReasoning }),
  }
  const maxIterations = integer(
    raw.maxIterations ?? limits.maxIterations,
    "maxIterations",
    1,
    context.config.hardCaps.loopMaxIterations,
  )
  const maxWallMs = integer(
    raw.maxWallMs ?? limits.maxWallMs,
    "maxWallMs",
    1,
    context.config.hardCaps.loopMaxWallMs,
  )
  const maxConsecutiveFailures = integer(
    raw.maxConsecutiveFailures ?? limits.maxConsecutiveFailures,
    "maxConsecutiveFailures",
    1,
    context.config.hardCaps.loopMaxConsecutiveFailures,
  )
  const cadenceMs = integer(
    raw.cadenceMs ?? limits.cadenceMs,
    "cadenceMs",
    0,
    context.config.hardCaps.loopCadenceMs,
  )
  const sessionMode = raw.sessionMode ?? "fresh"
  if (sessionMode !== "fresh" && sessionMode !== "continue") return invalid("sessionMode must be fresh or continue")
  return {
    spec,
    doneWhen: parseDoneWhen(raw.doneWhen, context, limits.checkTimeoutMs),
    maxIterations,
    maxWallMs,
    maxConsecutiveFailures,
    cadenceMs,
    backoff: raw.backoff === undefined ? limits.backoff : parseBackoff(raw.backoff, context, limits.backoff),
    sessionMode,
    carryForwardBytes: integer(
      raw.carryForwardBytes ?? limits.carryForwardBytes,
      "carryForwardBytes",
      0,
      context.config.hardCaps.loopCarryForwardBytes,
    ),
  }
}
