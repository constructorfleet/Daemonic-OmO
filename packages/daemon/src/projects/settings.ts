import { THINKING_LEVELS } from "../core/types"
import type { JsonObject, JsonValue, ProjectSettings, ThinkingLevel } from "../core/types"

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return THINKING_LEVELS.some((level) => level === value)
}

export function parseProjectSettings(value: unknown): ProjectSettings | null {
  if (!isRecord(value)) return null
  const { fullAccessOptIn, maxRunning, worktreeForAdhoc, defaultModel, defaultReasoning } = value
  if (typeof fullAccessOptIn !== "boolean" || typeof worktreeForAdhoc !== "boolean") return null
  if (typeof maxRunning !== "number" || !Number.isSafeInteger(maxRunning) || maxRunning < 1) return null
  if (defaultModel !== undefined && (typeof defaultModel !== "string" || defaultModel.length === 0)) return null
  if (defaultReasoning !== undefined && !isThinkingLevel(defaultReasoning)) return null
  return {
    fullAccessOptIn,
    maxRunning,
    ...(defaultModel === undefined ? {} : { defaultModel }),
    ...(defaultReasoning === undefined ? {} : { defaultReasoning }),
    worktreeForAdhoc,
  }
}

/**
 * Canonical settings when the row has them; otherwise the legacy persisted
 * shape with a top-level `maxRunning` and no `settings` object.
 */
export function projectSettingsFromRow(row: Readonly<Record<string, unknown>>): ProjectSettings | null {
  const canonical = parseProjectSettings(row.settings)
  if (canonical !== null) return canonical
  if (row.settings !== undefined) return null
  return parseProjectSettings({ fullAccessOptIn: false, maxRunning: row.maxRunning, worktreeForAdhoc: false })
}

export function projectSettingsJson(settings: ProjectSettings): JsonObject {
  return {
    fullAccessOptIn: settings.fullAccessOptIn,
    maxRunning: settings.maxRunning,
    ...(settings.defaultModel === undefined ? {} : { defaultModel: settings.defaultModel }),
    ...(settings.defaultReasoning === undefined ? {} : { defaultReasoning: settings.defaultReasoning }),
    worktreeForAdhoc: settings.worktreeForAdhoc,
  }
}

/** Replay-time view of a project event: legacy top-level `maxRunning` becomes nested settings. */
export function normalizeProjectEventData(data: JsonObject): JsonObject {
  if (parseProjectSettings(data.settings) !== null) return data
  if (data.settings !== undefined) return data
  const settings = parseProjectSettings({
    fullAccessOptIn: false,
    maxRunning: data.maxRunning,
    worktreeForAdhoc: false,
  })
  if (settings === null) return data
  const rest: Record<string, JsonValue> = {}
  for (const [key, value] of Object.entries(data)) {
    if (key !== "maxRunning") rest[key] = value
  }
  return { ...rest, settings: projectSettingsJson(settings) }
}
