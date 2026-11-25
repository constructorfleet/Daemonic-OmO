import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"

import { decodeDagRun, orderDagNodes, type DagNodeRecord, type DagRunRecord } from "../src/dag"
import { loadDagRuns, readTaskActivity } from "../src/task-store"

const roots: string[] = []
const temp = (): string => {
  const path = mkdtempSync(join(tmpdir(), "omo-agent-viewer-dag-"))
  roots.push(path)
  return path
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const node = (overrides: Partial<DagNodeRecord> = {}): DagNodeRecord => ({
  id: "impl-5",
  label: "Todo 5 omo contract spike",
  state: "running",
  route: { kind: "category", category: "deep-high" },
  dependsOn: [],
  ...overrides,
})

const run = (overrides: Partial<DagRunRecord> = {}): DagRunRecord => ({
  runId: "dag_1",
  name: "Omo-daemonic Wave 2: Todos 5, 7, 8",
  status: "running",
  rootSessionId: "main-1",
  createdAt: "2026-11-25T08:00:45.144Z",
  nodes: [],
  waves: [],
  ...overrides,
})

describe("decodeDagRun", () => {
  test("#given a daemon run snapshot #when decoded #then nodes, routes and waves survive", () => {
    const decoded = decodeDagRun({
      runId: "dag_1",
      name: "Wave 2",
      status: "running",
      rootSessionId: "main-1",
      parentSessionId: "main-1",
      createdAt: "2026-11-25T08:00:45.144Z",
      nodes: [
        {
          id: "impl-5",
          label: "Todo 5",
          state: "running",
          route: { kind: "agent", agent: "oracle", model: "gpt-5" },
          dependsOn: [],
          taskId: "st_5",
          startedAt: "2026-11-25T08:00:46.000Z",
          attempt: 2,
        },
      ],
      waves: [{ index: 0, nodeIds: ["impl-5", "missing"] }],
    })

    expect(decoded).toMatchObject({
      runId: "dag_1",
      name: "Wave 2",
      rootSessionId: "main-1",
      nodes: [
        {
          id: "impl-5",
          state: "running",
          route: { kind: "agent", agent: "oracle", model: "gpt-5" },
          taskId: "st_5",
          attempt: 2,
        },
      ],
      waves: [{ index: 0, nodeIds: ["impl-5"] }],
    })
  })

  test("#given a run without root or id #when decoded #then it is rejected", () => {
    expect(decodeDagRun({ name: "no id", rootSessionId: "main-1" })).toBeUndefined()
    expect(decodeDagRun({ runId: "dag_1", name: "no root" })).toBeUndefined()
  })

  test("#given waves missing from the snapshot #when decoded #then one wave holds every node", () => {
    const decoded = decodeDagRun({
      runId: "dag_1",
      rootSessionId: "main-1",
      nodes: [{ id: "a", state: "pending" }, { id: "b", state: "pending" }],
    })
    expect(decoded?.waves).toEqual([{ index: 0, nodeIds: ["a", "b"] }])
  })
})

describe("loadDagRuns", () => {
  test("#given valid and malformed run files #when loaded #then valid runs survive and errors are counted", () => {
    const state = temp()
    mkdirSync(join(state, "dag", "runs"), { recursive: true })
    writeFileSync(
      join(state, "dag", "runs", "dag_1.json"),
      JSON.stringify({ runId: "dag_1", rootSessionId: "main-1", nodes: [], waves: [] }),
    )
    writeFileSync(join(state, "dag", "runs", "bad.json"), "{")

    const snapshot = loadDagRuns(state)
    expect(snapshot.runs.map((entry) => entry.runId)).toEqual(["dag_1"])
    expect(snapshot.invalidRuns).toBe(1)
  })

  test("#given no dag directory #when loaded #then it returns an empty snapshot", () => {
    expect(loadDagRuns(temp())).toEqual({ runs: [], invalidRuns: 0 })
  })
})

describe("readTaskActivity", () => {
  test("#given an event log #when read #then the newest assistant message is normalized to one line", () => {
    const state = temp()
    mkdirSync(join(state, "logs"))
    writeFileSync(
      join(state, "logs", "st_5.jsonl"),
      [
        JSON.stringify({ type: "assistant_message", payload: { text: "first" } }),
        JSON.stringify({ type: "tool_execution", payload: { tool: "read" } }),
        JSON.stringify({ type: "assistant_message", payload: { text: "second\n  message" } }),
        JSON.stringify({ type: "transition_applied", payload: { status: "completed" } }),
      ].join("\n"),
    )
    expect(readTaskActivity(state, "st_5")).toBe("second message")
  })

  test("#given no assistant output #when read #then it returns undefined", () => {
    const state = temp()
    mkdirSync(join(state, "logs"))
    writeFileSync(join(state, "logs", "st_5.jsonl"), `${JSON.stringify({ type: "tool_execution" })}\n`)
    expect(readTaskActivity(state, "st_5")).toBeUndefined()
  })
})

describe("orderDagNodes", () => {
  test("#given mixed node states #when ordered #then running leads, then waiting, then settled history", () => {
    const rows = orderDagNodes([
      node({ id: "old-completed", state: "completed", startedAt: "2026-11-25T07:00:00.000Z", completedAt: "2026-11-25T07:05:00.000Z" }),
      node({ id: "verify", state: "pending", createdAt: "2026-11-25T08:00:00.000Z" }),
      node({ id: "second-running", state: "running", startedAt: "2026-11-25T08:00:10.000Z" }),
      node({ id: "first-running", state: "running", startedAt: "2026-11-25T08:00:05.000Z" }),
      node({ id: "new-completed", state: "completed", startedAt: "2026-11-25T07:30:00.000Z", completedAt: "2026-11-25T07:40:00.000Z" }),
    ])
    expect(rows.map((entry) => entry.id)).toEqual([
      "first-running",
      "second-running",
      "verify",
      "new-completed",
      "old-completed",
    ])
  })
})
