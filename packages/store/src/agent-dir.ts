import { createHash } from "node:crypto"
import { existsSync, realpathSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join, resolve } from "node:path"

export interface StoreOptions {
  readonly stateDir?: string
  readonly agentDir?: string
  readonly env?: Readonly<Record<string, string | undefined>>
}

export function resolveAgentDir(options: Pick<StoreOptions, "agentDir" | "env"> = {}): string {
  if (options.agentDir !== undefined) return resolve(options.agentDir)
  const env = options.env ?? process.env
  const agentDir = firstNonEmpty(
    env.OMO_CODING_AGENT_DIR,
    env.SENPI_CODING_AGENT_DIR,
    env.PI_CODING_AGENT_DIR,
  ) ?? join(env.HOME ?? env.USERPROFILE ?? homedir(), ".omo", "agent")
  return resolve(agentDir)
}

export function resolveTaskStateDir(projectDir: string, options: StoreOptions = {}): string {
  if (options.stateDir !== undefined) return resolve(options.stateDir)
  const project = canonicalProjectPath(projectDir)
  const legacy = join(project, ".omo", "senpi-task")
  if (legacyStoreHasRecords(legacy)) return legacy

  const agentDir = resolveAgentDir(options)
  const projectName = basename(project).replace(/[^\p{L}\p{N}._-]/gu, "_") || "root"
  const hash = createHash("sha256").update(project).digest("hex").slice(0, 12)
  return join(agentDir, "projects", `${projectName}-${hash}`, "senpi-task")
}

function legacyStoreHasRecords(path: string): boolean {
  if (!existsSync(path)) return false
  if (existsSync(join(path, ".in-project"))) return true
  try {
    return readdirSync(join(path, "tasks")).some((file) => file.endsWith(".json"))
  } catch {
    return false
  }
}

function canonicalProjectPath(projectDir: string): string {
  const absolute = resolve(projectDir)
  try {
    return realpathSync.native(absolute)
  } catch {
    return absolute
  }
}

function firstNonEmpty(...values: (string | undefined)[]): string | undefined {
  return values.map((value) => value?.trim()).find((value) => value !== undefined && value.length > 0)
}
