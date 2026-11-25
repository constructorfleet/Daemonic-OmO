import { readdirSync, statSync, type Dirent } from "node:fs"
import { join, resolve } from "node:path"

import { resolveTaskStateDir } from "./agent-dir.js"
import { readSessionHeader } from "./session-files.js"

export type DiscoveredProject = {
  readonly cwd: string
  readonly stateDir: string
  readonly latestSessionId: string
  readonly latestSessionAt: number
}

export function discoverProjects(agentDir: string): readonly DiscoveredProject[] {
  const sessionsDir = join(agentDir, "sessions")
  let directories: Dirent[]
  try {
    directories = readdirSync(sessionsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }
  const newestByCwd = new Map<string, DiscoveredProject>()
  for (const directory of directories) {
    const folder = join(sessionsDir, directory.name)
    for (const name of readdirSync(folder).filter((entry) => entry.endsWith(".jsonl"))) {
      const path = join(folder, name)
      const header = readSessionHeader(path)
      if (header === undefined) continue
      const cwd = resolve(header.cwd)
      const latestSessionAt = statSync(path).mtimeMs
      const current = newestByCwd.get(cwd)
      if (current !== undefined && current.latestSessionAt >= latestSessionAt) continue
      newestByCwd.set(cwd, {
        cwd,
        stateDir: resolveTaskStateDir(cwd, { agentDir }),
        latestSessionId: header.id,
        latestSessionAt,
      })
    }
  }
  return [...newestByCwd.values()].toSorted((a, b) => b.latestSessionAt - a.latestSessionAt || a.cwd.localeCompare(b.cwd))
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")
}
