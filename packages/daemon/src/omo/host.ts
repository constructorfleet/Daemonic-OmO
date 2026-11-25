import type { Env } from "../config/types"
import type {
  Clock,
  EnsureHostOutcome,
  GatewayErrorCode,
  GatewayResult,
  HostSessionState,
  ReleaseHoldOutcome,
} from "../core/ports"
import type { Ms, ThreadId } from "../core/types"
import { runCommand, tail, type CommandResult } from "./command"
import { isRecord, refusal } from "./decode"
import { omoChildEnv } from "./runtime"

export const OMO_COMMAND_TIMEOUT_MS: Ms = 120_000

/** `omo thread` exit 3 means `host_unavailable`; the host commands follow the same table. */
const EXIT_HOST_UNAVAILABLE = 3

export interface OmoCliOptions {
  readonly bin: string
  readonly agentDir: string
  readonly baseEnv: Env
  readonly clock: Clock
  readonly timeoutMs?: Ms
}

export interface ScheduleListing {
  readonly jobs: number
  readonly invalid: number
}

/**
 * The only omo CLI calls the daemon makes, each with the allowlisted env of one agent dir: host ensure
 * (`omo daemon run --json --pinned`), unattended-hold recovery (`omo host session state|prompt`) and the
 * read-only probe calls. Never `omo host status --all` (an 8-9 s diagnostic pass).
 */
export class OmoCli {
  readonly #options: OmoCliOptions
  readonly #env: Readonly<Record<string, string>>

  constructor(options: OmoCliOptions) {
    this.#options = options
    this.#env = omoChildEnv(options.baseEnv, options.agentDir)
  }

  get agentDir(): string {
    return this.#options.agentDir
  }

  async ensureHost(): Promise<GatewayResult<EnsureHostOutcome>> {
    const result = await this.#run(["daemon", "run", "--json", "--pinned"])
    const answer = parseJson(result.stdout)
    if (result.exitCode !== 0 || !isRecord(answer) || typeof answer.action !== "string") {
      return refusal("host_unavailable", `omo daemon run exited ${result.exitCode}: ${tail(result.stderr || result.stdout)}`)
    }
    return { kind: "ok", value: { started: answer.action === "start", pid: typeof answer.pid === "number" ? answer.pid : null } }
  }

  async sessionState(thread: ThreadId): Promise<GatewayResult<HostSessionState>> {
    const result = await this.#run(["host", "session", "state", thread, "--json"])
    const failed = commandRefusal(result, "omo host session state")
    if (failed !== null) return failed
    const answer = parseJson(result.stdout)
    const state = isRecord(answer) && isRecord(answer.state) ? answer.state : null
    if (state === null) return refusal("internal", `unrecognized host session state answer: ${tail(result.stdout)}`)
    const holds = Array.isArray(state.holds) ? state.holds.flatMap((hold) => (isRecord(hold) && typeof hold.kind === "string" ? [hold.kind] : [])) : []
    const lifecycle = isRecord(state.lifecycle) && typeof state.lifecycle.state === "string" ? state.lifecycle.state : null
    return { kind: "ok", value: { thread, held: holds.includes("unattended"), paused: state.paused === true, holds, lifecycle } }
  }

  async releaseHold(thread: ThreadId, text: string): Promise<GatewayResult<ReleaseHoldOutcome>> {
    const result = await this.#run(["host", "session", "prompt", thread, text])
    const failed = commandRefusal(result, "omo host session prompt")
    if (failed !== null) return failed
    const answer = parseJson(result.stdout)
    if (!isRecord(answer) || typeof answer.disposition !== "string") {
      return refusal("internal", `unrecognized host session prompt answer: ${tail(result.stdout)}`)
    }
    return { kind: "ok", value: { disposition: answer.disposition } }
  }

  /** `omo --version` prints `omo <semver> (engine: ...)`; answers the semver or the failure. */
  async version(): Promise<{ readonly version: string | null; readonly detail: string }> {
    const result = await this.#run(["--version"])
    const line = result.stdout.trim()
    const version = /^omo (\S+)/.exec(line)?.[1] ?? null
    return { version: result.exitCode === 0 ? version : null, detail: result.exitCode === 0 ? line : `exit ${result.exitCode}: ${tail(result.stderr)}` }
  }

  async scheduleList(): Promise<GatewayResult<ScheduleListing>> {
    const result = await this.#run(["schedule", "list", "--json"])
    const failed = commandRefusal(result, "omo schedule list")
    if (failed !== null) return failed
    const answer = parseJson(result.stdout)
    if (!isRecord(answer) || !Array.isArray(answer.jobs) || !Array.isArray(answer.invalid)) {
      return refusal("internal", `unrecognized schedule list answer: ${tail(result.stdout)}`)
    }
    return { kind: "ok", value: { jobs: answer.jobs.length, invalid: answer.invalid.length } }
  }

  #run(args: readonly string[]): Promise<CommandResult> {
    const timeoutMs = this.#options.timeoutMs ?? OMO_COMMAND_TIMEOUT_MS
    return runCommand({ cmd: [this.#options.bin, ...args], cwd: this.#env.HOME ?? "/", env: this.#env, timeoutMs }, this.#options.clock)
  }
}

function commandRefusal(result: CommandResult, label: string): GatewayResult<never> | null {
  if (result.exitCode === 0) return null
  const code: GatewayErrorCode = result.exitCode === EXIT_HOST_UNAVAILABLE ? "host_unavailable" : "internal"
  const why = result.timedOut ? "timed out" : `exited ${result.exitCode}`
  return refusal(code, `${label} ${why}: ${tail(result.stderr || result.stdout)}`)
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
