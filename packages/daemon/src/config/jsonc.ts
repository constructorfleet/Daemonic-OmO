import { readFile } from "node:fs/promises"
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser"
import { ConfigError, type ConfigIssue } from "./errors"

export async function readConfigText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8")
  } catch (error) {
    if (isMissing(error)) return null
    throw new ConfigError("invalid_config", `cannot read config file: ${errorDetail(error)}`, {
      path,
      cause: error,
    })
  }
}

export function parseConfig(text: string, displayName: string): Record<string, unknown> {
  const errors: ParseError[] = []
  const value: unknown = parse(text, errors, { allowTrailingComma: true, allowEmptyContent: true })
  if (errors.length > 0) {
    const issues: ConfigIssue[] = errors.map((error) => ({
      path: `${displayName}:${locate(text, error.offset)}`,
      message: printParseErrorCode(error.error),
    }))
    throw new ConfigError("invalid_config", summarize(issues), { issues })
  }
  if (value === undefined) return {}
  if (!isPlainObject(value)) {
    const issue: ConfigIssue = { path: displayName, message: "config root must be a JSON object" }
    throw new ConfigError("invalid_config", summarize([issue]), { issues: [issue] })
  }
  return value
}

function summarize(issues: readonly ConfigIssue[]): string {
  return issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")
}

function locate(text: string, offset: number): string {
  const before = text.slice(0, Math.max(0, offset))
  const line = before.split("\n").length
  const column = offset - before.lastIndexOf("\n")
  return `${line}:${column}`
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT"
}

function errorCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code
    if (typeof code === "string") return code
  }
  return null
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
