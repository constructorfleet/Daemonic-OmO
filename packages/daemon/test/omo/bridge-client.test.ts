import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import { sessionId, threadId } from "../../src/core/ids"
import type { CompletionEvent } from "../../src/core/ports"
import { BRIDGE_BACKOFF_DEFAULTS, BRIDGE_REQUEST_TIMEOUT_MS, type BridgeClient } from "../../src/omo/bridge-client"
import { OMO_CHILD_ENV_KEYS } from "../../src/omo/runtime"
import { FakeClock } from "../support/fakes"
import { bridgeClient, fileContains, PARENT_ENV, stubInstall, value, type StubInstall } from "./support"

let install: StubInstall
let clock: FakeClock
let client: BridgeClient

beforeEach(async () => {
  install = await stubInstall()
  clock = new FakeClock()
  client = bridgeClient(install, clock)
})

afterEach(async () => {
  await client.stop()
  await install.dispose()
})

const create = (name: string, key = name) => client.create({ name, cwd: install.root, idempotencyKey: key })

describe("BridgeClient request/response", () => {
  test("ensures the host before the first spawn, then serves create, list and close over the child's stdio", async () => {
    const created = value(await create("odm-run-1", "fire-1:1"))
    expect(created).toEqual({ thread: threadId("thread-fire-1:1"), sessionId: sessionId("thread-fire-1:1"), created: true })
    expect((await install.read("stub-omo-calls.log")).trim().split("\n")).toEqual(["daemon run --json --pinned"])

    const listed = value(await client.list())
    expect(listed).toEqual([
      { thread: created.thread, name: "odm-run-1", cwd: install.root, state: "idle", controls: ["send", "read", "rename", "set_model", "set_reasoning", "interrupt"], sessionId: sessionId(created.thread), surface: "daemon" },
    ])
    expect(value(await client.close({ thread: created.thread, graceful: true, waitMs: 30_000 }))).toEqual({ closed: true, reason: "closed" })

    const calls = (await install.read("stub-calls.jsonl")).trim().split("\n").map((line) => JSON.parse(line))
    expect(calls.find((call) => call.method === "create").args).toEqual({ name: "odm-run-1", cwd: install.root, idempotency_key: "fire-1:1" })
    expect(calls.find((call) => call.method === "list").args).toEqual({ all_scope: true })
    expect(calls.find((call) => call.method === "close").args).toEqual({ thread: created.thread, graceful: true, wait_ms: 30_000, all_scope: true })
  })

  test("a create that carries a preset still serializes no permission_preset key", async () => {
    const legacyCaller = { name: "odm-legacy", cwd: install.root, idempotencyKey: "fire-legacy", permissionPreset: "workspace" } as const
    value(await client.create(legacyCaller))

    const calls = (await install.read("stub-calls.jsonl")).trim().split("\n").map((line) => JSON.parse(line))
    const args = calls.find((call) => call.method === "create").args
    expect(Object.keys(args)).not.toContain("permission_preset")
    expect(args).toEqual({ name: "odm-legacy", cwd: install.root, idempotency_key: "fire-legacy" })
  })

  test("accepts the array list shape as well as {kind, threads}", async () => {
    value(await create("odm-run-2"))
    await install.touch("stub-list-array")
    expect(value(await client.list()).map((row) => row.name)).toEqual(["odm-run-2"])
  })

  test("maps a refusal nested in error.error to its gateway code", async () => {
    expect(await client.interrupt({ thread: threadId("thread-x") })).toEqual({ kind: "error", code: "scope_denied", message: "exists outside this workspace" })
  })

  test("passes only the allowlisted environment to the bridge child", async () => {
    value(await client.list().then(async () => client.ensureHost({ agentDir: install.agentDir })))
    const seen = JSON.parse(await install.read("stub-env.json")) as { env: Record<string, string>; options: { agentDir: string } }
    const allowed: readonly string[] = [...OMO_CHILD_ENV_KEYS, "OMO_CODING_AGENT_DIR"]
    expect(Object.keys(seen.env).filter((key) => !allowed.includes(key))).toEqual([])
    expect(seen.env.BUN_INSTALL).toBeUndefined()
    expect(JSON.stringify(seen.env)).not.toContain("leaked-")
    expect(seen.env.OMO_CODING_AGENT_DIR).toBe(install.agentDir)
    expect(seen.env.PATH).not.toContain("/.omo-daemonic/runtime/")
    expect(seen.env.PATH?.split(":")).toContain("/opt/homebrew/bin")
    expect(seen.env.HOME).toBe(PARENT_ENV.HOME)
    expect(seen.options.agentDir).toBe(install.agentDir)
  })
})

