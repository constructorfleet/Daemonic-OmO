import { join } from "node:path"

import type { Clock, GatewayResult, TimerHandle } from "../core/ports"
import type { Ms } from "../core/types"
import { tail } from "./command"
import { refusal, refusalOf } from "./decode"
import type { BridgeChildConfig, BridgeCompletion, BridgeEvent, BridgeHello, BridgeMethod, BridgeReply } from "./protocol"
import type { BridgeRuntime } from "./runtime"

export interface Backoff {
  readonly initialMs: Ms
  readonly factor: number
  readonly maxMs: Ms
}

export const BRIDGE_BACKOFF_DEFAULTS: Backoff = { initialMs: 500, factor: 2, maxMs: 30_000 }
/** How long a retired child may take to dispose its SDK after stdin closes before it is killed. */
export const BRIDGE_STOP_GRACE_MS: Ms = 10_000

const BRIDGE_CHILD = join(import.meta.dir, "bridge-child.ts")

export interface BridgeProcessOptions {
  readonly config: BridgeChildConfig
  readonly env: Readonly<Record<string, string>>
  readonly runtime: BridgeRuntime | null
  readonly clock: Clock
  readonly backoff: Backoff
  readonly onCompletion: (event: BridgeCompletion) => void
}

type Proc = ReturnType<typeof Bun.spawn<"pipe", "pipe", "pipe">>

/** One spawned bridge child: its stdio framing, hello, in-flight requests and stderr tail. */
class Child {
  readonly pending = new Map<number, (result: GatewayResult<unknown>) => void>()
  readonly hello: Promise<BridgeHello | null>
  retiring = false
  stderr = ""
  #resolveHello: (hello: BridgeHello | null) => void = () => {}
  #nextId = 1

  constructor(readonly proc: Proc, onEvent: (event: BridgeEvent) => void) {
    this.hello = new Promise((resolve) => (this.#resolveHello = resolve))
    void this.#readLines(onEvent)
    void this.#readStderr()
  }

  send(method: BridgeMethod, args: unknown): { readonly id: number; readonly answer: Promise<GatewayResult<unknown>> } {
    const id = this.#nextId++
    const answer = new Promise<GatewayResult<unknown>>((resolve) => this.pending.set(id, resolve))
    try {
      this.proc.stdin.write(`${JSON.stringify({ id, method, args })}\n`)
      this.proc.stdin.flush()
    } catch {
      // The child is gone; its exit handler answers this request with bridge_restarted.
    }
    return { id, answer }
  }

  exited(why: string): void {
    this.#resolveHello(null)
    for (const resolve of this.pending.values()) resolve(refusal("bridge_restarted", why))
    this.pending.clear()
  }

  async #readLines(onEvent: (event: BridgeEvent) => void): Promise<void> {
    const decoder = new TextDecoder()
    let buffer = ""
    for await (const chunk of this.proc.stdout) {
      buffer += decoder.decode(chunk, { stream: true })
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line.trim().length > 0) this.#dispatch(JSON.parse(line) as BridgeEvent | BridgeReply, onEvent)
      }
    }
  }

  #dispatch(message: BridgeEvent | BridgeReply, onEvent: (event: BridgeEvent) => void): void {
    if ("event" in message) {
      if (message.event === "hello") this.#resolveHello(message)
      else onEvent(message)
      return
    }
    const resolve = this.pending.get(message.id)
    this.pending.delete(message.id)
    if (resolve === undefined) return
    if ("error" in message) resolve(refusalOf({ kind: "error", error: message.error }) ?? refusal("internal", message.error.message))
    else resolve({ kind: "ok", value: message.result })
  }

  async #readStderr(): Promise<void> {
    const decoder = new TextDecoder()
    for await (const chunk of this.proc.stderr) this.stderr = tail(this.stderr + decoder.decode(chunk, { stream: true }), 2000)
  }
}

type Phase =
  | { readonly kind: "idle" }
  | { readonly kind: "starting"; readonly child: Child; readonly ready: Promise<void> }
  | { readonly kind: "live"; readonly child: Child; readonly hello: Extract<BridgeHello, { sdk: "ok" }> }
  | { readonly kind: "degraded"; readonly detail: string }
  | { readonly kind: "backoff"; readonly timer: TimerHandle; readonly ready: Promise<void> }
  | { readonly kind: "stopped" }

/**
 * Supervises the bridge child of one agent dir: lazy first spawn, restart with backoff after an unexpected exit
 * (in-flight requests answer `bridge_restarted`), graceful retire on version change or stop, and degraded mode
 * when the child reports the SDK cannot load. Request deadlines run on the injected Clock.
 */
export class BridgeProcess {
  readonly #options: BridgeProcessOptions
  #phase: Phase = { kind: "idle" }
  #delay: Ms

  constructor(options: BridgeProcessOptions) {
    this.#options = options
    this.#delay = options.backoff.initialMs
  }

  get pid(): number | null {
    return this.#phase.kind === "live" ? this.#phase.child.proc.pid : null
  }

