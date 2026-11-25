// Stand-in for <omo-ai>/plugin/runtime/thread-sdk/sdk.js. Tests copy it into a temp omo-ai install and the
// real bridge child imports it. Every answer uses the shapes pinned in test/fixtures/omo; state lives in
// files under the agent dir so it survives a bridge restart and the test can steer it without env vars
// (the bridge passes the child only the allowlisted environment).
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export function createThreadSdk(options) {
  const dir = options.agentDir
  const file = (name) => join(dir, name)
  const log = (method, args) => appendFileSync(file("stub-calls.jsonl"), `${JSON.stringify({ method, args, pid: process.pid })}\n`)
  const threads = () => (existsSync(file("stub-threads.json")) ? JSON.parse(readFileSync(file("stub-threads.json"), "utf8")) : {})
  const save = (all) => writeFileSync(file("stub-threads.json"), JSON.stringify(all))
  const hostUp = () => existsSync(file("host-up"))
  const hostUnavailable = { kind: "error", error: { code: "host_unavailable", message: `The thread host is unavailable at ${dir}/rpc/rpc.sock.`, next_action: "Retry when a host or terminal session is running." } }
  writeFileSync(file("stub-env.json"), JSON.stringify({ env: process.env, options, pid: process.pid }))

  return {
    async create(args) {
      log("create", args)
      if (!hostUp()) return hostUnavailable
      if (args.name === "hang") return new Promise(() => {})
      const all = threads()
      const thread = `thread-${args.idempotency_key}`
      const reopened = all[thread] !== undefined
      all[thread] = { thread, name: args.name, cwd: args.cwd, state: "idle", status: "live" }
      save(all)
      const prompt = args.prompt === undefined ? {} : { prompt: { delivery: { kind: "started", turn_id: "0" }, deduplicated: reopened, delivery_id: "d-1", effective_mode: "follow_up" } }
      return { kind: "ok", thread, name: args.name, status: "live", state: "idle", cwd: args.cwd, deduplicated: false, ...prompt }
    },
    async send(args) {
      log("send", args)
      return { kind: "ok", delivery_id: "d-2", message_seq: 1, effective_mode: "follow_up", deduplicated: false, delivery: { kind: hostUp() ? "started" : "queued_offline" }, thread: args.thread }
    },
    async list(args) {
      log("list", args)
      if (!hostUp()) return hostUnavailable
      const rows = Object.values(threads()).map((row) => ({ ...row, activity: row.state, model: { provider: "zai", id: "glm-5.3" }, surface: "daemon", controls: ["send", "read", "rename", "set_model", "set_reasoning", "interrupt"] }))
      return existsSync(file("stub-list-array")) ? rows : { kind: "ok", threads: rows, scope: "all" }
    },
    async interrupt(args) {
      log("interrupt", args)
      return { kind: "error", error: { kind: "error", code: "scope_denied", message: "exists outside this workspace", next_action: "pass all_scope" } }
    },
    async close(args) {
      log("close", args)
      const all = threads()
      if (all[args.thread] === undefined) return { kind: "ok", thread: args.thread, closed: false, reason: "not_live", dropped_deliveries: [] }
      all[args.thread].state = "inactive"
      all[args.thread].status = "closed"
      save(all)
      return { kind: "ok", thread: args.thread, closed: true, reason: "closed", dropped_deliveries: [] }
    },
    async set_model(args) {
      log("set_model", args)
      return { kind: "ok", thread: args.thread, model: { provider: args.provider ?? "zai", id: args.model } }
    },
    async bind(args) {
      log("bind", args)
      return { kind: "ok", binding: { schema_version: 1, binding_id: `bnd-${args.session}`, status: "active", outbound_events: args.binding.outbound_events }, deduplicated: false }
    },
    async report(args) {
      log("report", args)
      return { kind: "ok", binding_id: args.binding_id, event: "completion", cursor: null, armed: true, deduplicated: false, wake: { reached: true } }
    },
    async outbox(args) {
      log("outbox", args)
      const rows = existsSync(file("stub-outbox.json")) ? JSON.parse(readFileSync(file("stub-outbox.json"), "utf8")) : []
      return { kind: "ok", binding_id: args.binding_id, revision: 1, status: "active", rows, next_cursor: rows.length, acked_cursor: 0 }
    },
    async dispose() {
      appendFileSync(file("stub-disposed"), `${process.pid}\n`)
    },
  }
}
