import { accessSync, constants, statSync } from "node:fs"
import { join } from "node:path"
import type { Env, OmoConfig } from "./types"

export function resolveOmoDefaults(env: Env, homeDir: string): OmoConfig {
  return {
    bin: findOnPath(env.PATH ?? "", "omo") ?? "omo",
    pluginRoot: findPluginRoot(env, homeDir) ?? "",
  }
}

function findOnPath(pathValue: string, name: string): string | null {
  for (const directory of pathValue.split(":")) {
    if (directory.length === 0) continue
    const candidate = join(directory, name)
    if (isExecutable(candidate)) return candidate
  }
  return null
}

function findPluginRoot(env: Env, homeDir: string): string | null {
  const bunInstall = env.BUN_INSTALL?.trim() ?? ""
  const root = bunInstall.length > 0 ? bunInstall : join(homeDir, ".bun")
  const candidate = join(root, "install", "global", "node_modules", "omo-ai", "plugin")
  return isDirectory(candidate) ? candidate : null
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
