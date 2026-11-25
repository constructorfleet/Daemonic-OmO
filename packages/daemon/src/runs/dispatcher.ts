import type { ThreadState } from "../core/ports"
import type { Iso, ProjectId, Run, RunId, ThreadId, UserId } from "../core/types"

export type QueuedRun = Pick<Run, "userId" | "projectId"> & { readonly id: RunId; readonly createdAt: Iso }

export type SlotHolder = Pick<Run, "userId" | "projectId">

export interface DispatchCaps {
  readonly machine: number
  perUser(userId: UserId): number
  perProject(projectId: ProjectId): number
}

export interface DispatchInput {
  readonly queued: readonly QueuedRun[]
  readonly holders: readonly SlotHolder[]
  readonly caps: DispatchCaps
  /** The project served last; the next pass starts after it. */
  readonly cursor: ProjectId | null
}

export interface DispatchPlan {
  readonly start: readonly RunId[]
  readonly cursor: ProjectId | null
}

/**
 * A run holds a slot while it is `creating` or while its thread is `running`; an idle thread (a kept ad-hoc
 * thread, or one between turns) holds none.
 */
export function slotHolders(
  runs: readonly (SlotHolder & Pick<Run, "state" | "threadId">)[],
  threadStates: ReadonlyMap<ThreadId, ThreadState>,
): readonly SlotHolder[] {
  return runs.filter((run) => {
    if (run.state === "creating") return true
    if (run.state === "queued" || run.state === "closed" || run.threadId === undefined) return false
    return threadStates.get(run.threadId) === "running"
  })
}

function increment<K>(counts: Map<K, number>, key: K): void {
  counts.set(key, (counts.get(key) ?? 0) + 1)
}

/** Which queued runs start now: projects round-robin from after `cursor`, oldest run first inside a project. */
export function planDispatch(input: DispatchInput): DispatchPlan {
  const { caps } = input
  const byUser = new Map<UserId, number>()
  const byProject = new Map<ProjectId, number>()
  for (const holder of input.holders) {
    increment(byUser, holder.userId)
    increment(byProject, holder.projectId)
  }
  let running = input.holders.length

  const pending = new Map<ProjectId, QueuedRun[]>()
  const oldestFirst = [...input.queued].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
  for (const run of oldestFirst) {
    const list = pending.get(run.projectId) ?? []
    list.push(run)
    pending.set(run.projectId, list)
  }
  const projects = [...pending.keys()]
  const after = input.cursor === null ? -1 : projects.indexOf(input.cursor)
  const order = after < 0 ? projects : [...projects.slice(after + 1), ...projects.slice(0, after + 1)]

  const start: RunId[] = []
  let cursor = input.cursor
  let progressed = true
  while (progressed && running < caps.machine) {
    progressed = false
    for (const projectId of order) {
      if (running >= caps.machine) break
      const head = pending.get(projectId)?.[0]
      if (head === undefined) continue
      if ((byProject.get(projectId) ?? 0) >= caps.perProject(projectId)) continue
      if ((byUser.get(head.userId) ?? 0) >= caps.perUser(head.userId)) continue
      pending.get(projectId)?.shift()
      start.push(head.id)
      increment(byUser, head.userId)
      increment(byProject, projectId)
      running += 1
      cursor = projectId
      progressed = true
    }
  }
  return { start, cursor }
}
