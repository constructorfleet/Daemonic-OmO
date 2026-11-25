import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"

import { matchFixture } from "./fixtures"
import {
  CONTRACT,
  isAlive,
  omo,
  parseThreadList,
  probeThreadSdk,
  sdk,
  sdkOk,
  startContract,
  type ContractContext,
} from "./harness"
import {
  assistantTexts,
  deliveryMessages,
  expectedTaskStateDir,
  findSessionFile,
  findTaskRecord,
  permissionMode,
  readOutboxMarker,
  readPidFile,
  readSessionEntries,
  sessionFileOf,
  sessionFolderName,
  watchUntil,
} from "./session-store"
import { stopContract } from "./teardown"

const OK_PROMPT = "Reply with exactly OK"
const TURN_MS = 120_000
const OMO_PRESETS = ["full-access", "workspace", "accept-edits", "auto", "read-only"] as const
const TASK_RECORD_KEYS = ["task_id", "status", "residency_state", "parent_session_id", "root_session_id", "child_session_id", "depth", "agent_type", "spawn_spec"] as const

describe.skipIf(!CONTRACT.live)("omo thread SDK and CLI contract", () => {
  let ctx: ContractContext
  beforeAll(async () => {
    ctx = await startContract()
  })
  afterAll(async () => {
    await stopContract(ctx)
  })

  test("10a: omo daemon run --json starts the operator endpoint in an empty agent dir", () => {
    expect(ctx.daemonRun).toMatchObject({ action: "start", lifecycle: "ready" })
    expect(ctx.daemonRun.socket).toBe(join(ctx.agentDir, "rpc", "rpc.sock"))
    matchFixture(ctx, "daemon-run", ctx.daemonRun)
  })

  test("1: the thread SDK loads in the bridge runtime and under the private Bun", async () => {
    const bridge = await sdk(ctx, [], ctx.project)
    const privateBun = await sdk(ctx, [], ctx.project, { runtime: process.execPath })
    for (const reply of [bridge, privateBun]) {
      expect(reply.kind).toBe("ok")
      expect(sdkOk(reply).methods).toEqual(
        expect.arrayContaining(["create", "send", "read", "list", "interrupt", "close", "set_model", "rename", "bind", "report", "outbox", "locate"]),
      )
    }
    expect(ctx.runtime.kind).toBe("bun")
  })

  test("1-QA: a nonexistent plugin root reports sdk_unavailable instead of throwing", async () => {
    const probe = await probeThreadSdk(ctx, join(ctx.root, "no-such-plugin"))
    expect(probe.sdkLoad).toBe("fail")
    expect(probe.detail).toStartWith("sdk_unavailable: ")
    matchFixture(ctx, "probe-sdk-unavailable", probe)
    expect((await probeThreadSdk(ctx, CONTRACT.pluginRoot)).sdkLoad).toBe("ok")
  })

  test("2: create without prompt reopens by key; send twice under one key is deduplicated", async () => {
    const create = { name: "omo-daemonic-contract-a2", cwd: ctx.project, idempotency_key: ctx.key("a2"), ...ctx.model }
    const send = { text: OK_PROMPT, mode: "follow_up", idempotency_key: ctx.key("a2-send") }
    const first = sdkOk(await sdk(ctx, [{ method: "create", args: create }, { method: "create", args: create }], ctx.project))
    const [created, reopened] = first.results
    expect(created).toMatchObject({ kind: "ok", name: create.name, state: "idle" })
    const thread = ctx.track(created).thread
    expect(reopened).toMatchObject({ kind: "ok", thread })
    const sent = sdkOk(await sdk(ctx, [{ method: "send", args: { thread, ...send } }, { method: "send", args: { thread, ...send } }], ctx.project))
    const [once, twice] = sent.results
    expect(once).toMatchObject({ kind: "ok", deduplicated: false })
    expect(twice).toMatchObject({ kind: "ok", deduplicated: true, delivery_id: field(once, "delivery_id"), message_seq: field(once, "message_seq") })
    matchFixture(ctx, "create", created)
    matchFixture(ctx, "create-reopen", reopened)
    matchFixture(ctx, "send-dedup", twice)
  })

  test.skipIf(!CONTRACT.spend)("2-spend: a create prompt repeated under one key is delivered once; provenance differs from send", async () => {
    const create = { name: "omo-daemonic-contract-a2p", cwd: ctx.project, prompt: OK_PROMPT, idempotency_key: ctx.key("a2p"), ...ctx.model }
    const settled = watchUntil(ctx.agentDir, () => firstAssistant(ctx, "omo-daemonic-contract-a2p"))
    const reply = sdkOk(await sdk(ctx, [{ method: "create", args: create }, { method: "create", args: create }], ctx.project))
    const [created, repeated] = reply.results
    const thread = ctx.track(created).thread
    expect(repeated).toMatchObject({ thread, prompt: { deduplicated: true, delivery_id: field(field(created, "prompt"), "delivery_id") } })
    await settled.until(TURN_MS)
    const deliveries = deliveryMessages(readSessionEntries(sessionFileOf(ctx.agentDir, thread)))
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]).toMatchObject({ content: OK_PROMPT, sender: { kind: "command_line" } })
    matchFixture(ctx, "create-with-prompt-repeat", repeated)
  })

  test("3: the thread id is the durable session id and locate names the session file", async () => {
    const created = ctx.track(sdkOk(await sdk(ctx, [{ method: "create", args: { name: "omo-daemonic-contract-a3", cwd: ctx.project, idempotency_key: ctx.key("a3") } }], ctx.project)).results[0])
    const located = sdkOk(await sdk(ctx, [{ method: "locate", args: { thread: created.thread } }], ctx.project)).results[0]
    const file = sessionFileOf(ctx.agentDir, created.thread)
    expect(located).toMatchObject({ kind: "ok", thread: { thread_id: created.thread, session_path: file, endpoint: { durable_session_id: created.thread } } })
    expect(readSessionEntries(file)[0]).toMatchObject({ type: "session", id: created.thread, cwd: ctx.project })
    matchFixture(ctx, "locate", located)
  })

  test("4: preset names are known; a script creator may request only ask, which the session header records", async () => {
    const attempt = (preset: string) => ({ method: "create", args: { name: `omo-daemonic-contract-a4-${preset}`, cwd: ctx.project, permission_preset: preset, idempotency_key: ctx.key(`a4-${preset}`) } })
    const reply = sdkOk(await sdk(ctx, [...OMO_PRESETS.map(attempt), attempt("bogus"), attempt("ask")], ctx.project))
    const wider = reply.results.slice(0, OMO_PRESETS.length)
    for (const refusal of wider) expect(refusal).toMatchObject({ kind: "error", error: { code: "scope_denied", details: { reason: "permission_preset_wider" } } })
    expect(reply.results[OMO_PRESETS.length]).toMatchObject({ kind: "error", error: { code: "invalid_arguments" } })
    const ask = ctx.track(reply.results[OMO_PRESETS.length + 1])
    expect(permissionMode(readSessionEntries(sessionFileOf(ctx.agentDir, ask.thread)))).toEqual({ preset: "ask", source: "client" })
    matchFixture(ctx, "preset-wider-refused", wider[1])
  })

  test("5: a worktree thread's session folder is named from the raw cwd", async () => {
    const created = ctx.track(sdkOk(await sdk(ctx, [{ method: "create", args: { name: "omo-daemonic-contract-a5", cwd: ctx.worktree, idempotency_key: ctx.key("a5") } }], ctx.worktree)).results[0])
    const file = sessionFileOf(ctx.agentDir, created.thread)
    expect(file.startsWith(join(ctx.agentDir, "sessions", sessionFolderName(ctx.worktree)))).toBe(true)
    expect(expectedTaskStateDir(ctx.agentDir, ctx.worktree)).toContain(`${join(ctx.agentDir, "projects", "wt1-")}`)
  })

  test("8: interrupt reaches a thread under another cwd only with all_scope", async () => {
    const other = ctx.track(sdkOk(await sdk(ctx, [{ method: "create", args: { name: "omo-daemonic-contract-a8", cwd: ctx.other, idempotency_key: ctx.key("a8") } }], ctx.other)).results[0])
    const reply = sdkOk(await sdk(ctx, [{ method: "interrupt", args: { thread: other.thread } }, { method: "interrupt", args: { thread: other.thread, all_scope: true } }], ctx.project))
    expect(reply.results[0]).toMatchObject({ kind: "error", error: { code: "scope_denied" } })
    expect(reply.results[1]).toMatchObject({ kind: "ok", thread: other.thread, interrupted: false })
    matchFixture(ctx, "interrupt-all-scope", reply.results[1])
  })

  test("10: CLI and SDK list, schedule list, version and close shapes", async () => {
    const cliList = await omo(ctx, ["thread", "list", "--json", "--all-scope"], ctx.project)
    expect(cliList.exitCode).toBe(0)
    const rows = parseThreadList(cliList.json)
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) expect(row).toMatchObject({ state: expect.any(String), controls: expect.any(Array), surface: "daemon" })
    const schedules = await omo(ctx, ["schedule", "list", "--json"], ctx.project)
    expect(schedules.exitCode).toBe(0)
    expect(schedules.json).toMatchObject({ jobs: [], invalid: [] })
    expect((await omo(ctx, ["--version"], ctx.project)).stdout).toMatch(/^omo \d+\.\d+\.\d+ \(engine: senpi [^)]+\)\n?$/)
    const target = ctx.track(sdkOk(await sdk(ctx, [{ method: "create", args: { name: "omo-daemonic-contract-a10", cwd: ctx.project, idempotency_key: ctx.key("a10") } }], ctx.project)).results[0])
    const closed = sdkOk(await sdk(ctx, [{ method: "close", args: { thread: target.thread, graceful: true, wait_ms: 5000 } }], ctx.project)).results[0]
    expect(closed).toMatchObject({ kind: "ok", closed: true, reason: "closed" })
    matchFixture(ctx, "thread-list-cli", cliList.json)
    matchFixture(ctx, "schedule-list", schedules.json)
    matchFixture(ctx, "close-graceful", closed)
  })

  test.skipIf(!CONTRACT.spend)("6: a completion arm writes an outbox row with the run's outcome", async () => {
    const created = ctx.track(sdkOk(await sdk(ctx, [{ method: "create", args: { name: "omo-daemonic-contract-a6", cwd: ctx.project, idempotency_key: ctx.key("a6"), ...ctx.model } }], ctx.project)).results[0])
    const binding = { platform: "custom", account_id: "omo-daemonic", chat_id: `odc-${created.thread}`, outbound_events: ["completion"], direction: { inbound: false, outbound: true } }
    const bound = sdkOk(await sdk(ctx, [{ method: "bind", args: { session: created.thread, binding, idempotency_key: ctx.key("a6-bind") } }], ctx.project)).results[0]
    const bindingId = String(field(field(bound, "binding"), "binding_id"))
    const marker = watchUntil(join(ctx.agentDir, "gateway"), () => outboxMarkerFor(ctx, bindingId))
    const armed = sdkOk(await sdk(ctx, [
      { method: "report", args: { session: created.thread, kind: "completion", text: "odc-a6 settled", binding_id: bindingId, idempotency_key: ctx.key("a6-arm") } },
      { method: "send", args: { thread: created.thread, text: OK_PROMPT, mode: "follow_up", idempotency_key: ctx.key("a6-send") } },
    ], ctx.project)).results
    expect(armed[0]).toMatchObject({ kind: "ok", event: "completion", armed: true })
    await marker.until(TURN_MS)
    const outbox = sdkOk(await sdk(ctx, [{ method: "outbox", args: { binding_id: bindingId } }], ctx.project)).results[0]
    expect(outbox).toMatchObject({ kind: "ok", rows: [{ event: "completion", text: "odc-a6 settled", outcome: "completed" }] })
    matchFixture(ctx, "bind", bound)
    matchFixture(ctx, "report-arm", armed[0])
    matchFixture(ctx, "outbox-completion", outbox)
  })

  test.skipIf(!CONTRACT.spend)("5+9+3: a worktree run's child lands in the realpath task store and close({force}) ends it", async () => {
    const pidFile = join(ctx.worktree, ".odc-a9.pid")
    const prompt = `Call the task tool exactly once with run_in_background set to true, subagent_type omo-native-qa-executor, model ${CONTRACT.model}, and this prompt for the child: 'Run exactly this shell command in the foreground: sh -c "echo \\$\\$ > ${pidFile}; exec sleep 6131"' Do not wait for the child. After the task tool returns, reply with exactly STARTED.`
    const started = watchUntil(ctx.root, () => readPidFile(pidFile))
    const created = ctx.track(sdkOk(await sdk(ctx, [{ method: "create", args: { name: "omo-daemonic-contract-a9", cwd: ctx.worktree, prompt, idempotency_key: ctx.key("a9"), ...ctx.model } }], ctx.worktree)).results[0])
    const pid = await started.until(TURN_MS)
    expect(isAlive(pid)).toBe(true)
    const stateDir = expectedTaskStateDir(ctx.agentDir, ctx.worktree)
    const child = findTaskRecord(stateDir, created.thread)
    expect(child).toMatchObject({ root_session_id: created.thread, parent_session_id: created.thread, residency_state: "resident" })
    const released = watchUntil(stateDir, () => (findTaskRecord(stateDir, created.thread)?.residency_state === "persisted_only" ? true : undefined))
    const closed = sdkOk(await sdk(ctx, [{ method: "close", args: { thread: created.thread, force: true } }], ctx.worktree)).results[0]
    expect(closed).toMatchObject({ kind: "ok", closed: true, reason: "closed" })
    await released.until(TURN_MS)
    expect(isAlive(pid)).toBe(false)
    matchFixture(ctx, "close-force", closed)
    matchFixture(ctx, "task-record-child", Object.fromEntries(TASK_RECORD_KEYS.map((key) => [key, field(child, key)])))
  })

  test("7: after omo daemon stop, create reopens by key once the host is ensured; the restored session is held unattended until engine input", async () => {
    const create = { name: "omo-daemonic-contract-a7", cwd: ctx.project, idempotency_key: ctx.key("a7"), ...ctx.model }
    const thread = ctx.track(sdkOk(await sdk(ctx, [{ method: "create", args: create }], ctx.project)).results[0]).thread
    const refused = await omo(ctx, ["daemon", "stop"], ctx.project)
    expect(refused.exitCode).toBe(3)
    expect(refused.stdout + refused.stderr).toContain("sessions_live")
    const socket = join(ctx.agentDir, "rpc", "rpc.sock")
    const operatorGone = watchUntil(join(ctx.agentDir, "rpc"), () => (existsSync(socket) ? undefined : true))
    expect((await omo(ctx, ["daemon", "stop", "--drain"], ctx.project)).exitCode).toBe(0)
    await operatorGone.until(60_000)
    const hostless = sdkOk(await sdk(ctx, [{ method: "create", args: create }], ctx.project)).results[0]
    expect(hostless).toMatchObject({ kind: "error", error: { code: "host_unavailable" } })
    const ensured = await omo(ctx, ["daemon", "run", "--json"], ctx.project)
    expect(ensured.json).toMatchObject({ action: "start", lifecycle: "ready" })
    expect(sdkOk(await sdk(ctx, [{ method: "create", args: create }], ctx.project)).results[0]).toMatchObject({ kind: "ok", thread })
    const sent = sdkOk(await sdk(ctx, [{ method: "send", args: { thread, text: OK_PROMPT, mode: "follow_up", idempotency_key: ctx.key("a7-send") } }], ctx.project)).results[0]
    expect(sent).toMatchObject({ kind: "ok", deduplicated: false })
    const held = await omo(ctx, ["host", "session", "state", thread, "--json"], ctx.project)
    expect(held.json).toMatchObject({ action: "state", durableSessionId: thread, state: { paused: true, holds: [{ kind: "unattended" }] } })
    matchFixture(ctx, "create-host-unavailable", hostless)
    matchFixture(ctx, "host-session-state-held", held.json)
    if (!CONTRACT.spend) return
    const turn = watchUntil(ctx.agentDir, () => (assistantTexts(readSessionEntries(sessionFileOf(ctx.agentDir, thread))).length > 0 ? true : undefined))
    const prompted = await omo(ctx, ["host", "session", "prompt", thread, OK_PROMPT], ctx.project)
    expect(prompted.json).toMatchObject({ action: "prompt", disposition: "started" })
    await turn.until(TURN_MS)
    matchFixture(ctx, "host-session-prompt", prompted.json)
  })
})

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined
}

function firstAssistant(ctx: ContractContext, name: string): true | undefined {
  const thread = ctx.threadNamed(name)
  const file = thread === undefined ? undefined : findSessionFile(ctx.agentDir, thread)
  if (file === undefined) return undefined
  return assistantTexts(readSessionEntries(file)).length > 0 ? true : undefined
}

function outboxMarkerFor(ctx: ContractContext, bindingId: string): true | undefined {
  return readOutboxMarker(ctx.agentDir)?.binding_id === bindingId ? true : undefined
}
