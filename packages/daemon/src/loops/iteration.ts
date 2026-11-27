import { FsError, GitError, type Clock, type Fs, type Git } from "../core/ports"
import type { Config } from "../config"
import type { Loop } from "../core/types"
import type { Database } from "bun:sqlite"
import type { Repositories } from "../auth/types"
import { ensureWorktree, worktreeLocation } from "../runs/worktree"
import type { RunEngine as RunEnginePort } from "../runs/engine"
import { isSpawnHeld } from "../runs/spawn-hold"
import { carryForward, decisionPrompt } from "./prompt"
import { nextLoopState } from "./state-machine"

export interface LoopIterationDeps {
  readonly db: Database
  readonly repos: Repositories
  readonly clock: Clock
  readonly git: Git
  readonly fs: Fs
  readonly config: Pick<Config, "defaults" | "hardCaps" | "limits">
  readonly worktreeRoot: string
  engine(): RunEnginePort
  save(loop: Loop, next: Loop): Loop
}

export async function startLoopIteration(deps: LoopIterationDeps, loop: Loop): Promise<void> {
  const project = deps.repos.projects.get(loop.projectId)
  if (project === null || project.state !== "active" || isSpawnHeld(deps.db, loop.userId)) return
  const location = loop.worktreePath === undefined || loop.branch === undefined
    ? worktreeLocation(deps.worktreeRoot, project.id, { kind: "loop", id: loop.id, name: project.name })
    : { path: loop.worktreePath, branch: loop.branch }
  try {
    const placed = await ensureWorktree(
      { git: deps.git, root: deps.worktreeRoot, maxKeptPerProject: deps.config.limits.maxKeptWorktreesPerProject },
      project,
      location,
    )
    if (placed.kind === "capped") {
      deps.save(loop, {
        ...loop,
        state: nextLoopState(loop.state, { kind: "exhaust" }),
        stopReason: "worktree_cap",
        nextIterationAt: null,
        endedAt: new Date(deps.clock.now()).toISOString(),
        revision: loop.revision + 1,
      })
      return
    }
  } catch (error) {
    if (!(error instanceof GitError)) throw error
    deps.save(loop, {
      ...loop,
      state: nextLoopState(loop.state, { kind: "fail" }),
      stopReason: `worktree:${error.message}`,
      nextIterationAt: null,
      endedAt: new Date(deps.clock.now()).toISOString(),
      revision: loop.revision + 1,
    })
    return
  }
  const prepared = loop.worktreePath === location.path && loop.branch === location.branch
    ? loop
    : deps.save(loop, { ...loop, worktreePath: location.path, branch: location.branch, revision: loop.revision + 1 })
  const previousRun = prepared.activeRunId === undefined ? null : deps.repos.runs.get(prepared.activeRunId)
  if (prepared.state === "running" && prepared.activeRunId !== undefined && previousRun !== null) return
  const restarting = prepared.state === "running" && prepared.activeRunId === undefined
  const iteration = restarting ? Math.max(1, prepared.iteration) : prepared.iteration + 1
  if (prepared.state === "pending") {
    deps.save(prepared, { ...prepared, state: nextLoopState(prepared.state, { kind: "start" }), iteration, nextIterationAt: null, revision: prepared.revision + 1 })
  } else if (prepared.state === "waiting") {
    deps.save(prepared, { ...prepared, state: nextLoopState(prepared.state, { kind: "iteration_due" }), iteration, nextIterationAt: null, revision: prepared.revision + 1 })
  } else {
    deps.save(prepared, { ...prepared, iteration, nextIterationAt: null, revision: prepared.revision + 1 })
  }
  const previous = deps.repos.runs.listByProject(prepared.projectId)
    .filter((run) => run.loopId === prepared.id && run.outcome !== null)
    .sort((left, right) => (right.iteration ?? 0) - (left.iteration ?? 0))[0]
  const carried = prepared.sessionMode === "fresh" && previous !== undefined
    ? await carryForward(previous, deps.fs, Math.min(prepared.carryForwardBytes, deps.config.hardCaps.loopCarryForwardBytes))
    : ""
  const continuationFile = prepared.sessionMode === "continue" ? prepared.sessionFile : undefined
  let continuationBaseline = 0
  if (continuationFile !== undefined) {
    try {
      continuationBaseline = (await deps.fs.stat(continuationFile)).size
    } catch (error) {
      if (!(error instanceof FsError) || error.code !== "not_found") throw error
    }
  }
  const continuation = prepared.sessionMode === "continue" && prepared.threadId !== undefined && prepared.sessionId !== undefined
    ? {
        threadId: prepared.threadId,
        sessionId: prepared.sessionId,
        baselineBytes: continuationBaseline,
        ...(prepared.sessionFile === undefined ? {} : { sessionFile: prepared.sessionFile }),
      }
    : undefined
  const run = deps.engine().decide({
    project,
    spec: {
      ...prepared.spec,
      timeoutMs: Math.min(prepared.spec.timeoutMs, deps.config.hardCaps.runTimeoutMs),
      prompt: decisionPrompt(prepared, prepared, carried),
    },
    workspace: { kind: "shared_worktree", ...location },
    trigger: {
      kind: "loop",
      loopId: prepared.id,
      iteration,
      fireKey: `loop:${prepared.id}:${iteration}`,
      ...(prepared.scheduleId === undefined ? {} : { scheduleId: prepared.scheduleId }),
    },
    ...(continuation === undefined ? {} : { continuation }),
  })
  const current = deps.repos.loops.get(prepared.id)
  if (current !== null && current.activeRunId !== run.id) {
    deps.save(current, { ...current, activeRunId: run.id, revision: current.revision + 1 })
  }
}
