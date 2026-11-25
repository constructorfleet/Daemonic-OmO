import { accessSync, constants, mkdirSync, mkdtempSync } from "node:fs"
import { homedir, tmpdir, userInfo } from "node:os"
import { basename, delimiter, join } from "node:path"

import type { GatewayErrorCode, GatewayProbe } from "../../src/core/ports"
import type { SdkCall, SdkChildReply } from "./sdk-child"

const HOME = process.env.HOME ?? homedir()
const SDK_CHILD = join(import.meta.dir, "sdk-child.ts")
export const THREAD_PREFIX = "omo-daemonic-contract-"

export const CONTRACT = {
  live: process.env.OMO_CONTRACT === "1",
  spend: process.env.OMO_CONTRACT === "1" && process.env.OMO_CONTRACT_SPEND === "1",
  model: process.env.OMO_CONTRACT_MODEL ?? "zai/glm-5.3-flash",
  providerEnv: (process.env.OMO_CONTRACT_PROVIDER_ENV ?? "ZAI_API_KEY").split(",").map((name) => name.trim()).filter((name) => name.length > 0),
  pluginRoot: process.env.OMO_CONTRACT_PLUGIN_ROOT ?? join(HOME, ".bun", "install", "global", "node_modules", "omo-ai", "plugin"),
  omoBin: process.env.OMO_CONTRACT_OMO_BIN ?? "omo",
} as const

export class ContractError extends Error {
  constructor(message: string, readonly detail: unknown = null) {
    super(detail === null ? message : `${message}: ${JSON.stringify(detail).slice(0, 2000)}`)
    this.name = "ContractError"
  }
}

export interface BridgeRuntime {
  readonly path: string
  readonly kind: "bun" | "node"
}

export interface ExecResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export interface OmoResult extends ExecResult {
  readonly json: unknown
}

export type ThreadRow = Readonly<Record<string, unknown>> & { readonly thread: string; readonly name: string; readonly state: string }

export interface ContractContext {
  readonly root: string
  readonly agentDir: string
  readonly project: string
  readonly other: string
  readonly worktree: string
  readonly env: Readonly<Record<string, string>>
  readonly runtime: BridgeRuntime
  readonly daemonRun: Readonly<Record<string, unknown>>
  readonly model: { readonly model?: string }
  /** Idempotency keys are run-unique: omo derives the thread id from the key alone, across agent dirs. */
  key(suffix: string): string
  track(result: unknown): { readonly thread: string }
  threadNamed(name: string): string | undefined
}

/** The env every omo child gets: no private Bun on PATH, no BUN_INSTALL, provider keys only when spend is on. */
export function omoChildEnv(agentDir: string | null): Record<string, string> {
  const path = (process.env.PATH ?? "").split(delimiter).filter((entry) => !entry.includes("/.omo-daemonic/runtime/"))
  const providers = CONTRACT.spend ? CONTRACT.providerEnv.flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name] ?? ""]])) : []
  return {
    HOME,
    USER: process.env.USER ?? userInfo().username,
    LANG: process.env.LANG ?? "en_US.UTF-8",
    TMPDIR: tmpdir(),
    PATH: path.join(delimiter),
    ...Object.fromEntries(providers),
    ...(agentDir === null ? {} : { OMO_CODING_AGENT_DIR: agentDir }),
  }
}

/** omo's launcher order (bin/omo.js:2): $BUN_INSTALL/bin/bun, ~/.bun/bin/bun, bun on PATH, then node. */
export function selectBridgeRuntime(env: Readonly<Record<string, string>>): BridgeRuntime {
  for (const candidate of [join(env.BUN_INSTALL ?? join(env.HOME ?? HOME, ".bun"), "bin", "bun"), join(env.HOME ?? HOME, ".bun", "bin", "bun")]) {
    if (isExecutable(candidate)) return { path: candidate, kind: "bun" }
  }
  const bun = Bun.which("bun", { PATH: env.PATH ?? "" })
  if (bun !== null) return { path: bun, kind: "bun" }
  const node = Bun.which("node", { PATH: env.PATH ?? "" })
  if (node !== null) return { path: node, kind: "node" }
  throw new ContractError("no bun or node on the omo child PATH")
}

