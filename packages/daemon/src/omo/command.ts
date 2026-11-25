import type { Clock } from "../core/ports"
import type { Ms } from "../core/types"

export interface CommandSpec {
  readonly cmd: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly timeoutMs: Ms
}

export interface CommandResult {
  /** `null` when the process could not start or was killed at the deadline. */
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

/** Runs one command to completion; the deadline is a Clock timer that kills the process. */
export async function runCommand(spec: CommandSpec, clock: Clock): Promise<CommandResult> {
  let proc: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">>
  try {
    proc = Bun.spawn([...spec.cmd], { cwd: spec.cwd, env: { ...spec.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  } catch (error) {
    return { exitCode: null, stdout: "", stderr: error instanceof Error ? error.message : String(error), timedOut: false }
  }
  let timedOut = false
  const deadline = clock.setTimer(clock.now() + spec.timeoutMs, () => {
    timedOut = true
    proc.kill("SIGKILL")
  })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  clock.clearTimer(deadline)
  return { exitCode: timedOut ? null : exitCode, stdout, stderr, timedOut }
}

export function tail(text: string, max = 500): string {
  const trimmed = text.trim()
  return trimmed.length <= max ? trimmed : trimmed.slice(-max)
}
