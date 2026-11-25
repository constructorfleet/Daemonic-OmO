import { watch } from "node:fs"
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { Env } from "../../src/config/types"
import type { GatewayResult } from "../../src/core/ports"
import { BridgeClient, type BridgeClientOptions } from "../../src/omo/bridge-client"
import { FakeClock, FakeFs } from "../support/fakes"

export const STUB_OMO = join(import.meta.dir, "fixtures", "stub-omo")
const STUB_SDK = join(import.meta.dir, "fixtures", "stub-sdk.js")
export const OMO_FIXTURES = join(import.meta.dir, "..", "fixtures", "omo")

/** Values a leaky child env would carry: none of them may reach an omo child process. */
export const PARENT_ENV: Env = {
  ...process.env,
  BUN_INSTALL: "/leak/bun-install",
  OMO_DAEMONIC_SESSION_KEY: "leaked-session-key",
  OMO_DAEMONIC_BREAKGLASS: "leaked-breakglass",
  PATH: `${process.env.HOME}/.omo-daemonic/runtime/bun-1.4.4:${process.env.PATH ?? ""}`,
}

/** A temp omo-ai install (`<root>/omo-ai/{package.json,plugin/runtime/thread-sdk/sdk.js}`) and agent dir. */
export interface StubInstall {
  readonly root: string
  readonly agentDir: string
  readonly pluginRoot: string
  readonly fs: FakeFs
  file(name: string): string
  read(name: string): Promise<string>
  touch(name: string, content?: string): Promise<void>
  setVersion(version: string): Promise<void>
  dispose(): Promise<void>
}

export async function stubInstall(): Promise<StubInstall> {
  const root = await mkdtemp(join(tmpdir(), "omo-bridge-"))
  const agentDir = join(root, "agent")
  const pluginRoot = join(root, "omo-ai", "plugin")
  try {
    await mkdir(agentDir, { recursive: true })
    await mkdir(join(pluginRoot, "runtime", "thread-sdk"), { recursive: true })
    await copyFile(STUB_SDK, join(pluginRoot, "runtime", "thread-sdk", "sdk.js"))
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
  const install: StubInstall = {
    root,
    agentDir,
    pluginRoot,
    fs: new FakeFs(root),
    file: (name) => join(agentDir, name),
    read: (name) => readFile(join(agentDir, name), "utf8"),
    touch: (name, content = "") => writeFile(join(agentDir, name), content),
    setVersion: (version) => writeFile(join(root, "omo-ai", "package.json"), JSON.stringify({ name: "omo-ai", version })),
    dispose: () => rm(root, { recursive: true, force: true }),
  }
  await install.setVersion("5.1.79")
  return install
}

export function bridgeClient(
  install: StubInstall,
  clock: FakeClock,
  overrides: Partial<BridgeClientOptions> = {},
): BridgeClient {
  return new BridgeClient({
    agentDir: install.agentDir,
    omo: { bin: STUB_OMO, pluginRoot: install.pluginRoot },
    clock,
    fs: install.fs,
    baseEnv: PARENT_ENV,
    ...overrides,
  })
}

/** Resolves once `name` under the agent dir contains `needle`; subscribes before the first read. */
export function fileContains(install: StubInstall, name: string, needle: string): Promise<void> {
  return new Promise((resolve) => {
    const watcher = watch(install.agentDir, () => void check())
    const check = async (): Promise<void> => {
      const text = await readFile(install.file(name), "utf8").catch(() => "")
      if (!text.includes(needle)) return
      watcher.close()
      resolve()
    }
    void check()
  })
}

export function value<T>(result: GatewayResult<T>): T {
  if (result.kind !== "ok") throw new Error(`expected ok, got ${result.code}: ${result.message}`)
  return result.value
}

export async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(join(OMO_FIXTURES, `${name}.json`), "utf8"))
}
