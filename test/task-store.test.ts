import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"

import {
  loadTaskRecords,
  readRootDocument,
  readTaskDocument,
  resolveAgentDir,
  resolveTaskStateDir,
} from "../src/task-store"

const roots: string[] = []
const temp = (): string => {
  const path = mkdtempSync(join(tmpdir(), "omo-agent-viewer-"))
  roots.push(path)
  return path
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("resolveTaskStateDir", () => {
  test("#given an explicit override #when resolving #then it wins", () => {
    const project = temp()
    const override = join(project, "custom")
    expect(resolveTaskStateDir(project, { stateDir: override, agentDir: join(project, "agent") })).toBe(override)
  })

  test("#given a populated legacy project store #when resolving #then it stays selected", () => {
    const project = temp()
    const legacy = join(project, ".omo", "senpi-task")
    mkdirSync(join(legacy, "tasks"), { recursive: true })
    writeFileSync(join(legacy, "tasks", "st_1.json"), "{}")
    expect(resolveTaskStateDir(project, { agentDir: join(project, "agent") })).toBe(
      join(realpathSync.native(project), ".omo", "senpi-task"),
    )
  })

  test("#given no legacy records #when resolving #then it uses the hashed agent project directory", () => {
    const project = temp()
    const agent = join(project, "agent")
    const actual = resolveTaskStateDir(project, { agentDir: agent })
    expect(actual).toStartWith(join(agent, "projects", "omo-agent-viewer-"))
    expect(actual).toEndWith("/senpi-task")
  })
})

describe("resolveAgentDir", () => {
  test("#given configured environment variables #when resolving #then the first non-empty path wins", () => {
    expect(
      resolveAgentDir({ env: { OMO_CODING_AGENT_DIR: " /tmp/omo-agent ", SENPI_CODING_AGENT_DIR: "/tmp/other" } }),
    ).toBe("/tmp/omo-agent")
  })
})

describe("loadTaskRecords", () => {
  test("#given valid and malformed record files #when loaded #then it returns valid tasks and bounded diagnostics", () => {
    const state = temp()
    const tasks = join(state, "tasks")
    mkdirSync(tasks)
    writeFileSync(
      join(tasks, "st_1.json"),
      JSON.stringify({
        task_id: "st_1",
        parent_session_id: "main-1",
        root_session_id: "main-1",
        status: "running",
        created_at: "2026-11-21T12:00:00.000Z",
      }),
    )
    writeFileSync(join(tasks, "bad.json"), "{")

    const result = loadTaskRecords(state)
    expect(result.records.map((record) => record.task_id)).toEqual(["st_1"])
    expect(result.invalidRecords).toBe(1)
  })
})

describe("readTaskDocument", () => {
  test("#given an event log without a child session #when read #then it falls back to the event transcript", () => {
    const state = temp()
    mkdirSync(join(state, "logs"))
    writeFileSync(
      join(state, "logs", "st_1.jsonl"),
      `${JSON.stringify({ type: "assistant_message", payload: { text: "hello" } })}\n`,
    )
    expect(readTaskDocument(state, "st_1")).toEqual({
      lines: ["assistant: hello"],
      lineTurns: [undefined],
      turns: [],
    })
  })

  test("#given a child session #when read #then the detailed session transcript wins over the event log", () => {
    const state = temp()
    mkdirSync(join(state, "logs"))
    writeFileSync(
      join(state, "logs", "st_1.jsonl"),
      `${JSON.stringify({ type: "assistant_message", payload: { text: "event log" } })}\n`,
    )
    const sessionDir = join(state, "children", "st_1", "sessions", "st_1")
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(
      join(sessionDir, "2026-01-01T00-00-00.jsonl"),
      [
        JSON.stringify({ id: "turn-a", type: "message", message: { role: "assistant", content: [{ type: "text", text: "session" }] } }),
        JSON.stringify({
          id: "turn-b",
          type: "message",
          message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "bun test" } }] },
        }),
      ].join("\n") + "\n",
    )

    const document = readTaskDocument(state, "st_1")
    expect(document.lines).toEqual(["assistant: session", 'tool: bash command="bun test"'])
    expect(document.lineTurns).toEqual(["turn-a", "turn-b"])
    expect(document.turns).toHaveLength(2)
  })

  test("#given a child session and a child error #when read #then the error is kept at the end without a turn", () => {
    const state = temp()
    mkdirSync(join(state, "logs"))
    writeFileSync(
      join(state, "logs", "st_1.jsonl"),
      `${JSON.stringify({ type: "child_error", payload: { message: "provider failed" } })}\n`,
    )
    const sessionDir = join(state, "children", "st_1", "sessions", "st_1")
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(
      join(sessionDir, "2026-01-01T00-00-00.jsonl"),
      `${JSON.stringify({ id: "turn-a", type: "message", message: { role: "assistant", content: [{ type: "text", text: "done" }] } })}\n`,
    )

    expect(readTaskDocument(state, "st_1")).toEqual({
      lines: ["assistant: done", "error: provider failed"],
      lineTurns: ["turn-a", undefined],
      turns: [{ id: "turn-a", thinking: [], parts: [{ kind: "text", text: "done" }], results: [] }],
    })
  })

  test("#given a child session whose image line exceeds the read budget #when read #then the image is only present when the budget reaches it", () => {
    const state = temp()
    mkdirSync(join(state, "logs"))
    const data = "A".repeat(300_000)
    const sessionDir = join(state, "children", "st_1", "sessions", "st_1")
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(
      join(sessionDir, "2026-01-01T00-00-00.jsonl"),
      [
        JSON.stringify({
          id: "turn-a",
          type: "message",
          message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "/tmp/shot.png" } }] },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "read",
            content: [
              { type: "text", text: "Read image file [image/png]" },
              { type: "image", mimeType: "image/png", data },
            ],
          },
        }),
        JSON.stringify({ id: "turn-b", type: "message", message: { role: "assistant", content: [{ type: "text", text: "after" }] } }),
      ].join("\n") + "\n",
    )

    const imagesOf = (document: ReturnType<typeof readTaskDocument>) =>
      document.turns.flatMap((turn) => turn.results.flatMap((result) => result.images ?? []))
    expect(imagesOf(readTaskDocument(state, "st_1", { maxBytes: 64 * 1024 }))).toEqual([])
    expect(imagesOf(readTaskDocument(state, "st_1", { maxBytes: 1024 * 1024 }))).toEqual([{ mimeType: "image/png", data }])
    expect(imagesOf(readTaskDocument(state, "st_1"))).toEqual([{ mimeType: "image/png", data }])
  })

  test("#given a missing or unsafe task id #when read #then it returns an empty document", () => {
    const state = temp()
    expect(readTaskDocument(state, "missing")).toEqual({ lines: [], lineTurns: [], turns: [] })
    expect(readTaskDocument(state, "../private")).toEqual({ lines: [], lineTurns: [], turns: [] })
  })
})

