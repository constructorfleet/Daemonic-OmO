import { join } from "node:path"

import type { Env, OmoConfig } from "../config/types"
import { threadId as toThreadId } from "../core/ids"
import type {
  BindCompletionArgs,
  Clock,
  CloseArgs,
  CloseOutcome,
  CompletionBinding,
  CompletionEvent,
  CreateOutcome,
  CreateThreadArgs,
  EnsureHostArgs,
  EnsureHostOutcome,
  Fs,
  Gateway,
  GatewayAck,
  GatewayProbe,
  GatewayRefusal,
  GatewayResult,
  HostSessionState,
  InterruptArgs,
  ListArgs,
  ReadArgs,
  ReleaseHoldOutcome,
  SendArgs,
  SendOutcome,
  SetModelArgs,
  ThreadSnapshot,
  WatchStamp,
} from "../core/ports"
import type { Ms, ThreadId } from "../core/types"
import { BRIDGE_BACKOFF_DEFAULTS, BridgeProcess, type Backoff } from "./bridge-process"
import { completionOutcome, decodeAck, decodeBinding, decodeClose, decodeCreate, decodeSend, isRecord, parseThreadList, refusal } from "./decode"
import { OmoCli } from "./host"
import type { BridgeMethod } from "./protocol"
import { omoChildEnv, selectBridgeRuntime } from "./runtime"

export { BRIDGE_BACKOFF_DEFAULTS } from "./bridge-process"

/** Base deadline of one bridge request; `close` adds its own `waitMs`. */
export const BRIDGE_REQUEST_TIMEOUT_MS: Ms = 60_000

/** omo 5.1.79's SDK names (FINDINGS assertion 4). The SDK exports no list; shown for display only, never sent. */
export const SDK_PRESET_NAMES: readonly string[] = ["full-access", "workspace", "accept-edits", "auto", "read-only", "ask"]

export interface BridgeClientOptions {
  readonly agentDir: string
  readonly omo: OmoConfig
  readonly clock: Clock
  readonly fs: Fs
  /** The daemon's environment; only the allowlisted keys reach omo children. */
  readonly baseEnv: Env
  readonly user?: string
  readonly requestTimeoutMs?: Ms
  readonly commandTimeoutMs?: Ms
  readonly backoff?: Backoff
  /** Awaited after the child restarted for a new installed omo-ai version (the feature re-runs the probe). */
  readonly onVersionChange?: (version: string | null) => Promise<void>
}

/**
 * The Gateway port for one agent dir, over its bridge child's stdio. Every thread call passes `all_scope: true`
 * (FINDINGS assertion 8: one handle reaches threads of every cwd). A `host_unavailable` answer runs
 * `omo daemon run --json --pinned` and retries once; the first `create` ensures the host first.
 */
export class BridgeClient implements Gateway {
  readonly #options: BridgeClientOptions
  readonly #process: BridgeProcess
  readonly #cli: OmoCli
  readonly #listeners = new Set<(event: CompletionEvent) => void>()
  readonly #packageJson: string
  #hostEnsured = false
  #stamp: WatchStamp | null | undefined = undefined
  #version: string | null = null
  #versionCheck: Promise<void> | null = null