export async function exec(cmd: readonly string[], options: { readonly cwd: string; readonly env: Readonly<Record<string, string>> }): Promise<ExecResult> {
  const proc = Bun.spawn([...cmd], { cwd: options.cwd, env: { ...options.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { exitCode, stdout, stderr }
}

export async function omo(ctx: ContractContext, args: readonly string[], cwd: string, options: { readonly realAgentDir?: boolean } = {}): Promise<OmoResult> {
  const env = options.realAgentDir === true ? omoChildEnv(null) : ctx.env
  const result = await exec([CONTRACT.omoBin, ...args], { cwd, env })
  return { ...result, json: parseJson(result.stdout) }
}

export async function sdk(ctx: ContractContext, calls: readonly SdkCall[], cwd: string, options: { readonly runtime?: string; readonly pluginRoot?: string } = {}): Promise<SdkChildReply> {
  const request = { pluginRoot: options.pluginRoot ?? CONTRACT.pluginRoot, agentDir: ctx.agentDir, cwd, calls }
  const result = await exec([options.runtime ?? ctx.runtime.path, SDK_CHILD, JSON.stringify(request)], { cwd, env: ctx.env })
  const reply = parseJson(result.stdout.trim().split("\n").at(-1) ?? "")
  if (!isRecord(reply) || (reply.kind !== "ok" && reply.kind !== "load_error")) {
    throw new ContractError("sdk child gave no reply", { exitCode: result.exitCode, stderr: result.stderr.slice(-1500) })
  }
  return reply as SdkChildReply
}

export function sdkOk(reply: SdkChildReply): Extract<SdkChildReply, { kind: "ok" }> {
  if (reply.kind !== "ok") throw new ContractError("thread SDK failed to load", reply)
  return reply
}

export async function probeThreadSdk(ctx: ContractContext, pluginRoot: string): Promise<GatewayProbe> {
  const unavailable: GatewayErrorCode = "sdk_unavailable"
  try {
    const reply = await sdk(ctx, [], ctx.project, { pluginRoot })
    if (reply.kind === "load_error") return { sdkLoad: "fail", presetNames: [], version: null, detail: `${unavailable}: ${reply.message}` }
    const manifest: unknown = await Bun.file(join(pluginRoot, "..", "package.json")).json()
    return { sdkLoad: "ok", presetNames: [], version: isRecord(manifest) && typeof manifest.version === "string" ? manifest.version : null, detail: reply.runtime }
  } catch (error) {
    return { sdkLoad: "fail", presetNames: [], version: null, detail: `${unavailable}: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/** `omo thread list --json` documents an array but 5.1.79 prints `{kind:"ok", threads}`; both are accepted. */
export function parseThreadList(value: unknown): readonly ThreadRow[] {
  const rows = Array.isArray(value) ? value : isRecord(value) && value.kind === "ok" && Array.isArray(value.threads) ? value.threads : null
  if (rows === null) throw new ContractError("unrecognized thread list shape", value)
  return rows.filter((row): row is ThreadRow => isRecord(row) && typeof row.thread === "string" && typeof row.name === "string" && typeof row.state === "string")
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM"
  }
}

export async function startContract(): Promise<ContractContext> {
  const root = mkdtempSync(join(tmpdir(), "omo-contract-"))
  const agentDir = join(root, "agent")
  mkdirSync(agentDir)
  const gitEnv = { ...omoChildEnv(null), GIT_CONFIG_NOSYSTEM: "1" }
  const project = await gitRepo(join(root, "project"), gitEnv)
  const other = await gitRepo(join(root, "other"), gitEnv)
  const worktree = join(root, "worktrees", "wt1")
  await must(["git", "-C", project, "worktree", "add", "-q", "-b", "omo-daemonic/contract-wt", worktree, "HEAD"], root, gitEnv)
  const env = omoChildEnv(agentDir)
  const daemon = await exec([CONTRACT.omoBin, "daemon", "run", "--json"], { cwd: project, env })
  const daemonRun = parseJson(daemon.stdout)
  if (daemon.exitCode !== 0 || !isRecord(daemonRun)) throw new ContractError("omo daemon run --json failed in the temp agent dir", daemon)
  const named = new Map<string, string>()
  return {
    root, agentDir, project, other, worktree, env, daemonRun,
    runtime: selectBridgeRuntime(env),
    model: CONTRACT.spend ? { model: CONTRACT.model } : {},
    key: (suffix) => `odc-${basename(root)}-${suffix}`,
    track(result) {
      if (!isRecord(result) || result.kind !== "ok" || typeof result.thread !== "string" || typeof result.name !== "string") throw new ContractError("create did not answer ok", result)
      named.set(result.name, result.thread)
      return { thread: result.thread }
    },
    threadNamed: (name) => named.get(name),
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

async function gitRepo(dir: string, env: Readonly<Record<string, string>>): Promise<string> {
  mkdirSync(dir, { recursive: true })
  await must(["git", "init", "-q", "-b", "main"], dir, env)
  await must(["git", "-c", "user.name=omo-daemonic-contract", "-c", "user.email=contract@invalid", "commit", "-q", "--allow-empty", "-m", "init"], dir, env)
  return dir
}

async function must(cmd: readonly string[], cwd: string, env: Readonly<Record<string, string>>): Promise<void> {
  const result = await exec(cmd, { cwd, env })
  if (result.exitCode !== 0) throw new ContractError(`${cmd.join(" ")} failed`, result)
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}
