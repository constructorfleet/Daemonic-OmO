import type {
  Ms,
  PermissionPreset,
  SessionId,
  ThinkingLevel,
  ThreadId,
} from "./types"

export interface TimerHandle {
  readonly id: number
}

export interface Clock {
  /** Wall clock; advances with system sleep. */
  now(): Ms
  /** Monotonic clock; may pause during system sleep. */
  monotonicNow(): Ms
  /** Fires when the wall clock reaches `at`. */
  setTimer(at: Ms, fn: () => void): TimerHandle
  clearTimer(handle: TimerHandle): void
}

export type FileKind = "file" | "directory" | "other"

export interface FileStat {
  readonly path: string
  readonly size: number
  readonly mtimeMs: number
  readonly kind: FileKind
}

export interface DirEntry {
  readonly name: string
  readonly kind: FileKind
}

export interface FileHandle {
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<number>
  close(): Promise<void>
}

export interface WatchStamp {
  readonly dev: number
  readonly ino: number
  readonly size: number
  readonly mtimeMs: number
}

export type FsErrorCode = "not_found" | "permission_denied" | "io"

export class FsError extends Error {
  readonly path: string
  readonly code: FsErrorCode

  constructor(path: string, code: FsErrorCode, options?: ErrorOptions) {
    super(`fs ${code}: ${path}`, options)
    this.name = "FsError"
    this.path = path
    this.code = code
  }
}

export interface Fs {
  readFileRange(path: string, offset: number, length: number): Promise<Uint8Array>
  stat(path: string): Promise<FileStat>
  readdir(path: string): Promise<readonly DirEntry[]>
  open(path: string): Promise<FileHandle>
  /**
   * Cheap change-detection stamp. Callers re-read a file only when the stamp
   * changes; `null` means the file is missing.
   */
  watchHint(path: string): Promise<WatchStamp | null>
}

export interface Rng {
  next(): number
  nextInt(maxExclusive: number): number
  nextBytes(count: number): Uint8Array
}

export interface WorktreeAddArgs {
  readonly repo: string
  readonly path: string
  readonly branch: string
  readonly base: string
}

export interface WorktreeEntry {
  readonly path: string
  readonly branch: string | null
  readonly head: string | null
  readonly bare: boolean
}

export class GitError extends Error {
  readonly args: readonly string[]
  readonly exitCode: number | null
  readonly stderr: string

  constructor(
    message: string,
    fields: {
      readonly args: readonly string[]
      readonly exitCode: number | null
      readonly stderr: string
    },
  ) {
    super(message)
    this.name = "GitError"
    this.args = fields.args
    this.exitCode = fields.exitCode
    this.stderr = fields.stderr
  }
}

export interface Git {
  isRepo(path: string): Promise<boolean>
  worktreeAdd(args: WorktreeAddArgs): Promise<WorktreeEntry>
  worktreeList(repo: string): Promise<readonly WorktreeEntry[]>
}

export type ThreadState = "running" | "idle" | "inactive"

export interface ThreadSnapshot {
  readonly thread: ThreadId
  readonly name: string
  readonly cwd: string
  readonly state: ThreadState
  readonly controls: readonly string[]
  readonly sessionId: SessionId | null
  readonly surface: string | null
}

export interface CreateThreadArgs {
  readonly name: string
  readonly cwd: string
  readonly model?: string
  readonly reasoning?: ThinkingLevel
  readonly permissionPreset?: PermissionPreset
  readonly prompt?: string
  readonly idempotencyKey: string
}

export interface CreateOutcome {
  readonly thread: ThreadId
  readonly sessionId: SessionId | null
  /** False when an existing thread was reopened by the idempotency key. */
  readonly created: boolean
}

export interface SendArgs {
  readonly thread: ThreadId
  readonly text: string
  readonly mode?: "follow_up"
  readonly idempotencyKey: string
}

export interface SendOutcome {
  readonly delivered: boolean
  readonly deduplicated: boolean
}

export interface ReadArgs {
  readonly thread: ThreadId
}

export interface ListArgs {
  readonly allScope?: boolean
}

export interface InterruptArgs {
  readonly thread: ThreadId
  readonly turnId?: string
  readonly allScope?: boolean
}

export interface CloseArgs {
  readonly thread: ThreadId
  readonly force?: boolean
  readonly graceful?: boolean
  readonly waitMs?: number
  readonly idempotencyKey?: string
}

export type CloseReason = "closed" | "not_live" | "timeout"

export interface CloseOutcome {
  readonly closed: boolean
  readonly reason: CloseReason
}

export interface SetModelArgs {
  readonly thread: ThreadId
  readonly model: string
  readonly provider?: string
}

export interface BindCompletionArgs {
  readonly thread: ThreadId
  readonly events: readonly string[]
}

export interface CompletionBinding {
  readonly bindingId: string
  readonly thread: ThreadId
  readonly events: readonly string[]
}

export type CompletionStatus = "completed" | "failed" | "aborted" | "idle"

export interface CompletionOutcome {
  readonly status: CompletionStatus
  readonly detail: string | null
}

export interface EnsureHostArgs {
  readonly agentDir: string
}

export interface EnsureHostOutcome {
  readonly started: boolean
  readonly pid: number | null
}

export interface GatewayProbe {
  readonly sdkLoad: "ok" | "fail"
  readonly presetNames: readonly string[]
  readonly version: string | null
  readonly detail: string | null
}

export const GATEWAY_ERROR_CODES = [
  "invalid_arguments",
  "not_resumable",
  "caller_context_missing",
  "host_unavailable",
  "sdk_unavailable",
  "internal",
] as const
export type GatewayErrorCode = (typeof GATEWAY_ERROR_CODES)[number]

export interface GatewayRefusal {
  readonly kind: "error"
  readonly code: GatewayErrorCode
  readonly message: string
}

export interface GatewayOk<T> {
  readonly kind: "ok"
  readonly value: T
}

export type GatewayResult<T> = GatewayOk<T> | GatewayRefusal

export type GatewayAck = { readonly kind: "ok" } | GatewayRefusal

export interface Gateway {
  create(args: CreateThreadArgs): Promise<GatewayResult<CreateOutcome>>
  send(args: SendArgs): Promise<GatewayResult<SendOutcome>>
  read(args: ReadArgs): Promise<GatewayResult<ThreadSnapshot>>
  list(args?: ListArgs): Promise<GatewayResult<readonly ThreadSnapshot[]>>
  interrupt(args: InterruptArgs): Promise<GatewayAck>
  close(args: CloseArgs): Promise<GatewayResult<CloseOutcome>>
  setModel(args: SetModelArgs): Promise<GatewayAck>
  bindCompletion(
    args: BindCompletionArgs,
  ): Promise<GatewayResult<CompletionBinding>>
  ensureHost(args: EnsureHostArgs): Promise<GatewayResult<EnsureHostOutcome>>
  probe(): Promise<GatewayProbe>
}
