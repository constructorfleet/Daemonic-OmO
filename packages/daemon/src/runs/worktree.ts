import { join } from "node:path"

import type { Git } from "../core/ports"
import type { LoopId, Project, ProjectId, RunId } from "../core/types"

/** Who a daemon worktree belongs to: one per schedule fire or worktree ad-hoc run, one per loop (todo 18). */
export type WorktreeOwner =
  | { readonly kind: "sched"; readonly id: RunId; readonly name: string }
  | { readonly kind: "adhoc"; readonly id: RunId; readonly name: string }
  | { readonly kind: "loop"; readonly id: LoopId; readonly name: string }

export interface WorktreeLocation {
  readonly path: string
  readonly branch: string
}

export interface WorktreeDeps {
  readonly git: Git
  /** `<daemon home>/worktrees`: outside every user checkout. */
  readonly root: string
  readonly maxKeptPerProject: number
}

export type WorktreeResult =
  | ({ readonly kind: "ready" } & WorktreeLocation)
  | { readonly kind: "capped"; readonly kept: number }

const SLUG_MAX = 40

function slug(name: string): string {
  const cleaned = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, SLUG_MAX).replace(/-+$/, "")
  return cleaned.length === 0 ? "run" : cleaned
}

export function worktreeLocation(root: string, projectId: ProjectId, owner: WorktreeOwner): WorktreeLocation {
  return {
    path: join(root, projectId, owner.id),
    branch: `omo-daemonic/${owner.kind}-${slug(owner.name)}-${owner.id}`,
  }
}

/**
 * Adds the worktree with `git worktree add -b <branch> <path> HEAD`, or reuses it when a previous attempt of the
 * same run already added it. Daemon worktrees are never deleted automatically, so a project already holding
 * `maxKeptPerProject` of them is `capped` and the caller records `skipped(worktree_cap)`.
 */
export async function ensureWorktree(
  deps: WorktreeDeps,
  project: Pick<Project, "id" | "cwd">,
  location: WorktreeLocation,
): Promise<WorktreeResult> {
  const listed = await deps.git.worktreeList(project.cwd)
  if (listed.some((entry) => entry.path === location.path)) return { kind: "ready", ...location }
  const projectRoot = join(deps.root, project.id)
  const kept = listed.filter((entry) => entry.path.startsWith(`${projectRoot}/`)).length
  if (kept >= deps.maxKeptPerProject) return { kind: "capped", kept }
  await deps.git.worktreeAdd({ repo: project.cwd, path: location.path, branch: location.branch, base: "HEAD" })
  return { kind: "ready", ...location }
}
