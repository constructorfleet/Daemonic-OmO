import { PERMISSION_MODE, type Iso, type LoopId, type Ms, type Project, type Run, type RunId, type RunSpec, type ScheduleId, type UserId } from "../core/types"
import { worktreeLocation } from "./worktree"

/** Where a run's fire key comes from; a retry keeps the fire key and takes the next attempt. */
export type RunTrigger =
  | { readonly kind: "adhoc"; readonly actor: UserId }
  | { readonly kind: "schedule"; readonly scheduleId: ScheduleId; readonly fireKey: string; readonly slotAt: Ms }
  | { readonly kind: "loop"; readonly loopId: LoopId; readonly iteration: number; readonly fireKey: string }
  | { readonly kind: "retry"; readonly of: Run; readonly actor: UserId }

/** `run_worktree`: a fresh daemon worktree for this run; `shared_worktree`: an existing one (a loop's, a retry's). */
export type RunWorkspace =
  | { readonly kind: "checkout" }
  | { readonly kind: "run_worktree"; readonly name: string }
  | { readonly kind: "shared_worktree"; readonly path: string; readonly branch: string }

export interface DecideInput {
  readonly project: Project
  readonly spec: RunSpec
  readonly workspace: RunWorkspace
  readonly trigger: RunTrigger
}

export interface NewRunContext {
  readonly id: RunId
  readonly at: Iso
  readonly worktreeRoot: string
}

function origin(trigger: RunTrigger, id: RunId): Pick<Run, "fireKey" | "attempt" | "scheduleId" | "loopId" | "iteration" | "slotAt"> {
  switch (trigger.kind) {
    case "adhoc":
      return { fireKey: `adhoc:${id}`, attempt: 1 }
    case "schedule":
      return { fireKey: trigger.fireKey, attempt: 1, scheduleId: trigger.scheduleId, slotAt: trigger.slotAt }
    case "loop":
      return { fireKey: trigger.fireKey, attempt: 1, loopId: trigger.loopId, iteration: trigger.iteration }
    case "retry": {
      const { of } = trigger
      return {
        fireKey: of.fireKey,
        attempt: of.attempt + 1,
        ...(of.scheduleId === undefined ? {} : { scheduleId: of.scheduleId }),
        ...(of.loopId === undefined ? {} : { loopId: of.loopId }),
        ...(of.iteration === undefined ? {} : { iteration: of.iteration }),
        ...(of.slotAt === undefined ? {} : { slotAt: of.slotAt }),
      }
    }
    default:
      return assertNever(trigger)
  }
}

function placement(input: DecideInput, context: NewRunContext): Pick<Run, "cwd" | "worktreePath" | "branch"> {
  const { workspace, project, trigger } = input
  switch (workspace.kind) {
    case "checkout":
      return { cwd: project.cwd }
    case "shared_worktree":
      return { cwd: workspace.path, worktreePath: workspace.path, branch: workspace.branch }
    case "run_worktree": {
      const scheduled = trigger.kind === "schedule" || (trigger.kind === "retry" && trigger.of.scheduleId !== undefined)
      const owner = { kind: scheduled ? "sched" : "adhoc", id: context.id, name: workspace.name } as const
      const location = worktreeLocation(context.worktreeRoot, project.id, owner)
      return { cwd: location.path, worktreePath: location.path, branch: location.branch }
    }
    default:
      return assertNever(workspace)
  }
}

/** The `queued` row `decide` inserts unless its fire key and attempt already have one. */
export function newRun(input: DecideInput, context: NewRunContext): Run {
  return {
    id: context.id,
    userId: input.project.userId,
    projectId: input.project.id,
    ...origin(input.trigger, context.id),
    name: `odm-${context.id}`,
    spec: input.spec,
    ...placement(input, context),
    state: "queued",
    outcome: null,
    cancelRequested: false,
    orphanChildren: [],
    permissionMode: PERMISSION_MODE,
    createdAt: context.at,
    updatedAt: context.at,
    revision: 1,
  }
}

/** A retry is the same fire: it reuses the worktree its earlier attempt ran in, or adds one if that never existed. */
export function retryWorkspace(run: Run, projectName: string): RunWorkspace {
  if (run.worktreePath === undefined || run.branch === undefined) return { kind: "checkout" }
  if (run.outcome?.kind === "skipped") return { kind: "run_worktree", name: projectName }
  return { kind: "shared_worktree", path: run.worktreePath, branch: run.branch }
}

function assertNever(value: never): never {
  throw new TypeError(`unexpected variant: ${JSON.stringify(value)}`)
}
