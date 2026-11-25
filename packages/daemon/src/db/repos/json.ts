import { RepositoryDataError } from "./errors"
import type { JsonObject, JsonValue } from "../../core/types"

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  return isRecord(value) && Object.values(value).every(isJsonValue)
}

export function parseRecord(value: string, entity: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value)
  if (!isRecord(parsed)) throw new RepositoryDataError(entity)
  return parsed
}

export function parseJsonObject(value: string, entity: string): JsonObject {
  const parsed: unknown = JSON.parse(value)
  if (!isRecord(parsed) || !isJsonValue(parsed)) throw new RepositoryDataError(entity)
  return parsed
}
