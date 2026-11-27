import type { Database } from "bun:sqlite"

import type { Repositories } from "../auth/types"
import { parseUlid, ulid, uuidv7 } from "../core/ids"
import { GitError, type Clock, type Git, type Rng } from "../core/ports"
import type { Config } from "../config"
import type { Loop, LoopTemplate, Project, ScheduleId } from "../core/types"
import { ensureWorktree, worktreeLocation } from "../runs/worktree"

export interface LoopCreationDeps {
  readonly db: Database
  readonly repos: Repositories
  readonly clock: Clock
  readonly rng: Rng
  readonly git: Git
  readonly config: Pick<Config, "limits">
  readonly worktreeRoot: string
}

export interface LoopCreationInput {
  readonly project: Project
  readonly template: LoopTemplate
  readonly fireKey: string
  readonly scheduleId?: ScheduleId
}

export function findLoopByFireKey(deps: LoopCreationDeps, fireKey: string): Loop | null {
  const row = deps.db.query<{ readonly id: string }, [string]>(
    "SELECT id FROM loops WHERE json_extract(json, '$.fireKey') = ? LIMIT 1",
  ).get(fireKey)
  const id = row === null ? null : parseUlid(row.id)
  return id === null ? null : deps.repos.loops.get(id)
}

export async function createLoopRecord(deps: LoopCreationDeps, input: LoopCreationInput): Promise<Loop> {
  const { project, template, fireKey, scheduleId } = input
  const duplicate = findLoopByFireKey(deps, fireKey)
  if (duplicate !== null) return duplicate
  const now = deps.clock.now()
  const id = ulid(deps.rng, now)
  const location = worktreeLocation(deps.worktreeRoot, project.id, { kind: "loop", id, name: project.name })
  const loop: Loop = {
    ...template,
    id,
    userId: project.userId,
    projectId: project.id,
    ...(scheduleId === undefined ? {} : { scheduleId }),
    fireKey,
    nonce: uuidv7(deps.rng, now),
    state: "pending",
    iteration: 0,
    consecutiveFailures: 0,
    nextIterationAt: now,
    startedAt: new Date(now).toISOString(),
    worktreePath: location.path,
    branch: location.branch,
    revision: 1,
  }
  deps.repos.loops.put(loop, new Date(now).toISOString())
  try {
    const placed = await ensureWorktree(
      { git: deps.git, root: deps.worktreeRoot, maxKeptPerProject: deps.config.limits.maxKeptWorktreesPerProject },
      project,
      location,
    )
    if (placed.kind === "capped") {
      const at = new Date(deps.clock.now()).toISOString()
      const exhausted = { ...loop, state: "exhausted" as const, stopReason: "worktree_cap", endedAt: at, nextIterationAt: null, revision: 2 }
      deps.repos.loops.update(exhausted, loop.revision, at)
      return exhausted
    }
  } catch (error) {
    if (!(error instanceof GitError)) throw error
    const at = new Date(deps.clock.now()).toISOString()
    const failed = { ...loop, state: "failed" as const, stopReason: `worktree:${error.message}`, endedAt: at, nextIterationAt: null, revision: 2 }
    deps.repos.loops.update(failed, loop.revision, at)
    return failed
  }
  return deps.repos.loops.get(id) ?? loop
}
