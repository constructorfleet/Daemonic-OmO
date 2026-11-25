import {
  type BindCompletionArgs,
  type CloseArgs,
  type CloseOutcome,
  type CompletionBinding,
  type CompletionOutcome,
  type CreateOutcome,
  type CreateThreadArgs,
  type EnsureHostArgs,
  type EnsureHostOutcome,
  type Gateway,
  type GatewayAck,
  type GatewayErrorCode,
  type GatewayOk,
  type GatewayProbe,
  type GatewayRefusal,
  type GatewayResult,
  type InterruptArgs,
  type ListArgs,
  type ReadArgs,
  type SendArgs,
  type SendOutcome,
  type SetModelArgs,
  type ThreadSnapshot,
  type ThreadState,
} from "../../../src/core/ports"
import type { ThreadId } from "../../../src/core/types"
import {
  GatewayFailpointError,
  GatewayRecorder,
  type GatewayCall,
  type GatewayFailpoint,
} from "./gateway-recorder"
import { FakeThreadStore, snapshot, type SeedThreadInput } from "./gateway-threads"

export interface FakeGatewayOptions {
  readonly sdkLoad?: "ok" | "fail"
  readonly presetNames?: readonly string[]
  readonly failpoints?: readonly GatewayFailpoint[]
}

const DEFAULT_PRESETS = ["full-access", "workspace", "accept-edits", "auto", "read-only"] as const

export class FakeGateway implements Gateway {
  private readonly store = new FakeThreadStore()
  private readonly recorder = new GatewayRecorder()
  private readonly pendingFailpoints: GatewayFailpoint[]
  private readonly completions = new Map<string, CompletionOutcome>()
  private sdkLoad: "ok" | "fail"
  private presets: readonly string[]
  private bindingSeq = 0

  constructor(options: FakeGatewayOptions = {}) {
    this.sdkLoad = options.sdkLoad ?? "ok"
    this.presets = options.presetNames ?? DEFAULT_PRESETS
    this.pendingFailpoints = [...(options.failpoints ?? [])]
  }

  get calls(): readonly GatewayCall[] {
    return this.recorder.calls
  }

  get createCalls(): readonly CreateThreadArgs[] {
    return this.recorder.createCalls
  }

  get sendCalls(): readonly SendArgs[] {
    return this.recorder.sendCalls
  }

  get closeCalls(): readonly CloseArgs[] {
    return this.recorder.closeCalls
  }

  get bindCompletionCalls(): readonly BindCompletionArgs[] {
    return this.recorder.bindCompletionCalls
  }

  get ensureHostCalls(): readonly EnsureHostArgs[] {
    return this.recorder.ensureHostCalls
  }

  setSdkLoad(value: "ok" | "fail"): void {
    this.sdkLoad = value
  }

  setPresetNames(names: readonly string[]): void {
    this.presets = [...names]
  }

  failNext(failpoint: GatewayFailpoint): void {
    this.pendingFailpoints.push(failpoint)
  }

  seedThread(input: SeedThreadInput = {}): ThreadId {
    return this.store.seed(input)
  }

  setThreadState(thread: ThreadId, state: ThreadState): void {
    this.store.require(thread).state = state
  }

  setThreadControls(thread: ThreadId, controls: readonly string[]): void {
    this.store.require(thread).controls = [...controls]
  }

  setCompletionOutcome(thread: ThreadId, outcome: CompletionOutcome): void {
    this.store.require(thread)
    this.completions.set(thread, outcome)
  }

  getCompletionOutcome(thread: ThreadId): CompletionOutcome | null {
    return this.completions.get(thread) ?? null
  }

  async create(args: CreateThreadArgs): Promise<GatewayResult<CreateOutcome>> {
    this.recorder.record({ method: "create", args })
    const failpoint = this.takeFailpoint()
    if (failpoint === "afterDecideCommit") {
      throw new GatewayFailpointError(failpoint)
    }
    if (this.sdkLoad === "fail") {
      return refusal("sdk_unavailable", "fake gateway: sdk failed to load")
    }
    const reopened = this.store.byIdempotencyKey(args.idempotencyKey)
    if (reopened !== undefined) {
      reopened.visible = true
      return ok({ thread: reopened.thread, sessionId: reopened.sessionId, created: false })
    }
    const record = this.store.create({
      name: args.name,
      cwd: args.cwd,
      model: args.model ?? null,
      visible: failpoint !== "afterCreateBeforeCommit",
    })
    this.store.bindIdempotencyKey(args.idempotencyKey, record.thread)
    if (failpoint !== null) {
      throw new GatewayFailpointError(failpoint)
    }
    return ok({ thread: record.thread, sessionId: record.sessionId, created: true })
  }

