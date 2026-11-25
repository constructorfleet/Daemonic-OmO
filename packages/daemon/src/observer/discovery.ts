import { createHash } from "node:crypto"
import { realpathSync } from "node:fs"
import { basename, resolve } from "node:path"
import { discoverProjects, resolveTaskStateDir } from "@omo-daemonic/store"
import type { Repositories } from "../auth/types"
import { parseUlid } from "../core/ids"
import type { Project, User } from "../core/types"
import { isMissing } from "./jsonl-cursor"

export interface ProjectView {
  /** The registered project's id, or `disc-<hash>` for a cwd found only in session headers. */
  readonly id: string
  readonly name: string
  readonly cwd: string
  readonly registered: boolean
  /** The project's own task store first, then one per daemon-created worktree run. */
  readonly stateDirs: readonly string[]
}

export type ViewRepos = Pick<Repositories, "projects" | "runs">

function canonical(path: string): string {
  try {
    return realpathSync.native(resolve(path))
  } catch (error) {
    if (isMissing(error)) return resolve(path)
    throw error
  }
}

export function discoveredProjectId(cwd: string): string {
  return `disc-${createHash("sha256").update(cwd).digest("hex").slice(0, 16)}`
}

/**
 * The projects one user observes: their registered projects, whose store set
 * merges the task stores of runs in daemon-created worktrees, plus the cwds of
 * their agent dir's sessions that no registered project covers.
 */
export function projectViews(repos: ViewRepos, user: Pick<User, "id" | "agentDir">): readonly ProjectView[] {
  const registered = repos.projects.listByUser(user.id).map((project) => registeredView(repos, project))
  return [...registered, ...discoveredViews(user, new Set(registered.map((view) => view.cwd)))]
}

/** One project view by id, scoped to `user`; a registered id never scans the agent dir's sessions. */
export function projectView(repos: ViewRepos, user: Pick<User, "id" | "agentDir">, projectId: string): ProjectView | undefined {
  const id = parseUlid(projectId)
  const project = id === null ? null : repos.projects.get(id)
  if (project !== null) return project.userId === user.id ? registeredView(repos, project) : undefined
  if (!projectId.startsWith("disc-")) return undefined
  const covered = new Set(repos.projects.listByUser(user.id).map((candidate) => candidate.cwd))
  return discoveredViews(user, covered).find((view) => view.id === projectId)
}

function registeredView(repos: ViewRepos, project: Project): ProjectView {
  const worktrees = repos.runs.listByProject(project.id)
    .filter((run) => run.worktreePath !== undefined)
    .map((run) => resolveTaskStateDir(run.cwd, { agentDir: project.agentDir }))
  return {
    id: project.id,
    name: project.name,
    cwd: project.cwd,
    registered: true,
    stateDirs: [...new Set([resolveTaskStateDir(project.cwd, { agentDir: project.agentDir }), ...worktrees])],
  }
}

function discoveredViews(user: Pick<User, "agentDir">, covered: ReadonlySet<string>): readonly ProjectView[] {
  return discoverProjects(user.agentDir)
    .filter((candidate) => !covered.has(canonical(candidate.cwd)))
    .map((candidate): ProjectView => ({
      id: discoveredProjectId(candidate.cwd),
      name: basename(candidate.cwd),
      cwd: candidate.cwd,
      registered: false,
      stateDirs: [candidate.stateDir],
    }))
}