  get degraded(): boolean {
    return this.#phase.kind === "degraded"
  }

  get capabilities(): readonly string[] {
    return this.#phase.kind === "live" ? this.#phase.hello.methods : []
  }

  /** Spawns if needed and answers the live child's hello, or the degraded detail. */
  async hello(): Promise<Extract<BridgeHello, { sdk: "ok" }> | string> {
    for (;;) {
      const phase = this.#phase
      switch (phase.kind) {
        case "idle":
          this.#spawn()
          break
        case "starting":
        case "backoff":
          await phase.ready
          break
        case "live":
          return phase.hello
        case "degraded":
          return phase.detail
        case "stopped":
          return "sdk_unavailable: bridge stopped"
        default:
          return assertNever(phase)
      }
    }
  }

  request(method: BridgeMethod, args: unknown, timeoutMs: Ms): Promise<GatewayResult<unknown>> {
    const { clock } = this.#options
    return new Promise((resolve) => {
      let forget = (): void => {}
      let timedOut = false
      const timer = clock.setTimer(clock.now() + timeoutMs, () => {
        timedOut = true
        forget()
        resolve(refusal("bridge_timeout", `bridge ${method} gave no answer within ${timeoutMs} ms`))
      })
      const finish = (result: GatewayResult<unknown>): void => {
        clock.clearTimer(timer)
        resolve(result)
      }
      void this.hello().then((hello) => {
        if (timedOut) return
        if (typeof hello === "string") return finish(refusal("gateway_degraded", hello))
        if (this.#phase.kind !== "live") return finish(refusal("bridge_restarted", "bridge restarted before the request was sent"))
        const { child } = this.#phase
        const sent = child.send(method, args)
        forget = () => child.pending.delete(sent.id)
        void sent.answer.then((result) => {
          if (result.kind === "ok") this.#delay = this.#options.backoff.initialMs
          finish(result)
        })
      })
    })
  }

  /** Retires the current child (its SDK is disposed) so the next request spawns a fresh one; clears degraded mode. */
  async restart(): Promise<void> {
    await this.#retire({ kind: "idle" })
    this.#delay = this.#options.backoff.initialMs
  }

  async stop(): Promise<void> {
    await this.#retire({ kind: "stopped" })
  }

  async #retire(next: Phase): Promise<void> {
    const phase = this.#phase
    this.#phase = next
    if (phase.kind === "backoff") this.#options.clock.clearTimer(phase.timer)
    if (phase.kind !== "live" && phase.kind !== "starting") return
    const { child } = phase
    child.retiring = true
    const { clock } = this.#options
    const kill = clock.setTimer(clock.now() + BRIDGE_STOP_GRACE_MS, () => child.proc.kill("SIGKILL"))
    try {
      child.proc.stdin.end()
    } catch {
      // stdin is already closed because the child is exiting; awaiting `exited` below covers it.
    }
    await child.proc.exited
    clock.clearTimer(kill)
  }

  #spawn(): void {
    const { runtime, config, env } = this.#options
    if (runtime === null) {
      this.#phase = { kind: "degraded", detail: "sdk_unavailable: no bun or node on the omo child PATH" }
      return
    }
    const proc = Bun.spawn([runtime.path, BRIDGE_CHILD, JSON.stringify(config)], { cwd: env.HOME ?? "/", env: { ...env }, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
    const child = new Child(proc, (event) => {
      if (event.event === "completion") this.#options.onCompletion(event)
    })
    const ready = child.hello.then((hello) => {
      if (this.#phase.kind !== "starting" || this.#phase.child !== child || hello === null) return
      if (hello.sdk === "ok") {
        this.#phase = { kind: "live", child, hello }
        return
      }
      child.retiring = true
      this.#phase = { kind: "degraded", detail: hello.detail }
    })
    this.#phase = { kind: "starting", child, ready }
    void proc.exited.then((code) => this.#onExit(child, code))
  }

  #onExit(child: Child, code: number | null): void {
    const phase = this.#phase
    const current = (phase.kind === "live" || phase.kind === "starting") && phase.child === child
    if (current && !child.retiring) this.#scheduleRespawn()
    child.exited(`bridge child exited with ${code}${child.stderr.length > 0 ? `: ${child.stderr}` : ""}`)
  }

  #scheduleRespawn(): void {
    const { clock, backoff } = this.#options
    const delay = this.#delay
    this.#delay = Math.min(delay * backoff.factor, backoff.maxMs)
    let fire = (): void => {}
    const ready = new Promise<void>((resolve) => (fire = resolve))
    const timer = clock.setTimer(clock.now() + delay, () => {
      if (this.#phase.kind === "backoff" && this.#phase.timer === timer) this.#spawn()
      fire()
    })
    this.#phase = { kind: "backoff", timer, ready }
  }
}

function assertNever(value: never): never {
  throw new Error(`unhandled bridge phase: ${JSON.stringify(value)}`)
}
