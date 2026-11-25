import { constants } from "node:fs"
import { access, readdir, realpath, stat } from "node:fs/promises"
import { basename, resolve, sep } from "node:path"
import { discoverProjects, resolveTaskStateDir } from "@omo-daemonic/store"
import { ApiError } from "../api/errors"
import { ServiceKey } from "../api/services"
import type { Repositories } from "../auth/types"
import type { Config } from "../config"
import { parseUlid, ulid } from "../core/ids"
import type { Clock, Git, Rng } from "../core/ports"
import type { Project, ProjectSettings, User, UserId } from "../core/types"
import type { ProjectCreateInput, ProjectPatchInput, ProjectSettingsInput } from "./request"

export interface DiscoveredProjectRow {
  readonly cwd: string
  readonly name: string
  readonly stateDir: string
  readonly latestSessionId: string
  readonly latestSessionAt: number
  readonly registered: false
}

export type ProjectListItem = Project | DiscoveredProjectRow

export interface ProjectsService {
  listAll(): readonly Project[]
  listFor(userId: UserId, includeDiscovered: boolean): Promise<readonly ProjectListItem[]>
  get(actor: User, rawId: string): Project
  create(actor: User, input: ProjectCreateInput): Promise<Project>
  patch(actor: User, rawId: string, input: ProjectPatchInput): Promise<Project>
  archive(actor: User, rawId: string, force: boolean): Promise<Project>
  remove(actor: User, rawId: string): void
}

export interface ProjectsServiceDeps {
  readonly repos: Repositories
  readonly clock: Clock
  readonly rng: Rng
  readonly config: Config
  readonly git: Git
  /** Cancels the project's unfinished runs for `archive?force=true`; throws state_conflict if one cannot be stopped. */
  cancelRuns(actor: User, project: Project): Promise<void>
}

export const PROJECTS = new ServiceKey<ProjectsService>("projects")

function errorCode(error: unknown): string | null {
  if (error instanceof Error && "code" in error && typeof error.code === "string") return error.code
  return null
}

function directoryError(input: string, error: unknown): ApiError {
  const code = errorCode(error)
  const reason = code === "EACCES" || code === "EPERM"
    ? "permission_denied"
    : code === "ENOENT" || code === "ENOTDIR" ? "not_found" : "io"
  return new ApiError("invalid_arguments", `cwd is not a readable directory: ${input}`, { path: input, reason })
}

async function inspectDirectory(input: string): Promise<string> {
  const absolute = resolve(input)
  let real: string
  try {
    real = await realpath(absolute)
  } catch (error) {
    throw directoryError(input, error)
  }
  let entry: Awaited<ReturnType<typeof stat>>
  try {
    entry = await stat(real)
  } catch (error) {
    throw directoryError(input, error)
  }
  if (!entry.isDirectory()) {
    throw new ApiError("invalid_arguments", `cwd is not a directory: ${input}`, {
      path: input,
      reason: "not_a_directory",
    })
  }
  try {
    await access(real, constants.R_OK)
    await readdir(real)
  } catch (error) {
    throw directoryError(input, error)
  }
  return real
}

