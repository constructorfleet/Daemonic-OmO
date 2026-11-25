import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import type { Clock, GatewayResult, TimerHandle } from "../../src/core/ports"
import { BridgeClient } from "../../src/omo/bridge-client"
import { FakeFs } from "../support/fakes"
import { CONTRACT, omo, parseThreadList, startContract, THREAD_PREFIX, type ContractContext } from "./harness"
import { stopContract } from "./teardown"

/** Wall-clock timers for the live run only; unit tests drive the same client with FakeClock. */
function systemClock(): Clock {
  const timers = new Map<number, ReturnType<typeof setTimeout>>()
  let nextId = 1
  return {
    now: () => Date.now(),
    monotonicNow: () => performance.now(),
    setTimer(at: number, fn: () => void): TimerHandle {
      const id = nextId++
      timers.set(id, setTimeout(() => {
        timers.delete(id)
        fn()
      }, Math.max(0, at - Date.now())))
      return { id }
    },
    clearTimer(handle: TimerHandle): void {
      clearTimeout(timers.get(handle.id))
      timers.delete(handle.id)
    },
  }
}

function value<T>(result: GatewayResult<T>): T {
  if (result.kind !== "ok") throw new Error(`expected ok, got ${result.code}: ${result.message}`)
  return result.value
}

describe.skipIf(!CONTRACT.live)("omo gateway bridge against the installed omo (todo 12)", () => {
  let ctx: ContractContext | undefined
  let client: BridgeClient | undefined

  beforeAll(async () => {
    ctx = await startContract()
    client = new BridgeClient({
      agentDir: ctx.agentDir,
      omo: { bin: CONTRACT.omoBin, pluginRoot: CONTRACT.pluginRoot },
      clock: systemClock(),
      fs: new FakeFs(ctx.root),
      baseEnv: process.env,
    })
  })

  afterAll(async () => {
    await client?.stop()
    await stopContract(ctx)
  })

  test("ensures the pinned host, then creates, lists and closes exactly one thread through the bridge (no prompt)", async () => {
    if (ctx === undefined || client === undefined) throw new Error("contract context missing")
    const ensured = value(await client.ensureHost({ agentDir: ctx.agentDir }))
    expect(typeof ensured.pid).toBe("number")
    const probe = await client.probe()
    expect(probe.sdkLoad).toBe("ok")
    console.info(`bridge: ensureHost ${JSON.stringify(ensured)}; probe sdkLoad=${probe.sdkLoad} version=${probe.version} runtime=${probe.detail} pid=${client.pid}`)

    const name = `${THREAD_PREFIX}g12`
    const created = value(await client.create({ name, cwd: ctx.project, idempotencyKey: ctx.key("g12") }))
    expect(created.sessionId as string).toBe(created.thread)
    console.info(`bridge: create ${JSON.stringify(created)}`)

    const listed = value(await client.list())
    const row = listed.find((snapshot) => snapshot.thread === created.thread)
    expect(row).toMatchObject({ name, cwd: ctx.project })
    expect(["idle", "running"]).toContain(row?.state ?? "missing")
    const cli = parseThreadList((await omo(ctx, ["thread", "list", "--json", "--all-scope"], ctx.project)).json)
    expect(cli.map((thread) => thread.thread)).toContain(created.thread)
    console.info(`bridge: list ${listed.length} rows, row ${JSON.stringify(row)}; CLI list agrees`)

    const state = value(await client.sessionState(created.thread))
    console.info(`bridge: sessionState ${JSON.stringify(state)}`)

    const closed = value(await client.close({ thread: created.thread, graceful: true, waitMs: 30_000 }))
    expect(closed).toEqual({ closed: true, reason: "closed" })
    const after = value(await client.list()).find((snapshot) => snapshot.thread === created.thread)
    expect(after === undefined || after.state === "inactive").toBe(true)
    console.info(`bridge: close ${JSON.stringify(closed)}; after close ${JSON.stringify(after ?? null)}`)
  })
})
