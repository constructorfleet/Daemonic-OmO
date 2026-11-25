import { ApiError } from "../api/errors"
import { isPlainObject } from "../config/reader"
import { RUN_STATES, THINKING_LEVELS, type RunState, type ThinkingLevel } from "../core/types"

/** omo's own thread message cap; the only fixed limit (plan "Must have"). */
export const MAX_PROMPT_BYTES = 1_048_576

const CREATE_KEYS = ["prompt", "model", "reasoning", "timeoutMs", "worktree"] as const

export interface RunCreateInput {
  readonly prompt: string
  readonly model?: string
  readonly reasoning?: ThinkingLevel
  readonly timeoutMs?: number
  readonly worktree?: boolean
}

function record(body: unknown): Record<string, unknown> {
  if (body === undefined) return {}
  if (!isPlainObject(body)) throw new ApiError("invalid_arguments", "body must be a JSON object")
  return body
}

export function parseRunCreate(body: unknown, maxTimeoutMs: number): RunCreateInput {
  const value = record(body)
  const unknownKey = Object.keys(value).find((key) => !CREATE_KEYS.some((allowed) => allowed === key))
  if (unknownKey !== undefined) {
    const hint = unknownKey === "permissionPreset" ? "; runs use the agent-dir default permission mode" : ""
    throw new ApiError("invalid_arguments", `unknown run field: ${unknownKey}${hint}`)
  }
  const { prompt, model, reasoning, timeoutMs, worktree } = value
  if (typeof prompt !== "string" || prompt.trim().length === 0) throw new ApiError("invalid_arguments", "prompt must be a non-empty string")
  if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) {
    throw new ApiError("invalid_arguments", `prompt exceeds ${MAX_PROMPT_BYTES} bytes`, { maxBytes: MAX_PROMPT_BYTES })
  }
  if (model !== undefined && (typeof model !== "string" || model.trim().length === 0)) {
    throw new ApiError("invalid_arguments", "model must be a non-empty string")
  }
  const level = reasoning === undefined ? undefined : THINKING_LEVELS.find((candidate) => candidate === reasoning)
  if (reasoning !== undefined && level === undefined) {
    throw new ApiError("invalid_arguments", `reasoning must be one of ${THINKING_LEVELS.join(", ")}`)
  }
  if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > maxTimeoutMs)) {
    throw new ApiError("invalid_arguments", `timeoutMs must be an integer from 1 to ${maxTimeoutMs}`, { max: maxTimeoutMs })
  }
  if (worktree !== undefined && typeof worktree !== "boolean") throw new ApiError("invalid_arguments", "worktree must be a boolean")
  return {
    prompt,
    ...(typeof model === "string" ? { model } : {}),
    ...(level === undefined ? {} : { reasoning: level }),
    ...(typeof timeoutMs === "number" ? { timeoutMs } : {}),
    ...(typeof worktree === "boolean" ? { worktree } : {}),
  }
}

/** `{}` targets the caller; `{userId}` names a user or `"all"` (admins only). */
export function parseKillSwitchTarget(body: unknown): string | null {
  const { userId } = record(body)
  if (userId === undefined) return null
  if (typeof userId !== "string" || userId.length === 0) throw new ApiError("invalid_arguments", "userId must be a user id or \"all\"")
  return userId
}

export function parseRunState(value: string | null): RunState | null {
  if (value === null) return null
  const state = RUN_STATES.find((candidate) => candidate === value)
  if (state === undefined) throw new ApiError("invalid_arguments", `state must be one of ${RUN_STATES.join(", ")}`)
  return state
}

export function parseLimit(value: string | null, fallback: number, max: number): number {
  if (value === null) return fallback
  const parsed = /^\d+$/.test(value) ? Number(value) : Number.NaN
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    throw new ApiError("invalid_arguments", `limit must be an integer from 1 to ${max}`)
  }
  return parsed
}
