import { mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig, type LoadConfigOptions, type LoadedConfig } from "../../src/config"
import { SeededRng } from "../support/fakes"

export interface TempHome {
  readonly home: string
  writeConfig(text: string): Promise<void>
}

const createdHomes: string[] = []

export async function tempHome(): Promise<TempHome> {
  const home = await mkdtemp(join(tmpdir(), "omo-daemonic-config-"))
  createdHomes.push(home)
  return {
    home,
    writeConfig: async (text: string) => {
      await writeFile(join(home, "config.jsonc"), text)
    },
  }
}

export async function cleanupTempHomes(): Promise<void> {
  const homes = createdHomes.splice(0)
  await Promise.all(homes.map((home) => rm(home, { recursive: true, force: true })))
}

export const TEST_HOME_DIR = "/Users/tester"

export const TEST_OMO = { bin: "/opt/omo/bin/omo", pluginRoot: "/opt/omo-ai/plugin" } as const

export function loadOptions(
  home: string,
  overrides: Partial<LoadConfigOptions> = {},
): LoadConfigOptions {
  return {
    home,
    homeDir: TEST_HOME_DIR,
    rng: new SeededRng(7),
    resolveOmo: () => TEST_OMO,
    ...overrides,
  }
}

export async function load(
  home: string,
  overrides: Partial<LoadConfigOptions> = {},
): Promise<LoadedConfig> {
  return loadConfig(loadOptions(home, overrides))
}

export async function captureError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run()
    return null
  } catch (error) {
    return error
  }
}

export async function modeOf(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777
}
