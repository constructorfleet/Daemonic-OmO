import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import type { Repositories } from "../auth/types"
import { READ_BYTES_FLOOR, type Config } from "../config/types"
import type { Clock } from "../core/ports"
import type { Run, User } from "../core/types"
import { DagDoc } from "./dag-doc"
import { projectView } from "./discovery"
import type { StreamDoc } from "./doc-stream"
import type { ImageCache } from "./images"
import { ScheduleDoc } from "./schedule-doc"
import { childSessionFiles, isSafeId, rootSessionFile, taskEventLog } from "./session-files"
import { TaskTreeDoc } from "./task-tree-doc"
import { TranscriptDoc } from "./transcript-doc"

export const SNAPSHOT_TURNS = 50

export interface DocFactoryDeps {
  readonly repos: Pick<Repositories, "projects" | "runs">
  readonly config: Config
  readonly clock: Clock
  readonly images: ImageCache
}

export interface OpenedDoc {
  readonly stream: StreamDoc
  /** Set for session and task documents, which serve turn bodies, older pages and images. */
  readonly transcript?: TranscriptDoc
  /** A document whose run is executing is polled at the subscribed cadence. */
  readonly active: () => boolean
}

export function agentDirHash(agentDir: string): string {
  return createHash("sha256").update(resolve(agentDir)).digest("hex").slice(0, 12)
}

export function sessionDocId(agentDir: string, sessionId: string): string {
  return `session:${agentDirHash(agentDir)}:${sessionId}`
}

function readBytes(user: User, config: Config): number {
  return Math.min(config.hardCaps.readBytes, Math.max(READ_BYTES_FLOOR, user.settings.readBytes ?? config.defaults.readBytes))
}

function runningRuns(deps: DocFactoryDeps, user: User): readonly Run[] {
  return deps.repos.projects.listByUser(user.id)
    .flatMap((project) => deps.repos.runs.listByProject(project.id))
    .filter((run) => run.state === "creating" || run.state === "active")
}

function taskStore(stateDirs: readonly string[], taskId: string): string | undefined {
  if (!isSafeId(taskId)) return undefined
  return stateDirs.find((dir) => existsSync(join(dir, "tasks", `${taskId}.json`))
    || existsSync(join(dir, "logs", `${taskId}.jsonl`))
    || existsSync(join(dir, "children", taskId)))
}

function transcript(doc: TranscriptDoc, active: () => boolean): OpenedDoc {
  return { stream: { poll: () => doc.poll(), snapshot: () => doc.snapshot(SNAPSHOT_TURNS) }, transcript: doc, active }
}

function taskTranscript(deps: DocFactoryDeps, user: User, stateDir: string, taskId: string): TranscriptDoc {
  const eventLog = taskEventLog(stateDir, taskId)
  return new TranscriptDoc(
    { files: () => childSessionFiles(stateDir, taskId), ...(eventLog === undefined ? {} : { eventLog }) },
    { readBytes: readBytes(user, deps.config), images: deps.images, limits: deps.config.limits },
  )
}

/**
 * Resolves `docId` for `user`, or null when the id is malformed, names
 * something outside the user's agent dir and projects, or does not exist:
 * `session:<agentDirHash>:<sessionId>`, `task:<projectId>:<taskId>`,
 * `project:<projectId>:tasks`, `dag:<projectId>:<runId>`, `schedules:<userId>`.
 */
export function openDoc(deps: DocFactoryDeps, user: User, docId: string): OpenedDoc | null {
  const [kind, scope = "", name = "", ...extra] = docId.split(":")
  if (extra.length > 0) return null
  const runningInProject = () => runningRuns(deps, user).some((run) => run.projectId === scope)
  switch (kind) {
    case "session": {
      const file = scope === agentDirHash(user.agentDir) ? rootSessionFile(user.agentDir, name) : undefined
      if (file === undefined) return null
      const doc = new TranscriptDoc(
        { files: () => [file] },
        { readBytes: readBytes(user, deps.config), images: deps.images, limits: deps.config.limits },
      )
      return transcript(doc, () => runningRuns(deps, user).some((run) => run.sessionId === name))
    }
    case "task": {
      const view = projectView(deps.repos, user, scope)
      const stateDir = view === undefined ? undefined : taskStore(view.stateDirs, name)
      return stateDir === undefined ? null : transcript(taskTranscript(deps, user, stateDir, name), runningInProject)
    }
    case "project": {
      const view = name === "tasks" ? projectView(deps.repos, user, scope) : undefined
      if (view === undefined) return null
      const stateDirs = view.registered ? () => projectView(deps.repos, user, scope)?.stateDirs ?? [] : () => view.stateDirs
      const doc = new TaskTreeDoc(stateDirs)
      const hash = agentDirHash(user.agentDir)
      return { stream: { poll: () => doc.poll(), snapshot: () => ({ ...doc.snapshot(), agentDirHash: hash }) }, active: runningInProject }
    }
    case "dag": {
      const view = isSafeId(name) ? projectView(deps.repos, user, scope) : undefined
      const stateDir = view?.stateDirs.find((dir) => existsSync(join(dir, "dag", "runs", `${name}.json`)))
      if (view === undefined || stateDir === undefined) return null
      const doc = new DagDoc(stateDir, name, (taskId) => taskTranscript(deps, user, taskStore(view.stateDirs, taskId) ?? stateDir, taskId))
      return { stream: doc, active: () => doc.active }
    }
    case "schedules": {
      if (scope !== user.id || name !== "") return null
      const doc = new ScheduleDoc(user.agentDir, () => deps.clock.now())
      return { stream: doc, active: () => false }
    }
    default:
      return null
  }
}
