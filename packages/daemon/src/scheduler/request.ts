import { ApiError } from "../api/errors"
import { isPlainObject } from "../config/reader"
import {
  MISFIRE_POLICIES,
  OVERLAP_POLICIES,
  type Iso,
  type Ms,
  type ScheduleTarget,
  type ScheduleTrigger,
  type ThinkingLevel,
  type Project,
  type User,
} from "../core/types"
import { parseRunCreate } from "../runs/request"
import type { LoopLauncher } from "./fire"
import type { ScheduleInput, SchedulePatchInput } from "./service"

/** Plan contract: interval slots are at least a minute apart. */
export const MIN_INTERVAL_MS = 60_000

const PREVIEW_DEFAULT_COUNT = 10

const CREATE_FIELDS = ["name", "trigger", "target", "overlap", "queueMax", "misfire", "misfireGraceMs", "maxCatchup", "endAt", "maxFires"]
const PATCH_FIELDS = ["revision", ...CREATE_FIELDS]

export interface ScheduleParseContext {
  readonly now: Ms
  readonly maxTimeoutMs: number
  readonly defaultTimeoutMs: number
  readonly defaultModel?: string
  readonly defaultReasoning?: ThinkingLevel
  readonly loops: LoopLauncher | undefined
  readonly actor: User
  readonly project: Project
}

function invalid(message: string): never {
  throw new ApiError("invalid_arguments", message)
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainObject(value)) return invalid(`${label} must be a JSON object`)
  return value
}

function rejectUnknown(value: Record<string, unknown>, allowed: readonly string[]): void {
  const unknownKey = Object.keys(value).find((key) => !allowed.includes(key))
  if (unknownKey !== undefined) invalid(`unknown schedule field: ${unknownKey}`)
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) return invalid(`${label} must be a non-empty string`)
  return value
}

function iso(value: unknown, label: string): Iso {
  const at = typeof value === "string" ? Date.parse(value) : Number.NaN
  if (!Number.isFinite(at)) return invalid(`${label} must be an ISO-8601 time`)
  return new Date(at).toISOString()
}

function integer(value: unknown, label: string, min: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) return invalid(`${label} must be an integer >= ${min}`)
  return value
}

function oneOf<T extends string>(value: unknown, label: string, options: readonly T[]): T {
  const found = options.find((option) => option === value)
  if (found === undefined) return invalid(`${label} must be one of ${options.join(", ")}`)
  return found
}

/** Structure only: a cron's zone and expression are checked when the schedule is placed, and store it `errored`. */
function parseTrigger(value: unknown, now: Ms): ScheduleTrigger {
  const raw = record(value, "trigger")
  switch (raw.kind) {
    case "cron":
      return { kind: "cron", expr: text(raw.expr, "trigger.expr"), tz: text(raw.tz, "trigger.tz") }
    case "once":
      return { kind: "once", at: iso(raw.at, "trigger.at") }
    case "interval":
      return {
        kind: "interval",
        everyMs: integer(raw.everyMs, "trigger.everyMs", MIN_INTERVAL_MS),
        anchorAt: raw.anchorAt === undefined ? new Date(now).toISOString() : iso(raw.anchorAt, "trigger.anchorAt"),
      }
    default:
      return invalid("trigger.kind must be cron, once or interval")
  }
}

function parseTarget(value: unknown, context: ScheduleParseContext): ScheduleTarget {
  const raw = record(value, "target")
  switch (raw.kind) {
    case "run": {
      const spec = record(raw.spec, "target.spec")
      if ("worktree" in spec) invalid("target.spec.worktree is not a schedule field: scheduled runs use a daemon worktree in a git project")
      const input = parseRunCreate(spec, context.maxTimeoutMs)
      const model = input.model ?? context.defaultModel
      const thinking = input.reasoning ?? context.defaultReasoning
      return {
        kind: "run",
        spec: {
          prompt: input.prompt,
          timeoutMs: input.timeoutMs ?? context.defaultTimeoutMs,
          ...(model === undefined ? {} : { model }),
          ...(thinking === undefined ? {} : { thinking }),
        },
      }
    }
    case "loop":
      if (context.loops === undefined) return invalid("loop targets need the loop engine")
      return { kind: "loop", template: context.loops.parseTemplate(raw.template, context.actor, context.project) }
    default:
      return invalid("target.kind must be run or loop")
  }
}

function parsePolicies(raw: Record<string, unknown>): Omit<ScheduleInput, "name" | "trigger" | "target" | "endAt" | "maxFires"> {
  return {
    ...(raw.overlap === undefined ? {} : { overlap: oneOf(raw.overlap, "overlap", OVERLAP_POLICIES) }),
    ...(raw.queueMax === undefined ? {} : { queueMax: integer(raw.queueMax, "queueMax", 1) }),
    ...(raw.misfire === undefined ? {} : { misfire: oneOf(raw.misfire, "misfire", MISFIRE_POLICIES) }),
    ...(raw.misfireGraceMs === undefined ? {} : { misfireGraceMs: integer(raw.misfireGraceMs, "misfireGraceMs", 0) }),
    ...(raw.maxCatchup === undefined ? {} : { maxCatchup: integer(raw.maxCatchup, "maxCatchup", 1) }),
  }
}

export function parseScheduleCreate(body: unknown, context: ScheduleParseContext): ScheduleInput {
  const raw = record(body, "body")
  rejectUnknown(raw, CREATE_FIELDS)
  return {
    name: text(raw.name, "name"),
    trigger: parseTrigger(raw.trigger, context.now),
    target: parseTarget(raw.target, context),
    ...parsePolicies(raw),
    ...(raw.endAt === undefined ? {} : { endAt: iso(raw.endAt, "endAt") }),
    ...(raw.maxFires === undefined ? {} : { maxFires: integer(raw.maxFires, "maxFires", 1) }),
  }
}

export function parseSchedulePatch(body: unknown, context: ScheduleParseContext): SchedulePatchInput {
  const raw = record(body, "body")
  rejectUnknown(raw, PATCH_FIELDS)
  if (Object.keys(raw).length < 2) invalid("nothing to update")
  return {
    revision: integer(raw.revision, "revision", 1),
    ...(raw.name === undefined ? {} : { name: text(raw.name, "name") }),
    ...(raw.trigger === undefined ? {} : { trigger: parseTrigger(raw.trigger, context.now) }),
    ...(raw.target === undefined ? {} : { target: parseTarget(raw.target, context) }),
    ...parsePolicies(raw),
    ...(raw.endAt === undefined ? {} : { endAt: raw.endAt === null ? null : iso(raw.endAt, "endAt") }),
    ...(raw.maxFires === undefined ? {} : { maxFires: raw.maxFires === null ? null : integer(raw.maxFires, "maxFires", 1) }),
  }
}

export function parsePreviewCount(value: string | null, max: number): number {
  if (value === null) return Math.min(PREVIEW_DEFAULT_COUNT, max)
  const count = /^\d+$/.test(value) ? Number(value) : Number.NaN
  if (!Number.isSafeInteger(count) || count < 1 || count > max) {
    return invalid(`count must be an integer from 1 to ${max}`)
  }
  return count
}