  async send(args: SendArgs): Promise<GatewayResult<SendOutcome>> {
    this.recorder.record({ method: "send", args })
    if (this.sdkLoad === "fail") {
      return refusal("sdk_unavailable", "fake gateway: sdk failed to load")
    }
    const thread = this.store.find(args.thread)
    if (thread === undefined || !thread.visible) {
      return refusal("not_resumable", `fake gateway: no live thread ${args.thread}`)
    }
    if (thread.sentKeys.has(args.idempotencyKey)) {
      return ok({ delivered: false, deduplicated: true })
    }
    thread.sentKeys.add(args.idempotencyKey)
    thread.state = "running"
    return ok({ delivered: true, deduplicated: false })
  }

  async read(args: ReadArgs): Promise<GatewayResult<ThreadSnapshot>> {
    this.recorder.record({ method: "read", args })
    const thread = this.store.find(args.thread)
    if (thread === undefined || !thread.visible) {
      return refusal("not_resumable", `fake gateway: no live thread ${args.thread}`)
    }
    return ok(snapshot(thread))
  }

  async list(args: ListArgs = {}): Promise<GatewayResult<readonly ThreadSnapshot[]>> {
    this.recorder.record({ method: "list", args })
    return ok(this.store.visible().map((thread) => snapshot(thread)))
  }

  async interrupt(args: InterruptArgs): Promise<GatewayAck> {
    this.recorder.record({ method: "interrupt", args })
    const thread = this.store.find(args.thread)
    if (thread === undefined || !thread.visible) {
      return refusal("not_resumable", `fake gateway: no live thread ${args.thread}`)
    }
    thread.state = "idle"
    return { kind: "ok" }
  }

  async close(args: CloseArgs): Promise<GatewayResult<CloseOutcome>> {
    this.recorder.record({ method: "close", args })
    const thread = this.store.find(args.thread)
    if (thread === undefined || !thread.visible) {
      return ok({ closed: false, reason: "not_live" })
    }
    thread.state = "inactive"
    thread.visible = false
    return ok({ closed: true, reason: "closed" })
  }

  async setModel(args: SetModelArgs): Promise<GatewayAck> {
    this.recorder.record({ method: "setModel", args })
    const thread = this.store.find(args.thread)
    if (thread === undefined || !thread.visible) {
      return refusal("not_resumable", `fake gateway: no live thread ${args.thread}`)
    }
    thread.model = args.model
    return { kind: "ok" }
  }

  async bindCompletion(args: BindCompletionArgs): Promise<GatewayResult<CompletionBinding>> {
    this.recorder.record({ method: "bindCompletion", args })
    if (!this.store.has(args.thread)) {
      return refusal("not_resumable", `fake gateway: no thread ${args.thread}`)
    }
    this.bindingSeq += 1
    return ok({
      bindingId: `binding-${this.bindingSeq}`,
      thread: args.thread,
      events: [...args.events],
    })
  }

  async ensureHost(args: EnsureHostArgs): Promise<GatewayResult<EnsureHostOutcome>> {
    this.recorder.record({ method: "ensureHost", args })
    if (this.sdkLoad === "fail") {
      return refusal("host_unavailable", "fake gateway: host cannot be ensured")
    }
    return ok({ started: true, pid: 4242 })
  }

  async probe(): Promise<GatewayProbe> {
    this.recorder.record({ method: "probe", args: null })
    if (this.sdkLoad === "fail") {
      return { sdkLoad: "fail", presetNames: [], version: null, detail: "fake sdk failed to load" }
    }
    return { sdkLoad: "ok", presetNames: [...this.presets], version: "fake", detail: null }
  }

  private takeFailpoint(): GatewayFailpoint | null {
    return this.pendingFailpoints.shift() ?? null
  }
}

function ok<T>(value: T): GatewayOk<T> {
  return { kind: "ok", value }
}

function refusal(code: GatewayErrorCode, message: string): GatewayRefusal {
  return { kind: "error", code, message }
}