  constructor(options: BridgeClientOptions) {
    this.#options = options
    const env = omoChildEnv(options.baseEnv, options.agentDir)
    this.#packageJson = join(options.omo.pluginRoot, "..", "package.json")
    this.#cli = new OmoCli({ bin: options.omo.bin, agentDir: options.agentDir, baseEnv: options.baseEnv, clock: options.clock, ...(options.commandTimeoutMs === undefined ? {} : { timeoutMs: options.commandTimeoutMs }) })
    this.#process = new BridgeProcess({
      config: { pluginRoot: options.omo.pluginRoot, agentDir: options.agentDir, user: options.user ?? "omo-daemonic" },
      env,
      runtime: selectBridgeRuntime(env),
      clock: options.clock,
      backoff: options.backoff ?? BRIDGE_BACKOFF_DEFAULTS,
      onCompletion: (event) => {
        const pushed: CompletionEvent = { bindingId: event.bindingId, thread: toThreadId(event.thread), outcome: completionOutcome(event.outcome) }
        for (const listener of this.#listeners) listener(pushed)
      },
    })
  }

  get pid(): number | null {
    return this.#process.pid
  }

  /** The SDK methods the live child reported; empty while degraded or not started. */
  capabilities(): readonly string[] {
    return this.#process.capabilities
  }

  async create(args: CreateThreadArgs): Promise<GatewayResult<CreateOutcome>> {
    if (!this.#hostEnsured && typeof (await this.#process.hello()) !== "string") {
      const ensured = await this.ensureHost({ agentDir: this.#options.agentDir })
      if (ensured.kind === "error") return ensured
    }
    const { name, cwd, model, reasoning, prompt, idempotencyKey } = args
    return this.#call("create", { name, cwd, model, reasoning, prompt, idempotency_key: idempotencyKey }, decodeCreate)
  }

  send(args: SendArgs): Promise<GatewayResult<SendOutcome>> {
    return this.#call("send", { thread: args.thread, text: args.text, mode: args.mode, idempotency_key: args.idempotencyKey }, decodeSend)
  }

  /** The SDK's `read` returns transcript entries; the snapshot comes from the thread's list row. */
  async read(args: ReadArgs): Promise<GatewayResult<ThreadSnapshot>> {
    const listed = await this.list({ allScope: true })
    if (listed.kind === "error") return listed
    const row = listed.value.find((snapshot) => snapshot.thread === args.thread)
    return row === undefined ? refusal("not_resumable", `no session holds thread ${args.thread}`) : { kind: "ok", value: row }
  }

  list(args: ListArgs = {}): Promise<GatewayResult<readonly ThreadSnapshot[]>> {
    return this.#call("list", { all_scope: args.allScope ?? true }, parseThreadList)
  }

  interrupt(args: InterruptArgs): Promise<GatewayAck> {
    return this.#call("interrupt", { thread: args.thread, turn_id: args.turnId, all_scope: true }, (raw) => decodeAck(raw, "interrupt"))
  }

  close(args: CloseArgs): Promise<GatewayResult<CloseOutcome>> {
    const sdkArgs = { thread: args.thread, force: args.force, graceful: args.graceful, wait_ms: args.waitMs, idempotency_key: args.idempotencyKey, all_scope: true }
    return this.#call("close", sdkArgs, decodeClose, args.waitMs ?? 0)
  }

  setModel(args: SetModelArgs): Promise<GatewayAck> {
    return this.#call("set_model", { thread: args.thread, model: args.model, provider: args.provider, all_scope: true }, (raw) => decodeAck(raw, "set_model"))
  }

  bindCompletion(args: BindCompletionArgs): Promise<GatewayResult<CompletionBinding>> {
    return this.#call("bindCompletion", { thread: args.thread, events: args.events }, decodeBinding)
  }

  onCompletion(listener: (event: CompletionEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  async ensureHost(args: EnsureHostArgs): Promise<GatewayResult<EnsureHostOutcome>> {
    if (args.agentDir !== this.#options.agentDir) {
      return refusal("invalid_arguments", `this gateway serves ${this.#options.agentDir}, not ${args.agentDir}`)
    }
    const ensured = await this.#cli.ensureHost()
    if (ensured.kind === "ok") this.#hostEnsured = true
    return ensured
  }

  sessionState(thread: ThreadId): Promise<GatewayResult<HostSessionState>> {
    return this.#withHost(() => this.#cli.sessionState(thread))
  }

  releaseHold(thread: ThreadId, text: string): Promise<GatewayResult<ReleaseHoldOutcome>> {
    return this.#withHost(() => this.#cli.releaseHold(thread, text))
  }

  /** Re-checks the SDK: a degraded bridge is retired first, so a fixed install recovers here. */
  async probe(): Promise<GatewayProbe> {
    await this.#checkVersion()
    if (this.#process.degraded) await this.#process.restart()
    const hello = await this.#process.hello()
    return typeof hello === "string"
      ? { sdkLoad: "fail", presetNames: [], version: this.#version, detail: hello }
      : { sdkLoad: "ok", presetNames: SDK_PRESET_NAMES, version: this.#version, detail: hello.runtime }
  }

  async stop(): Promise<void> {
    await this.#process.stop()
  }

  async #call<R extends Answer>(method: BridgeMethod, args: unknown, decode: (raw: unknown) => R, waitMs: Ms = 0): Promise<R | GatewayRefusal> {
    await this.#checkVersion()
    return this.#withHost(async (): Promise<R | GatewayRefusal> => {
      const answer = await this.#process.request(method, args, (this.#options.requestTimeoutMs ?? BRIDGE_REQUEST_TIMEOUT_MS) + waitMs)
      return answer.kind === "ok" ? decode(answer.value) : answer
    })
  }

  async #withHost<R extends Answer>(attempt: () => Promise<R>): Promise<R> {
    const first = await attempt()
    if (first.kind === "ok" || first.code !== "host_unavailable") return first
    const ensured = await this.ensureHost({ agentDir: this.#options.agentDir })
    return ensured.kind === "ok" ? attempt() : first
  }

  /**
   * Restarts the child when the installed omo-ai `package.json` version changes. Concurrent callers share one
   * check; the version callback runs after it is released, so a probe it starts does not wait on itself.
   */
  async #checkVersion(): Promise<void> {
    if (this.#versionCheck !== null) return this.#versionCheck
    const detection = this.#detectVersionChange()
    this.#versionCheck = detection.then(() => undefined)
    let changed: { readonly version: string | null } | null
    try {
      changed = await detection
    } finally {
      this.#versionCheck = null
    }
    if (changed !== null) await this.#options.onVersionChange?.(changed.version)
  }

  async #detectVersionChange(): Promise<{ readonly version: string | null } | null> {
    const stamp = await this.#options.fs.watchHint(this.#packageJson)
    if (this.#stamp !== undefined && sameStamp(stamp, this.#stamp)) return null
    const firstLook = this.#stamp === undefined
    this.#stamp = stamp
    const version = stamp === null ? null : await this.#readVersion(stamp.size)
    if (firstLook || version === this.#version) {
      this.#version = version
      return null
    }
    this.#version = version
    await this.#process.restart()
    return { version }
  }

  async #readVersion(size: number): Promise<string | null> {
    const bytes = await this.#options.fs.readFileRange(this.#packageJson, 0, size)
    const manifest: unknown = JSON.parse(new TextDecoder().decode(bytes))
    return isRecord(manifest) && typeof manifest.version === "string" ? manifest.version : null
  }
}

type Answer = GatewayAck | GatewayResult<unknown>

function sameStamp(left: WatchStamp | null, right: WatchStamp | null): boolean {
  if (left === null || right === null) return left === right
  return left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs
}
