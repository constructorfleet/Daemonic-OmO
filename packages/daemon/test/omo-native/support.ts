import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveTaskStateDir } from "@omo-daemonic/store"
import { systemRng } from "../../src/config"
import { ulid } from "../../src/core/ids"
import type { Project } from "../../src/core/types"
import { member, server, stopServers } from "../api/harness"

const scratch: string[] = []

export const cleanOmoNative = async (): Promise<void> => {
  await stopServers()
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })))
}

export async function omoStub(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "omo-native-"))
  scratch.push(directory)
  const path = join(directory, "omo")
  await writeFile(path, [
    "#!/bin/sh",
    'if [ -f "$OMO_CODING_AGENT_DIR/fail-cancel" ]; then',
    '  printf "internal_key_unavailable: key expired\\n" >&2',
    "  exit 1",
    "fi",
    'printf "%s" "$OMO_CODING_AGENT_DIR" > "$OMO_CODING_AGENT_DIR/cancel-agent-dir"',
  ].join("\n"), { mode: 0o755 })
  return path
}

export async function projectFor(target: Awaited<ReturnType<typeof server>>, owner: Awaited<ReturnType<typeof member>>, name: string): Promise<Project> {
  const id = ulid(systemRng(), target.clock.now())
  const cwd = join(target.home, name)
  await mkdir(cwd, { recursive: true })
  const at = new Date(target.clock.now()).toISOString()
  const project: Project = {
    id, userId: owner.user.id, name, cwd, agentDir: owner.user.agentDir,
    stateDir: resolveTaskStateDir(cwd, { agentDir: owner.user.agentDir }),
    settings: { fullAccessOptIn: false, maxRunning: 1, worktreeForAdhoc: false },
    state: "active", revision: 1, createdAt: at, updatedAt: at,
  }
  target.app.ctx.repos.projects.put(project)
  return project
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true })
  await writeFile(path, JSON.stringify(value))
}

export function scheduleRecord(id: string, prompt = "Cancel this schedule.") {
  return {
    version: 1, id, sessionId: "session-cancel", sessionFile: null, cwd: "/tmp/project",
    prompt, createdAt: 1, dueAt: 2, everyMs: null, fireCount: 0, lastFiredAt: null, lastError: null,
  }
}
