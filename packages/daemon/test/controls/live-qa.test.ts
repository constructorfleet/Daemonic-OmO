import { afterEach, describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import { join } from "node:path"
import { BridgeClient } from "../../src/omo/bridge-client"
import type { ThreadId } from "../../src/core/types"
import { adminHeaders, field, server, stopServers } from "../api/harness"

const LIVE = process.env.OMO_CONTRACT === "1"

afterEach(stopServers)

async function runOmo(bin: string, agentDir: string, args: readonly string[]): Promise<void> {
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? homedir(),
    USER: process.env.USER ?? "",
    LANG: process.env.LANG ?? "",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    OMO_CODING_AGENT_DIR: agentDir,
  }
  const child = Bun.spawn([bin, ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  if (exitCode !== 0) throw new Error(`omo ${args.join(" ")} exited ${exitCode}: ${stderr || stdout}`)
}

describe.skipIf(!LIVE)("Todo 16 live API QA", () => {
  test("creates a real thread, sends follow-up through HTTP, and closes it", async () => {
    const target = await (async () => {
      const originalTmpdir = process.env.TMPDIR
      process.env.TMPDIR = "/tmp"
      try {
        return await server()
      } finally {
        if (originalTmpdir === undefined) delete process.env.TMPDIR
        else process.env.TMPDIR = originalTmpdir
      }
    })()
    const omoBin = Bun.which("omo")
    if (omoBin === null) throw new Error("omo must be installed for live controls QA")
    const gitInit = Bun.spawn([
      "/bin/sh",
      "-c",
      "GIT_MASTER=1 git -C \"$1\" init -q",
      "sh",
      target.agentDir,
    ], {
      cwd: process.cwd(),
      env: process.env,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    })
    const [gitExitCode, gitError] = await Promise.all([
      gitInit.exited,
      new Response(gitInit.stderr).text(),
    ])
    if (gitExitCode !== 0) throw new Error(`temporary git init failed: ${gitError}`)
    const client = new BridgeClient({
      agentDir: target.agentDir,
      omo: {
        bin: omoBin,
        pluginRoot: join(homedir(), ".bun", "install", "global", "node_modules", "omo-ai", "plugin"),
      },
      clock: target.clock,
      fs: target.fs,
      baseEnv: process.env,
    })
    target.gateway.list = client.list.bind(client)
    target.gateway.send = client.send.bind(client)
    let thread: ThreadId | null = null

    try {
      const created = await client.create({
        name: `omo-daemonic-controls-${crypto.randomUUID()}`,
        cwd: target.agentDir,
        idempotencyKey: `omo-daemonic-controls-${crypto.randomUUID()}`,
      })
      if (created.kind === "error") throw new Error(`${created.code}: ${created.message}`)
      thread = created.value.thread
      const response = await fetch(`${target.url}/api/v1/threads/${thread}/send`, {
        method: "POST",
        headers: adminHeaders(target, { "content-type": "application/json", "idempotency-key": crypto.randomUUID() }),
        body: JSON.stringify({ text: "Todo 16 control API QA", mode: "follow_up" }),
      })
      const body: unknown = await response.json()
      const delivery = field(body, "delivery")

      if (response.status !== 200) {
        throw new Error(`send returned ${response.status}: ${JSON.stringify(body)}`)
      }
      if (delivery !== "sent" && delivery !== "queued_offline") {
        throw new Error(`unexpected thread delivery: ${String(delivery)}`)
      }
      console.info(`QA send delivery: ${delivery}`)
      expect(field(body, "thread")).toBe(thread)
    } finally {
      try {
        if (thread !== null) {
          const closed = await client.close({
            thread,
            force: true,
            graceful: true,
            waitMs: 30_000,
          })
          if (closed.kind === "error") throw new Error(`${closed.code}: ${closed.message}`)
          if (!closed.value.closed) throw new Error(`thread ${thread} did not close`)
        }
      } finally {
        try {
          await client.stop()
        } finally {
          await runOmo(omoBin, target.agentDir, ["daemon", "stop", "--drain", "--all", "--wait"])
          await stopServers()
          console.info(`QA cleanup: closed thread ${thread}; stopped host and removed ${target.home}`)
        }
      }
    }
  })
})