async function canonicalRoot(root: string): Promise<string> {
  try {
    return await realpath(resolve(root))
  } catch {
    return resolve(root)
  }
}
export function createProjectsService(deps: ProjectsServiceDeps): ProjectsService {
  const { repos, clock, rng, config, git } = deps
  const nowIso = (): string => new Date(clock.now()).toISOString()

  function clampMaxRunning(value: number): number {
    return Math.max(1, Math.min(value, config.hardCaps.maxRunningPerProject))
  }

  function defaultSettings(actor: User): ProjectSettings {
    const configured = actor.settings.maxRunningPerProject ?? config.defaults.maxRunningPerProject
    return { fullAccessOptIn: false, maxRunning: clampMaxRunning(configured), worktreeForAdhoc: false }
  }

  function mergeSettings(base: ProjectSettings, input: ProjectSettingsInput): ProjectSettings {
    const defaultModel = input.defaultModel ?? base.defaultModel
    const defaultReasoning = input.defaultReasoning ?? base.defaultReasoning
    return {
      fullAccessOptIn: input.fullAccessOptIn ?? base.fullAccessOptIn,
      maxRunning: input.maxRunning === undefined ? base.maxRunning : clampMaxRunning(input.maxRunning),
      ...(defaultModel === undefined ? {} : { defaultModel }),
      ...(defaultReasoning === undefined ? {} : { defaultReasoning }),
      worktreeForAdhoc: input.worktreeForAdhoc ?? base.worktreeForAdhoc,
    }
  }

  async function assertAllowed(actor: User, cwd: string): Promise<void> {
    if (actor.role === "admin") return
    const roots = await Promise.all(actor.allowedRoots.map(canonicalRoot))
    if (roots.some((root) => cwd === root || cwd.startsWith(root + sep))) return
    throw new ApiError("forbidden", `cwd is outside the user's allowed roots: ${cwd}`, { cwd })
  }

  async function requireRepoForWorktree(cwd: string, settings: ProjectSettings): Promise<void> {
    if (!settings.worktreeForAdhoc || await git.isRepo(cwd)) return
    const message = `cwd is not a git repository, so worktreeForAdhoc cannot be enabled: ${cwd}`
    throw new ApiError("invalid_arguments", message, { path: cwd })
  }

  function requireVisible(actor: User, rawId: string): Project {
    const id = parseUlid(rawId)
    const project = id === null ? null : repos.projects.get(id)
    if (project === null || (project.userId !== actor.id && actor.role !== "admin")) {
      throw new ApiError("not_found", "project not found")
    }
    return project
  }

  function nonterminalRuns(project: Project) {
    return repos.runs.listByProject(project.id)
      .filter((run) => run.state !== "closed" && run.state !== "kept")
  }

  function recordOptIn(actor: User, project: Project): void {
    repos.audit.put({
      id: ulid(rng, clock.now()),
      at: nowIso(),
      userId: actor.id,
      action: "project.full_access_opt_in",
      entityKind: "project",
      entityId: project.id,
      detail: { projectId: project.id, enabled: true },
    })
  }

  function requireIdle(project: Project): void {
    const active = nonterminalRuns(project)
    if (active.length > 0) {
      throw new ApiError("state_conflict", "project has nonterminal runs", { nonterminalRuns: active.length })
    }
  }

  return {
    listAll: () => repos.projects.listAll(),

    async listFor(userId, includeDiscovered) {
      const registered = repos.projects.listByUser(userId)
      if (!includeDiscovered) return registered
      const owner = repos.users.get(userId)
      if (owner === null) return registered
      const registeredCwds = new Set(registered.map((project) => project.cwd))
      const discovered = await Promise.all(discoverProjects(owner.agentDir).map(
        async (candidate): Promise<DiscoveredProjectRow> => ({
          cwd: await canonicalRoot(candidate.cwd),
          name: basename(candidate.cwd),
          stateDir: candidate.stateDir,
          latestSessionId: candidate.latestSessionId,
          latestSessionAt: candidate.latestSessionAt,
          registered: false,
        }),
      ))
      return [...registered, ...discovered.filter((candidate) => !registeredCwds.has(candidate.cwd))]
    },

    get: (actor, rawId) => requireVisible(actor, rawId),

    async create(actor, input) {
      const cwd = await inspectDirectory(input.cwd)
      await assertAllowed(actor, cwd)
      const duplicate = repos.projects.listByUser(actor.id).find((project) => project.cwd === cwd)
      if (duplicate !== undefined) {
        throw new ApiError("state_conflict", "project is already registered", { cwd, projectId: duplicate.id })
      }
      const settings = mergeSettings(defaultSettings(actor), input.settings ?? {})
      await requireRepoForWorktree(cwd, settings)
      const at = nowIso()
      const project: Project = {
        id: ulid(rng, clock.now()),
        userId: actor.id,
        name: input.name ?? basename(cwd),
        cwd,
        agentDir: actor.agentDir,
        stateDir: resolveTaskStateDir(cwd, { agentDir: actor.agentDir }),
        settings,
        state: "active",
        revision: 1,
        createdAt: at,
        updatedAt: at,
      }
      repos.projects.put(project)
      if (settings.fullAccessOptIn) recordOptIn(actor, project)
      return project
    },

    async patch(actor, rawId, input) {
      const project = requireVisible(actor, rawId)
      let { cwd, stateDir } = project
      if (input.cwd !== undefined) {
        cwd = await inspectDirectory(input.cwd)
        await assertAllowed(actor, cwd)
        const duplicate = repos.projects.listByUser(project.userId)
          .find((candidate) => candidate.cwd === cwd && candidate.id !== project.id)
        if (duplicate !== undefined) {
          throw new ApiError("state_conflict", "project is already registered", { cwd, projectId: duplicate.id })
        }
        stateDir = resolveTaskStateDir(cwd, { agentDir: project.agentDir })
      }
      const settings = input.settings === undefined ? project.settings : mergeSettings(project.settings, input.settings)
      await requireRepoForWorktree(cwd, settings)
      const next: Project = {
        ...project,
        name: input.name ?? project.name,
        cwd,
        stateDir,
        settings,
        revision: project.revision + 1,
        updatedAt: nowIso(),
      }
      repos.projects.update(next, project.revision)
      if (settings.fullAccessOptIn && !project.settings.fullAccessOptIn) recordOptIn(actor, next)
      return next
    },

    async archive(actor, rawId, force) {
      const visible = requireVisible(actor, rawId)
      if (visible.state === "archived") {
        throw new ApiError("state_conflict", "project is already archived", { projectId: visible.id })
      }
      if (force) await deps.cancelRuns(actor, visible)
      const project = requireVisible(actor, rawId)
      requireIdle(project)
      const next: Project = {
        ...project,
        state: "archived",
        revision: project.revision + 1,
        updatedAt: nowIso(),
      }
      repos.projects.update(next, project.revision)
      return next
    },

    remove(actor, rawId) {
      const project = requireVisible(actor, rawId)
      requireIdle(project)
      repos.projects.remove(project)
    },
  }
}
