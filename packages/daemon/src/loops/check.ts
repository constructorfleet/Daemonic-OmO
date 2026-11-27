import type { Clock } from "../core/ports"
import type { Ms } from "../core/types"
import { runCommand, type CommandResult } from "../omo/command"

export interface LoopCheckSpec {
  readonly command: readonly string[]
  readonly cwd: string
  readonly timeoutMs: Ms
}

export type LoopCheckRunner = (spec: LoopCheckSpec) => Promise<CommandResult>

const CHECK_ENV_KEYS = ["PATH", "HOME", "LANG", "TMPDIR"] as const

export function loopCheckEnvironment(base: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string>> {
  const env: Record<string, string> = {}
  for (const key of CHECK_ENV_KEYS) {
    const value = base[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

/** Executes checks outside the agent, with only the documented non-secret environment. */
export function createLoopCheckRunner(clock: Clock): LoopCheckRunner {
  return (spec) => {
    const env = loopCheckEnvironment(process.env)
    return runCommand({ cmd: spec.command, cwd: spec.cwd, env, timeoutMs: spec.timeoutMs }, clock)
  }
}
