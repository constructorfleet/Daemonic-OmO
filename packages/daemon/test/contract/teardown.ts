import { existsSync, readFileSync, readdirSync, rmSync, rmdirSync } from "node:fs"
import { dirname, join } from "node:path"

import { ContractError, THREAD_PREFIX, exec, isRecord, omo, parseThreadList, sdk, sdkOk, type ContractContext } from "./harness"

/**
 * Closes every open thread of the temp agent dir, stops every endpoint it owns (operator and
 * per-session hosts) and lets `omo daemon gc` drop their state, then proves nothing still runs
 * from the temp root, no endpoint sidecar names it and the real agent dir lists no contract
 * thread before deleting the root. Any failed step throws.
 */
export async function stopContract(ctx: ContractContext | undefined): Promise<void> {
  if (ctx === undefined) return
  const open = parseThreadList((await omo(ctx, ["thread", "list", "--json", "--all-scope"], ctx.project)).json).filter((row) => row.state !== "inactive" && row.state !== "archived")
  if (open.length > 0) {
    const closed = sdkOk(await sdk(ctx, open.map((row) => ({ method: "close", args: { thread: row.thread, force: true, all_scope: true } })), ctx.project)).results
    const failed = closed.filter((result) => !isRecord(result) || result.kind !== "ok")
    if (failed.length > 0) throw new ContractError("teardown could not close every thread", failed)
  }

  const sidecarDirs = await ownedSidecarDirs(ctx)
  const stop = await omo(ctx, ["daemon", "stop", "--drain", "--all", "--wait", "--timeout", "60"], ctx.project)
  if (stop.exitCode !== 0) throw new ContractError("omo daemon stop --drain --all failed for the temp agent dir", stop)
  const gc = await omo(ctx, ["daemon", "gc", "--json"], ctx.project)
  if (gc.exitCode !== 0) throw new ContractError("omo daemon gc failed for the temp agent dir", gc)
  const leftovers = (await processLines()).filter((line) => line.includes(ctx.root))
  if (leftovers.length > 0) throw new ContractError("processes still run from the temp root", leftovers)
  const staleSidecars = sidecarDirs.flatMap((dir) => sidecarsNaming(dir, ctx.root))
  if (staleSidecars.length > 0) throw new ContractError("endpoint sidecars still name the temp root", staleSidecars)
  const emptiedDirs = sidecarDirs.filter((dir) => existsSync(dir) && readdirSync(dir).length === 0)
  for (const dir of emptiedDirs) rmdirSync(dir)

  const real = await omo(ctx, ["thread", "list", "--json", "--all-scope"], ctx.project, { realAgentDir: true })
  const leaked = parseThreadList(real.json).filter((row) => row.name.startsWith(THREAD_PREFIX))
  if (leaked.length > 0) throw new ContractError("the real agent dir lists contract threads", leaked)

  rmSync(ctx.root, { recursive: true, force: true })
  console.info(
    `contract teardown: closed ${open.length} open threads; daemon stop --all exit ${stop.exitCode}; daemon gc exit ${gc.exitCode}; ` +
      `${leftovers.length} processes under the temp root; ${staleSidecars.length} sidecars name it; removed ${emptiedDirs.length} emptied sidecar dirs; ` +
      `real agent dir lists ${leaked.length} ${THREAD_PREFIX} threads; removed ${ctx.root}`,
  )
}

/** `stop --all` must only ever reach endpoints this temp agent dir started; returns their sidecar dirs outside the root. */
async function ownedSidecarDirs(ctx: ContractContext): Promise<readonly string[]> {
  const status = await omo(ctx, ["daemon", "status", "--json"], ctx.project)
  const endpoints = isRecord(status.json) && Array.isArray(status.json.endpoints) ? status.json.endpoints.filter(isRecord) : []
  const lines = await processLines()
  const foreign = endpoints.filter((endpoint) => {
    if (typeof endpoint.pid !== "number") return false
    const socketOwned = typeof endpoint.socket === "string" && endpoint.socket.startsWith(ctx.root)
    return !socketOwned && !lines.some((line) => line.trimStart().startsWith(`${endpoint.pid} `) && line.includes(ctx.root))
  })
  if (foreign.length > 0) throw new ContractError("temp agent dir status lists endpoints it does not own", foreign)
  const sockets = endpoints.map((endpoint) => endpoint.socket).filter((socket): socket is string => typeof socket === "string" && !socket.startsWith(ctx.root))
  return [...new Set(sockets.map((socket) => dirname(socket)))]
}

function sidecarsNaming(dir: string, root: string): readonly string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((file) => file.endsWith(".meta.json"))
    .map((file) => join(dir, file))
    .filter((path) => readFileSync(path, "utf8").includes(root))
}

async function processLines(): Promise<readonly string[]> {
  const ps = await exec(["ps", "-axo", "pid=,command="], { cwd: "/", env: { PATH: "/bin:/usr/bin" } })
  return ps.stdout.split("\n")
}
