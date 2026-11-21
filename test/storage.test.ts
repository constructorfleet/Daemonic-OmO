import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"

import { loadTaskRecords, readRootSessionTranscript, readTaskTranscript, resolveTaskStateDir } from "../src/storage"

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
    expect(resolveTaskStateDir(project, { agentDir: join(project, "agent") })).toBe(join(realpathSync.native(project), ".omo", "senpi-task"))
  })

  test("#given no legacy records #when resolving #then it uses the hashed agent project directory", () => {
    const project = temp()
    const agent = join(project, "agent")
    const actual = resolveTaskStateDir(project, { agentDir: agent })
    expect(actual).toStartWith(join(agent, "projects", "omo-agent-viewer-"))
    expect(actual).toEndWith("/senpi-task")
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

describe("readTaskTranscript", () => {
  test("#given an event log #when read #then it returns transcript lines", () => {
    const state = temp()
    mkdirSync(join(state, "logs"))
    writeFileSync(
      join(state, "logs", "st_1.jsonl"),
      `${JSON.stringify({ type: "assistant_message", payload: { text: "hello" } })}\n`,
    )
    expect(readTaskTranscript(state, "st_1")).toEqual(["assistant: hello"])
  })

  test("#given a task log that disappears #when read #then it returns an empty transcript", () => {
    expect(readTaskTranscript(temp(), "st_1")).toEqual([])
  })
})

describe("readRootSessionTranscript", () => {
  test("#given a root session transcript #when read #then it returns assistant output", () => {
    const agentDir = temp()
    mkdirSync(join(agentDir, "sessions"))
    writeFileSync(
      join(agentDir, "sessions", "main-1.jsonl"),
      `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "root answer" }] } })}\n`,
    )
    expect(readRootSessionTranscript(agentDir, "main-1")).toEqual(["assistant: root answer"])
  })

  test("#given a missing or unsafe session id #when read #then it returns no transcript", () => {
    expect(readRootSessionTranscript(temp(), "../private")).toEqual([])
    expect(readRootSessionTranscript(temp(), "missing")).toEqual([])
  })
})