describe("readRootDocument", () => {
  test("#given a root session #when read #then it returns the same detailed document shape as a task", () => {
    const agentDir = temp()
    mkdirSync(join(agentDir, "sessions"))
    writeFileSync(
      join(agentDir, "sessions", "main-1.jsonl"),
      [
        JSON.stringify({
          id: "turn-root",
          type: "message",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "Thinking at the root." },
              { type: "text", text: "root answer" },
              { type: "toolCall", id: "call-1", name: "read", arguments: { path: "/tmp/root" } },
            ],
          },
        }),
        JSON.stringify({
          type: "message",
          message: { role: "toolResult", toolCallId: "call-1", toolName: "read", isError: false, content: [{ type: "text", text: "ok" }] },
        }),
      ].join("\n") + "\n",
    )

    const document = readRootDocument(agentDir, "main-1")
    expect(document.lines).toEqual([
      "thinking: Thinking at the root.",
      "assistant: root answer",
      'tool: read path="/tmp/root"',
      "result(read): ok",
    ])
    expect(document.lineTurns).toEqual(["turn-root", "turn-root", "turn-root", "turn-root"])
    expect(document.turns).toHaveLength(1)
  })

  test("#given a missing or unsafe session id #when read #then it returns an empty document", () => {
    expect(readRootDocument(temp(), "../private")).toEqual({ lines: [], lineTurns: [], turns: [] })
    expect(readRootDocument(temp(), "missing")).toEqual({ lines: [], lineTurns: [], turns: [] })
  })
})