describe("BridgeClient restarts", () => {
  test("a child killed mid-request answers bridge_restarted and the next call succeeds after backoff", async () => {
    value(await create("odm-warm"))
    const firstPid = client.pid
    const hung = create("hang")
    await fileContains(install, "stub-calls.jsonl", '"name":"hang"')

    process.kill(firstPid ?? 0, "SIGKILL")
    const answered = await hung
    expect(answered.kind === "error" ? answered.code : answered.kind).toBe("bridge_restarted")

    clock.advance(BRIDGE_BACKOFF_DEFAULTS.initialMs)
    expect(value(await client.list()).map((row) => row.name)).toEqual(["odm-warm"])
    expect(client.pid).not.toBe(firstPid)
  })

  test("restarts the child, disposing the old SDK, when the installed omo-ai version changes", async () => {
    const versions: (string | null)[] = []
    await client.stop()
    client = bridgeClient(install, clock, { onVersionChange: async (version) => void versions.push(version) })
    value(await create("odm-v"))
    const firstPid = client.pid

    await install.setVersion("5.1.100")
    value(await client.list())
    expect(versions).toEqual(["5.1.100"])
    expect(client.pid).not.toBe(firstPid)
    expect((await install.read("stub-disposed")).trim().split("\n")).toContain(String(firstPid))
  })

  test("times a hung request out on the injected clock", async () => {
    value(await create("odm-t"))
    const hung = create("hang")
    await fileContains(install, "stub-calls.jsonl", '"name":"hang"')
    clock.advance(BRIDGE_REQUEST_TIMEOUT_MS)
    const answered = await hung
    expect(answered.kind === "error" ? answered.code : answered.kind).toBe("bridge_timeout")
  })
})

describe("BridgeClient host ensure", () => {
  test("a host_unavailable answer (CLI exit 3) runs `omo daemon run --json --pinned` and retries once", async () => {
    value(await create("odm-h"))
    await rm(install.file("host-up"))
    expect(value(await client.list()).map((row) => row.name)).toEqual(["odm-h"])
    expect((await install.read("stub-omo-calls.log")).trim().split("\n")).toEqual(["daemon run --json --pinned", "daemon run --json --pinned"])
    expect(await install.read("stub-omo-env.txt")).not.toContain("BUN_INSTALL")
  })

  test("answers host_unavailable when the host cannot be ensured", async () => {
    await install.touch("stub-daemon-fail")
    const answered = await create("odm-down")
    expect(answered.kind === "error" ? answered.code : answered.kind).toBe("host_unavailable")
  })
})

describe("BridgeClient degraded mode", () => {
  test("an SDK that cannot load answers gateway_degraded everywhere, with empty capabilities and a failed probe", async () => {
    await client.stop()
    client = bridgeClient(install, clock, { omo: { bin: install.file("no-omo"), pluginRoot: join(install.root, "no-such-plugin") } })
    const thread = threadId("thread-1")
    const answers = await Promise.all([
      create("odm-d"),
      client.list(),
      client.send({ thread, text: "hi", idempotencyKey: "k" }),
      client.read({ thread }),
      client.interrupt({ thread }),
      client.close({ thread }),
      client.setModel({ thread, model: "glm-5.3" }),
      client.bindCompletion({ thread, events: ["completion"] }),
    ])
    expect(answers.map((answer) => (answer.kind === "error" ? answer.code : answer.kind))).toEqual(Array(8).fill("gateway_degraded"))
    expect(client.capabilities()).toEqual([])
    const probe = await client.probe()
    expect(probe.sdkLoad).toBe("fail")
    expect(probe.detail).toStartWith("sdk_unavailable: ")
  })
})

describe("BridgeClient completion arm", () => {
  test("binds, arms the report, and pushes the outbox outcome once the gateway marker changes", async () => {
    const created = value(await create("odm-c"))
    await mkdir(install.file("gateway"))
    const pushed = new Promise<CompletionEvent>((resolve) => {
      const off = client.onCompletion((event) => {
        off()
        resolve(event)
      })
    })
    const binding = value(await client.bindCompletion({ thread: created.thread, events: ["completion"] }))
    expect(binding).toEqual({ bindingId: `bnd-${created.thread}`, thread: created.thread, events: ["completion"] })

    await install.touch("stub-outbox.json", JSON.stringify([{ cursor: 1, event: "completion", text: "settled", state: "pending", outcome: "completed" }]))
    await writeFile(install.file("gateway/outbox.marker"), JSON.stringify({ binding_id: binding.bindingId, cursor: 1 }))
    expect(await pushed).toEqual({ bindingId: binding.bindingId, thread: created.thread, outcome: { status: "completed", detail: "completed" } })
  })
})
