import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Server } from "bun"

import { startServer } from "../../src/api/server"
import { createApp, type App } from "../../src/app"
import { loadConfig, systemRng } from "../../src/config"
import type { Clock, TimerHandle } from "../../src/core/ports"
import { BridgeClient } from "../../src/omo/bridge-client"
import { RUNS } from "../../src/runs/engine"
import { SseReader } from "../api/harness"
import { isRecord } from "../auth/harness"
import { CONTRACT, startContract, type ContractContext } from "../contract/harness"
import { stopContract } from "../contract/teardown"
import { FakeFs, FakeGit } from "../support/fakes"

const RUN_DEADLINE_MS = 150_000

/** Wall-clock timers for the live run only; unit tests drive the engine with FakeClock. */
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

interface RunFrame {
  readonly state: string
  readonly outcome: unknown
  readonly threadId: unknown
}

function runFrame(data: unknown, runId: string): RunFrame | null {
  if (!isRecord(data) || !isRecord(data.entity) || data.entity.kind !== "run" || data.entity.id !== runId || !isRecord(data.data)) return null
  const run = data.data
  return typeof run.state === "string" ? { state: run.state, outcome: run.outcome, threadId: run.threadId } : null
}

describe.skipIf(!CONTRACT.spend)("run engine against the installed omo (todo 15 QA, spends one turn)", () => {
  let ctx: ContractContext | undefined
  let client: BridgeClient | undefined
  let app: App | undefined
  let server: Server<undefined> | undefined
  let token = ""

  beforeAll(async () => {
    ctx = await startContract()
    const home = join(ctx.root, "daemon-home")
    const clock = systemClock()
    const fs = new FakeFs(ctx.root)
    client = new BridgeClient({ agentDir: ctx.agentDir, omo: { bin: CONTRACT.omoBin, pluginRoot: CONTRACT.pluginRoot }, clock, fs, baseEnv: process.env })
    server = startServer(async (request, bunServer) => {
      if (app === undefined) return new Response("starting", { status: 503 })
      return app.fetch(request, bunServer)
    }, { host: "127.0.0.1", port: 0 })
    await mkdir(home, { recursive: true })
    await writeFile(join(home, "config.jsonc"), JSON.stringify({
      listen: { host: "127.0.0.1", port: server.port },
      publicUrl: `http://127.0.0.1:${server.port}`,
      users: { bootstrapAdmin: { agentDir: ctx.agentDir } },
    }))
    const loaded = await loadConfig({ env: {}, home, homeDir: ctx.root, resolveOmo: () => ({ bin: CONTRACT.omoBin, pluginRoot: CONTRACT.pluginRoot }) })
    token = loaded.secrets.breakglassToken
    app = await createApp({ loaded, clock, rng: systemRng(), gateway: client, fs, git: new FakeGit(), staticDir: null })
  })

  afterAll(async () => {
    app?.ctx.services.get(RUNS)?.stop()
    app?.close()
    await server?.stop(true)
    await client?.stop()
    await stopContract(ctx)
  })

  test("a POSTed run in a temp git repo project goes active, then its turn settles succeeded on the stream", async () => {
    if (ctx === undefined || server === undefined) throw new Error("contract context missing")
    const base = `http://127.0.0.1:${server.port}/api/v1`
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" }
    const project = await fetch(`${base}/projects`, { method: "POST", headers, body: JSON.stringify({ cwd: ctx.project }) })
    expect(project.status).toBe(201)
    const projectBody: unknown = await project.json()
    if (!isRecord(projectBody) || typeof projectBody.id !== "string") throw new Error("project create returned no id")

    const stream = await fetch(`${base}/stream`, { headers: { authorization: headers.authorization } })
    if (stream.body === null) throw new Error("stream has no body")
    const reader = new SseReader(stream.body)
    const posted = await fetch(`${base}/projects/${projectBody.id}/runs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ prompt: "Reply with exactly OK", model: CONTRACT.model }),
    })
    const run: unknown = await posted.json()
    console.info(`qa: POST run -> ${posted.status} ${JSON.stringify(run)}`)
    expect(posted.status).toBe(201)
    if (!isRecord(run) || typeof run.id !== "string") throw new Error("run create returned no id")
    const runId = run.id

    const states: string[] = []
    let last: RunFrame | null = null
    const deadline = setTimeout(() => void reader.cancel(), RUN_DEADLINE_MS)
    try {
      while (last === null || (last.state !== "kept" && last.state !== "closed")) {
        const frame = await reader.next()
        if (frame === null) throw new Error(`stream ended (or ${RUN_DEADLINE_MS} ms passed) after states ${states.join(" -> ")}`)
        const seen = runFrame(frame.data, runId)
        if (seen === null) continue
        last = seen
        if (states.at(-1) !== seen.state) states.push(seen.state)
        console.info(`qa: stream id=${frame.id} run state=${seen.state} outcome=${JSON.stringify(seen.outcome)} thread=${String(seen.threadId)}`)
      }
    } finally {
      clearTimeout(deadline)
      await reader.cancel()
    }

    expect(states).toContain("active")
    expect(last.outcome).toEqual({ kind: "succeeded" })
    console.info(`qa: states ${states.join(" -> ")}; final outcome ${JSON.stringify(last.outcome)}`)
  })
})
