import { ApiError } from "../api/errors"
import { THINKING_LEVELS } from "../core/types"
import type { ThinkingLevel } from "../core/types"

export interface ProjectSettingsInput {
  fullAccessOptIn?: boolean
  maxRunning?: number
  defaultModel?: string
  defaultReasoning?: ThinkingLevel
  worktreeForAdhoc?: boolean
}

export interface ProjectCreateInput {
  readonly cwd: string
  readonly name?: string
  readonly settings?: ProjectSettingsInput
}

export interface ProjectPatchInput {
  readonly revision: number
  readonly name?: string
  readonly cwd?: string
  readonly settings?: ProjectSettingsInput
}

const SETTING_KEYS = ["fullAccessOptIn", "maxRunning", "defaultModel", "defaultReasoning", "worktreeForAdhoc"] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function bodyRecord(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) throw new ApiError("invalid_arguments", "body must be a JSON object")
  return body
}

function rejectPermissionPreset(record: Record<string, unknown>): void {
  if ("permissionPreset" in record) {
    throw new ApiError(
      "invalid_arguments",
      "projects have no permissionPreset; runs use the agent-dir default permission mode",
    )
  }
}

function rejectTopLevelMaxRunning(record: Record<string, unknown>): void {
  if ("maxRunning" in record) throw new ApiError("invalid_arguments", "maxRunning belongs in project settings")
}

function requiredCwd(record: Record<string, unknown>): string {
  const cwd = record.cwd
  if (typeof cwd !== "string" || cwd.trim().length === 0) {
    throw new ApiError("invalid_arguments", "cwd must be a non-empty string")
  }
  return cwd
}

function optionalName(record: Record<string, unknown>): string | undefined {
  const name = record.name
  if (name === undefined) return undefined
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new ApiError("invalid_arguments", "name must be a non-empty string")
  }
  return name
}

function parseSettings(value: unknown): ProjectSettingsInput | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new ApiError("invalid_arguments", "settings must be a JSON object")
  rejectPermissionPreset(value)
  const unknownKey = Object.keys(value).find((key) => !SETTING_KEYS.some((setting) => setting === key))
  if (unknownKey !== undefined) {
    throw new ApiError("invalid_arguments", `unknown project setting: ${unknownKey}`)
  }
  const settings: ProjectSettingsInput = {}
  const { fullAccessOptIn, maxRunning, defaultModel, defaultReasoning, worktreeForAdhoc } = value
  if (fullAccessOptIn !== undefined) {
    if (typeof fullAccessOptIn !== "boolean") {
      throw new ApiError("invalid_arguments", "settings.fullAccessOptIn must be a boolean")
    }
    settings.fullAccessOptIn = fullAccessOptIn
  }
  if (maxRunning !== undefined) {
    if (typeof maxRunning !== "number" || !Number.isSafeInteger(maxRunning) || maxRunning < 1) {
      throw new ApiError("invalid_arguments", "settings.maxRunning must be a positive integer")
    }
    settings.maxRunning = maxRunning
  }
  if (defaultModel !== undefined) {
    if (typeof defaultModel !== "string" || defaultModel.trim().length === 0) {
      throw new ApiError("invalid_arguments", "settings.defaultModel must be a non-empty string")
    }
    settings.defaultModel = defaultModel
  }
  if (defaultReasoning !== undefined) {
    const level = THINKING_LEVELS.find((candidate) => candidate === defaultReasoning)
    if (level === undefined) {
      throw new ApiError("invalid_arguments", `settings.defaultReasoning must be one of ${THINKING_LEVELS.join(", ")}`)
    }
    settings.defaultReasoning = level
  }
  if (worktreeForAdhoc !== undefined) {
    if (typeof worktreeForAdhoc !== "boolean") {
      throw new ApiError("invalid_arguments", "settings.worktreeForAdhoc must be a boolean")
    }
    settings.worktreeForAdhoc = worktreeForAdhoc
  }
  return settings
}

export function parseProjectCreate(body: unknown): ProjectCreateInput {
  const record = bodyRecord(body)
  rejectPermissionPreset(record)
  rejectTopLevelMaxRunning(record)
  const name = optionalName(record)
  const settings = parseSettings(record.settings)
  return {
    cwd: requiredCwd(record),
    ...(name === undefined ? {} : { name }),
    ...(settings === undefined ? {} : { settings }),
  }
}

export function parseProjectPatch(body: unknown): ProjectPatchInput {
  const record = bodyRecord(body)
  rejectPermissionPreset(record)
  rejectTopLevelMaxRunning(record)
  const revision = record.revision
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) {
    throw new ApiError("invalid_arguments", "revision must be a positive integer")
  }
  const name = optionalName(record)
  const cwd = record.cwd === undefined ? undefined : requiredCwd(record)
  const settings = parseSettings(record.settings)
  if (name === undefined && cwd === undefined && settings === undefined) {
    throw new ApiError("invalid_arguments", "nothing to update")
  }
  return {
    revision,
    ...(name === undefined ? {} : { name }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(settings === undefined ? {} : { settings }),
  }
}
