// The bridge child: the only process that loads omo JS. One runs per agent dir, under the runtime omo's
// launcher would pick (FINDINGS assertion 1), with the allowlisted env the client built.
// Usage: <runtime> bridge-child.ts '<json BridgeChildConfig>'; requests on stdin, replies and events on stdout.
// Type-only imports keep it runnable under `node` (type stripping) as well as `bun`.
import { existsSync, watch, type FSWatcher } from "node:fs"
import { join } from "node:path"
import { createInterface } from "node:readline"

import type { BindCompletionRequest, BridgeChildConfig, BridgeEvent, BridgeReply, BridgeRequest } from "./protocol"

type SdkCall = (args: unknown) => Promise<unknown>
type ThreadSdk = Readonly<Record<string, unknown>> & { dispose(): Promise<void> }
interface ThreadSdkModule {
  createThreadSdk(options: { readonly agentDir: string; readonly cwd: string; readonly uid: number; readonly user: string }): ThreadSdk
}

const SDK_METHODS: ReadonlySet<string> = new Set(["create", "send", "read", "list", "locate", "interrupt", "close", "set_model", "rename"])
const runtime = typeof Bun === "undefined" ? `node ${process.version}` : `bun ${Bun.version}`
const config = JSON.parse(process.argv[2] ?? "{}") as BridgeChildConfig

function emit(message: BridgeEvent | BridgeReply): void {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

async function loadSdk(): Promise<ThreadSdk | string> {
  try {
    const mod = (await import(`${config.pluginRoot}/runtime/thread-sdk/sdk.js`)) as ThreadSdkModule
    return mod.createThreadSdk({ agentDir: config.agentDir, cwd: config.agentDir, uid: process.getuid?.() ?? 0, user: config.user })
  } catch (error) {
    return `sdk_unavailable: ${error instanceof Error ? error.message : String(error)}`
  }
}

/**
 * Completion arm (FINDINGS assertion 6): `bind` a custom outbound binding, then `report` arms it; when the turn
 * settles omo rewrites `<agentDir>/gateway/outbox.marker`, so watch that directory and read the outbox row.
 */
class CompletionWatch {
  readonly #pending = new Map<string, string>()
  readonly #sdk: ThreadSdk
  #watcher: FSWatcher | null = null

  constructor(sdk: ThreadSdk) {
    this.#sdk = sdk
  }

  async arm(request: BindCompletionRequest): Promise<unknown> {
    const bound = await this.#call("bind", {
      session: request.thread,
      binding: { platform: "custom", account_id: "omo-daemonic", chat_id: `odm-${request.thread}`, outbound_events: request.events, direction: { inbound: false, outbound: true } },
    })
    const bindingId = isRecord(bound) && isRecord(bound.binding) && typeof bound.binding.binding_id === "string" ? bound.binding.binding_id : null
    if (bindingId === null) return bound
    this.#pending.set(bindingId, request.thread)
    this.#ensureWatcher()
    const armed = await this.#call("report", { session: request.thread, kind: "completion", text: `${request.thread} settled`, binding_id: bindingId })
    if (!isRecord(armed) || armed.kind !== "ok") {
      this.#settle(bindingId)
      return armed
    }
    void this.#check(bindingId)
    return { kind: "ok", binding_id: bindingId, thread: request.thread, events: request.events }
  }

  close(): void {
    this.#watcher?.close()
    this.#watcher = null
  }

  #ensureWatcher(): void {
    if (this.#watcher !== null) return
    const gateway = join(config.agentDir, "gateway")
    this.#watcher = watch(existsSync(gateway) ? gateway : config.agentDir, () => {
      for (const bindingId of [...this.#pending.keys()]) void this.#check(bindingId)
    })
  }

  async #check(bindingId: string): Promise<void> {
    const thread = this.#pending.get(bindingId)
    if (thread === undefined) return
    const outbox = await this.#call("outbox", { binding_id: bindingId })
    const rows = isRecord(outbox) && Array.isArray(outbox.rows) ? outbox.rows : []
    const row = rows.find((candidate) => isRecord(candidate) && candidate.event === "completion" && typeof candidate.outcome === "string")
    if (!isRecord(row) || typeof row.outcome !== "string" || !this.#pending.has(bindingId)) return
    this.#settle(bindingId)
    emit({ event: "completion", bindingId, thread, outcome: row.outcome })
  }

  #settle(bindingId: string): void {
    this.#pending.delete(bindingId)
    if (this.#pending.size === 0) this.close()
  }

  #call(method: string, args: unknown): Promise<unknown> {
    return (this.#sdk[method] as SdkCall).call(this.#sdk, args)
  }
}

async function serve(sdk: ThreadSdk): Promise<void> {
  const completions = new CompletionWatch(sdk)
  for await (const line of createInterface({ input: process.stdin })) {
    const request = JSON.parse(line) as BridgeRequest
    void handle(sdk, completions, request).then(emit, (error: unknown) => {
      emit({ id: request.id, error: { code: "internal", message: error instanceof Error ? error.message : String(error) } })
    })
  }
  completions.close()
  await sdk.dispose()
  process.exit(0)
}

async function handle(sdk: ThreadSdk, completions: CompletionWatch, request: BridgeRequest): Promise<BridgeReply> {
  if (request.method === "bindCompletion") return { id: request.id, result: await completions.arm(request.args as BindCompletionRequest) }
  const method = sdk[request.method]
  if (!SDK_METHODS.has(request.method) || typeof method !== "function") {
    return { id: request.id, error: { code: "unsupported", message: `bridge: no SDK method ${request.method}` } }
  }
  return { id: request.id, result: await (method as SdkCall).call(sdk, request.args) }
}

const sdk = await loadSdk()
if (typeof sdk === "string") {
  emit({ event: "hello", sdk: "fail", runtime, pid: process.pid, detail: sdk })
} else {
  const methods = Object.keys(sdk).filter((key) => typeof sdk[key] === "function").sort()
  emit({ event: "hello", sdk: "ok", runtime, pid: process.pid, methods })
  process.once("SIGTERM", () => process.stdin.destroy())
  await serve(sdk)
}
