import { accessSync, constants } from "node:fs"
import { homedir, tmpdir, userInfo } from "node:os"
import { delimiter, join } from "node:path"

import type { Env } from "../config/types"

/** The only parent variables an omo child sees, plus `OMO_CODING_AGENT_DIR`. Never daemon secrets or `BUN_INSTALL`. */
export const OMO_CHILD_ENV_KEYS = ["PATH", "HOME", "USER", "LANG", "TMPDIR"] as const

const PRIVATE_RUNTIME_MARKER = "/.omo-daemonic/runtime/"

/**
 * Builds the environment of every omo child (bridge, `omo daemon run`, `omo host session ...`). PATH drops the
 * daemon's private Bun so omo's launcher never selects it, and gains `~/.bun/bin` and `/opt/homebrew/bin`, the
 * directories omo's own LaunchAgent uses.
 */
export function omoChildEnv(base: Env, agentDir: string): Readonly<Record<string, string>> {
  const home = base.HOME ?? homedir()
  const inherited = (base.PATH ?? "").split(delimiter).filter((entry) => entry.length > 0 && !entry.includes(PRIVATE_RUNTIME_MARKER))
  const path = [...new Set([...inherited, join(home, ".bun", "bin"), "/opt/homebrew/bin"])]
  return {
    PATH: path.join(delimiter),
    HOME: home,
    USER: base.USER ?? userInfo().username,
    LANG: base.LANG ?? "en_US.UTF-8",
    TMPDIR: base.TMPDIR ?? tmpdir(),
    OMO_CODING_AGENT_DIR: agentDir,
  }
}

export interface BridgeRuntime {
  readonly path: string
  readonly kind: "bun" | "node"
}

/**
 * omo's launcher order (`bin/omo.js`): `$BUN_INSTALL/bin/bun`, `~/.bun/bin/bun`, `bun` on PATH, then `node`.
 * `BUN_INSTALL` is never in the child env, so the first candidate is always `~/.bun/bin/bun`.
 */
export function selectBridgeRuntime(env: Readonly<Record<string, string>>): BridgeRuntime | null {
  const home = env.HOME ?? homedir()
  const bunHome = join(home, ".bun", "bin", "bun")
  if (isExecutable(bunHome)) return { path: bunHome, kind: "bun" }
  const bun = Bun.which("bun", { PATH: env.PATH ?? "" })
  if (bun !== null) return { path: bun, kind: "bun" }
  const node = Bun.which("node", { PATH: env.PATH ?? "" })
  return node === null ? null : { path: node, kind: "node" }
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}
