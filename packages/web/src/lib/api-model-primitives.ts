export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== "string") throw new TypeError(`API response field ${key} must be a string`)
  return value
}

export function requiredInteger(record: Record<string, unknown>, key: string): number {
  const value = record[key]
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new TypeError(`API response field ${key} must be an integer`)
  }
  return value
}
