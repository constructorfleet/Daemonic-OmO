// allow: SIZE_OK - pure type declarations with no executable logic.
/**
 * Daemon domain types.
 *
 * These are the entity shapes shared by the persistence layer, the scheduler,
 * the run engine and the HTTP API. They are intentionally free of I/O: every
 * type here is plain data, so fakes and tests can build them without a daemon.
 *
 * `Run` follows the plan's thread-model lifecycle ("Run lifecycle (thread
 * model)" in `.omo/plans/omo-daemonic.md`), which supersedes the process-model
 * fields of the detail design: a run addresses an omo thread, never a pid.
 */

export type Ms = number

export type Iso = string

declare const brand: unique symbol

export type Brand<T, B extends string> = T & { readonly [brand]: B }

export type Ulid = Brand<string, "Ulid">
export type Uuid = Brand<string, "Uuid">
export type UserId = Ulid
export type ProjectId = Ulid
export type ScheduleId = Ulid
export type LoopId = Ulid
export type RunId = Ulid
export type AuditId = Ulid

export type ThreadId = Brand<string, "ThreadId">

export type SessionId = Brand<string, "SessionId">

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue }

export type JsonObject = { readonly [key: string]: JsonValue }

export const USER_ROLES = ["admin", "member"] as const
export type UserRole = (typeof USER_ROLES)[number]

export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const
export type ThinkingLevel = (typeof THINKING_LEVELS)[number]

export const PERMISSION_PRESETS = [
  "full-access",
  "workspace",
  "accept-edits",
  "auto",
  "read-only",
] as const
export type PermissionPreset = (typeof PERMISSION_PRESETS)[number]

export interface UserSettings {
  readonly maxRunning?: number
  readonly maxRunningPerProject?: number
  readonly runTimeoutMs?: number
  readonly readBytes?: number
  readonly loopMaxIterations?: number
}

export interface User {
  readonly id: UserId
  readonly oidcIssuer: string
  readonly oidcSub: string
  readonly email: string
  readonly name: string
  readonly role: UserRole
  readonly agentDir: string
  readonly allowedRoots: readonly string[]
  readonly settings: UserSettings
  readonly createdAt: Iso
  readonly updatedAt: Iso
  readonly lastLoginAt: Iso | null
}

export const PROJECT_STATES = ["active", "archived"] as const
export type ProjectState = (typeof PROJECT_STATES)[number]

export interface ProjectSettings {
  readonly fullAccessOptIn: boolean
  readonly maxRunning: number
  readonly defaultModel?: string
  readonly defaultReasoning?: ThinkingLevel
  readonly worktreeForAdhoc: boolean
}

export interface Project {
  readonly id: ProjectId
  readonly userId: UserId
  readonly name: string
  readonly cwd: string
  readonly agentDir: string
  readonly stateDir: string
  readonly settings: ProjectSettings
  readonly state: ProjectState
  readonly revision: number
  readonly createdAt: Iso
  readonly updatedAt: Iso
}

export interface RunSpec {
  /** At most 1 MiB, matching omo's thread send cap. */
  readonly prompt: string
  readonly model?: string
  readonly thinking?: ThinkingLevel
  readonly permissionPreset?: PermissionPreset
  readonly extraArgs?: readonly string[]
  readonly timeoutMs: number
  readonly nameTemplate?: string
}

export type ScheduleTrigger =
  | { readonly kind: "cron"; readonly expr: string; readonly tz: string }
  | { readonly kind: "once"; readonly at: Iso }
  | { readonly kind: "interval"; readonly everyMs: number; readonly anchorAt: Iso }

export const OVERLAP_POLICIES = ["skip", "queue", "parallel"] as const
export type OverlapPolicy = (typeof OVERLAP_POLICIES)[number]

export const MISFIRE_POLICIES = ["skip", "fire_once", "fire_all"] as const
export type MisfirePolicy = (typeof MISFIRE_POLICIES)[number]

export const SCHEDULE_STATES = [
  "active",
  "paused",
  "completed",
  "errored",
] as const
export type ScheduleState = (typeof SCHEDULE_STATES)[number]

export type ScheduleTarget =
  | { readonly kind: "run"; readonly spec: RunSpec }
  | { readonly kind: "loop"; readonly template: LoopTemplate }

export interface Schedule {
  readonly id: ScheduleId
  readonly userId: UserId
  readonly projectId: ProjectId
  readonly name: string
  readonly trigger: ScheduleTrigger
  readonly target: ScheduleTarget
  readonly overlap: OverlapPolicy
  readonly queueMax: number
  readonly misfire: MisfirePolicy
  readonly misfireGraceMs: number
  readonly maxCatchup: number
  readonly endAt?: Iso
  readonly maxFires?: number
  readonly fireCount: number
  readonly state: ScheduleState
  readonly errorReason?: string
  /** Next slot not yet decided. */
  readonly nextFireAt: Ms | null
  /** Newest slot already decided (fired or skipped). */
  readonly lastSlotAt: Ms | null
  readonly revision: number
  readonly deletedAt?: Iso
}

