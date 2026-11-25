import { isAbsolute, join, resolve } from "node:path"

export function expandTilde(value: string, homeDir: string): string {
  if (value === "~") return homeDir
  if (value.startsWith("~/")) return join(homeDir, value.slice(2))
  return value
}

export function resolveFrom(base: string, value: string, homeDir: string): string {
  const expanded = expandTilde(value, homeDir)
  return isAbsolute(expanded) ? resolve(expanded) : resolve(base, expanded)
}
