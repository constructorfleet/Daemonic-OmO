import { isAbsolute } from "node:path"
import type { ConfigIssue } from "./errors"
import { expandTilde, resolveFrom } from "./paths"

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export class Reader {
  readonly issues: ConfigIssue[] = []
  private readonly home: string
  private readonly homeDir: string

  constructor(home: string, homeDir: string) {
    this.home = home
    this.homeDir = homeDir
  }

  issue(path: string, message: string): void {
    this.issues.push({ path, message })
  }

  section(path: string, value: unknown): Record<string, unknown> {
    if (value === undefined) return {}
    if (isPlainObject(value)) return value
    this.issue(path, "must be an object")
    return {}
  }

  string(path: string, value: unknown, fallback: string): string {
    if (value === undefined) return fallback
    if (typeof value === "string" && value.trim().length > 0) return value
    this.issue(path, "must be a non-empty string")
    return fallback
  }

  requiredString(path: string, value: unknown, fallback = ""): string {
    if (value === undefined) {
      this.issue(path, "is required")
      return fallback
    }
    return this.string(path, value, fallback)
  }

  optionalString(path: string, value: unknown): string | undefined {
    if (value === undefined) return undefined
    if (typeof value === "string" && value.trim().length > 0) return value
    this.issue(path, "must be a non-empty string")
    return undefined
  }

  boolean(path: string, value: unknown, fallback: boolean): boolean {
    if (value === undefined) return fallback
    if (typeof value === "boolean") return value
    this.issue(path, "must be true or false")
    return fallback
  }

  integer(
    path: string,
    value: unknown,
    fallback: number,
    bounds: number | IntegerBounds = 1,
  ): number {
    const min = typeof bounds === "number" ? bounds : (bounds.min ?? 1)
    const max = typeof bounds === "number" ? undefined : bounds.max
    const label = typeof bounds === "number" ? undefined : bounds.maxLabel
    if (value === undefined) {
      if (max !== undefined && fallback > max) {
        this.issue(path, capMessage(min, max, label))
      }
      return fallback
    }
    if (typeof value === "number" && Number.isInteger(value) && value >= min) {
      if (max === undefined || value <= max) return value
      this.issue(path, capMessage(min, max, label))
      return fallback
    }
    this.issue(
      path,
      max === undefined ? `must be an integer >= ${min}` : `must be an integer between ${min} and ${max}`,
    )
    return fallback
  }

  enumValue<T extends string>(
    path: string,
    value: unknown,
    allowed: readonly T[],
    fallback: T,
  ): T {
    if (value === undefined) return fallback
    if (typeof value === "string") {
      const match = allowed.find((entry) => entry === value)
      if (match !== undefined) return match
    }
    this.issue(path, `must be one of ${allowed.join(", ")}`)
    return fallback
  }

  stringArray(path: string, value: unknown, fallback: readonly string[]): readonly string[] {
    if (value === undefined) return fallback
    if (Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.trim().length > 0)) {
      return value
    }
    this.issue(path, "must be an array of non-empty strings")
    return fallback
  }

  homePath(path: string, value: unknown, fallback: string): string {
    const raw = this.string(path, value, fallback)
    return resolveFrom(this.home, raw, this.homeDir)
  }

  requiredHomePath(path: string, value: unknown): string {
    if (value === undefined) {
      this.issue(path, "is required")
      return ""
    }
    return this.homePath(path, value, "")
  }

  binPath(path: string, value: unknown, fallback: string): string {
    return expandTilde(this.string(path, value, fallback), this.homeDir)
  }

  absolutePath(path: string, value: unknown, fallback: string, hint?: string): string {
    const raw = this.string(path, value, fallback)
    const expanded = expandTilde(raw, this.homeDir)
    if (isAbsolute(expanded)) return expanded
    this.issue(path, hint === undefined ? "must be an absolute path" : `must be an absolute path (${hint})`)
    return fallback
  }

  url(path: string, value: unknown, fallback: string): string {
    const raw = this.string(path, value, fallback)
    if (isHttpUrl(raw)) return raw
    this.issue(path, "must be an absolute http(s) URL")
    return fallback
  }

  requiredUrl(path: string, value: unknown, fallback = ""): string {
    if (value === undefined) {
      this.issue(path, "is required")
      return fallback
    }
    return this.url(path, value, fallback)
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname.length > 0
  } catch {
    return false
  }
}

export interface IntegerBounds {
  readonly min?: number
  readonly max: number
  readonly maxLabel?: string
}

function capMessage(min: number, max: number, label: string | undefined): string {
  const range = `must be an integer between ${min} and ${max}`
  return label === undefined ? range : `${range} (capped by ${label})`
}