export type DonePredicate =
  | { readonly kind: "marker" }
  | { readonly kind: "goal" }
  | { readonly kind: "check"; readonly command: readonly string[]; readonly timeoutMs: number }

export interface LoopBackoff {
  readonly initialMs: number
  readonly factor: number
  readonly maxMs: number
}

export const SESSION_MODES = ["fresh", "continue"] as const
export type SessionMode = (typeof SESSION_MODES)[number]

export interface LoopTemplate {
  readonly spec: RunSpec
  readonly doneWhen: readonly DonePredicate[]
  /** Required, 1..100. */
  readonly maxIterations: number
  readonly maxWallMs?: number
  readonly maxConsecutiveFailures: number
  readonly cadenceMs: number
  readonly backoff: LoopBackoff
  readonly sessionMode: SessionMode
  readonly carryForwardBytes: number
}

export const LOOP_STATES = [
  "pending",
  "running",
  "waiting",
  "cancelling",
  "succeeded",
  "blocked",
  "exhausted",
  "failed",
  "cancelled",
] as const
export type LoopState = (typeof LOOP_STATES)[number]

export interface Loop extends LoopTemplate {
  readonly id: LoopId
  readonly userId: UserId
  readonly projectId: ProjectId
  readonly scheduleId?: ScheduleId
  readonly fireKey: string
  readonly nonce: string
  readonly state: LoopState
  readonly iteration: number
  readonly consecutiveFailures: number
  readonly nextIterationAt: Ms | null
  readonly activeRunId?: RunId
  readonly evaluatedRunId?: RunId
  readonly startedAt?: Iso
  readonly endedAt?: Iso
  readonly stopReason?: string
  readonly revision: number
}

export const RUN_STATES = [
  "queued",
  "creating",
  "active",
  "settled",
  "evaluating",
  "closed",
  "kept",
] as const
export type RunState = (typeof RUN_STATES)[number]

export const RUN_FAILURE_REASONS = [
  "create_refused",
  "turn_error",
  "host_unavailable",
  "gateway_degraded",
  "preset_unconfirmed",
] as const
export type RunFailureReason = (typeof RUN_FAILURE_REASONS)[number]

export const RUN_SKIP_REASONS = [
  "overlap",
  "queue_full",
  "stale",
  "worktree_cap",
] as const
export type RunSkipReason = (typeof RUN_SKIP_REASONS)[number]

export const CANCEL_REASONS = [
  "user",
  "timeout",
  "loop_cancel",
  "shutdown",
] as const
export type CancelReason = (typeof CANCEL_REASONS)[number]

export type RunOutcome =
  | { readonly kind: "succeeded" }
  | { readonly kind: "failed"; readonly reason: RunFailureReason }
  | { readonly kind: "cancelled" }
  | { readonly kind: "timed_out" }
  | { readonly kind: "lost"; readonly reason: "thread_missing" }
  | { readonly kind: "skipped"; readonly reason: RunSkipReason }

export interface OrphanChild {
  readonly taskId: string
  readonly sessionId: SessionId
  readonly state: string
}

export interface Run {
  readonly id: RunId
  readonly userId: UserId
  readonly projectId: ProjectId
  readonly scheduleId?: ScheduleId
  readonly loopId?: LoopId
  readonly iteration?: number
  readonly fireKey: string
  readonly attempt: number
  readonly slotAt?: Ms
  readonly name: string
  readonly spec: RunSpec
  readonly cwd: string
  readonly worktreePath?: string
  readonly branch?: string
  readonly threadId?: ThreadId
  readonly sessionId?: SessionId
  readonly sessionFile?: string
  readonly state: RunState
  readonly outcome: RunOutcome | null
  readonly cancelRequested: boolean
  readonly cancelReason?: CancelReason
  readonly orphanChildren: readonly OrphanChild[]
  readonly createdAt: Iso
  readonly updatedAt: Iso
  readonly activeAt?: Iso
  readonly settledAt?: Iso
  readonly endedAt?: Iso
  readonly revision: number
}

export const ENTITY_KINDS = [
  "user",
  "project",
  "schedule",
  "loop",
  "run",
  "daemon",
] as const
export type EntityKind = (typeof ENTITY_KINDS)[number]

export interface AuditEntry {
  readonly id: AuditId
  readonly userId: UserId
  readonly at: Iso
  readonly action: string
  readonly entityKind: EntityKind
  readonly entityId: string
  readonly detail: JsonObject
}

/**
 * One row of the gap-free event ledger. `seq` is global, `userSeq` is the
 * per-user cursor used by member SSE streams.
 */
export interface DaemonEvent {
  readonly seq: number
  readonly userSeq: number
  readonly at: Iso
  readonly type: string
  readonly entityKind: EntityKind
  readonly entityId: string
  readonly userId: UserId
  readonly projectId: ProjectId | null
  readonly data: JsonObject
}
