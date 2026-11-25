import { chmod, mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { DEFAULT_HOME_DIR_NAME, CONFIG_FILE_NAME, type Env } from "./types"
import { expandTilde } from "./paths"

export interface HomeLayout {
  readonly home: string
  readonly configFile: string
  readonly databaseFile: string
  readonly runsDir: string
  readonly secretsDir: string
  readonly logsDir: string
}

export function resolveHome(env: Env, homeDir: string = homedir()): string {
  const override = env.OMO_DAEMONIC_HOME?.trim() ?? ""
  if (override.length > 0) return resolve(expandTilde(override, homeDir))
  return join(homeDir, DEFAULT_HOME_DIR_NAME)
}

export function homeLayout(home: string): HomeLayout {
  const root = resolve(home)
  return {
    home: root,
    configFile: join(root, CONFIG_FILE_NAME),
    databaseFile: join(root, "daemon.sqlite"),
    runsDir: join(root, "runs"),
    secretsDir: join(root, "secrets"),
    logsDir: join(root, "logs"),
  }
}

export async function ensureHome(home: string): Promise<HomeLayout> {
  const layout = homeLayout(home)
  for (const directory of [layout.home, layout.runsDir, layout.secretsDir, layout.logsDir]) {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
  }
  return layout
}
