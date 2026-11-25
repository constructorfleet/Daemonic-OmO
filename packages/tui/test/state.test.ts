import { describe, expect, test } from "bun:test"

import type { DagNodeRecord, DagRunRecord } from "../src/dag"
import { projectTaskTree, type TaskRecord } from "../src/state"

const record = (overrides: Partial<TaskRecord> = {}): TaskRecord => ({
  task_id: "st_1",
  parent_session_id: "main-1",
  root_session_id: "main-1",
  status: "running",
  created_at: "2026-11-21T12:00:00.000Z",
  started_at: "2026-11-21T12:00:01.000Z",
  ...overrides,
})

describe("projectTaskTree", () => {
  test("#given task records under a root session #when projected #then it returns a main row and linked child rows", () => {
    const rows = projectTaskTree([
      record({ task_id: "a", name: "implement", child_session_id: "session-a" }),
      record({ task_id: "b", parent_session_id: "session-a", root_session_id: "main-1", name: "review" }),
    ])

    expect(rows.map((row) => [row.id, row.depth])).toEqual([
      ["main:main-1", 0],
      ["a", 1],
      ["b", 2],
    ])
  })

  test("#given records from multiple main sessions #when projected #then it keeps roots separate", () => {
    const rows = projectTaskTree([
      record({ task_id: "a", root_session_id: "main-a", parent_session_id: "main-a" }),
      record({ task_id: "b", root_session_id: "main-b", parent_session_id: "main-b" }),
    ])

    expect(rows.filter((row) => row.kind === "main").map((row) => row.id)).toEqual(["main:main-a", "main:main-b"])
  })

  test("#given nested subagents created out of order #when projected #then parents precede their children", () => {
    const rows = projectTaskTree([
      record({ task_id: "great-grandchild", parent_session_id: "session-b", root_session_id: "main-1", created_at: "2026-11-21T12:00:03.000Z" }),
      record({ task_id: "grandchild", child_session_id: "session-b", parent_session_id: "session-a", root_session_id: "main-1", created_at: "2026-11-21T12:00:01.000Z" }),
      record({ task_id: "sibling", parent_session_id: "main-1", root_session_id: "main-1", created_at: "2026-11-21T12:00:02.000Z" }),
      record({ task_id: "parent", child_session_id: "session-a", parent_session_id: "main-1", root_session_id: "main-1", created_at: "2026-11-21T12:00:00.000Z" }),
    ])

    expect(rows.map((row) => [row.id, row.depth, row.lastSibling, row.ancestorLastSiblings])).toEqual([
      ["main:main-1", 0, undefined, undefined],
      ["parent", 1, false, undefined],
      ["grandchild", 2, true, [false]],
      ["great-grandchild", 3, true, [false, true]],
      ["sibling", 1, true, undefined],
    ])
  })

  test("#given records with missing parents or unknown fields #when projected #then it keeps each task reachable", () => {
    const rows = projectTaskTree([
      record({ task_id: "orphan", parent_session_id: "missing-session", root_session_id: "main-1" }),
    ])

    expect(rows.map((row) => row.id)).toEqual(["main:main-1", "orphan"])
  })
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

describe("projectTaskTree with DAG runs", () => {
  test("#given a run and its attached task #when projected #then the node nests under the run header", () => {
    const rows = projectTaskTree(
      [
        record({ task_id: "st_impl", name: "impl-5", child_session_id: "session-impl" }),
        record({ task_id: "st_child", parent_session_id: "session-impl", name: "explore" }),
        record({ task_id: "st_loose", name: "loose" }),
      ],
      {
        runs: [
          run({
            nodes: [
              node({ taskId: "st_impl" }),
              node({
                id: "verify-5",
                label: "Verify Todo 5",
                state: "pending",
                route: { kind: "category", category: "deep-low" },
              }),
            ],
            waves: [
              { index: 0, nodeIds: ["impl-5"] },
              { index: 1, nodeIds: ["verify-5"] },
            ],
          }),
        ],
      },
    )

    expect(rows.map((row) => [row.id, row.kind, row.depth, row.lastSibling, row.ancestorLastSiblings])).toEqual([
      ["main:main-1", "main", 0, undefined, undefined],
      ["run:dag_1", "run", 1, false, undefined],
      ["st_impl", "task", 2, false, [false]],
      ["st_child", "task", 3, true, [false, false]],
      ["dag:dag_1:verify-5", "task", 2, true, [false]],
      ["st_loose", "task", 1, true, undefined],
    ])
    expect(rows.find((row) => row.id === "st_impl")?.node?.id).toBe("impl-5")
    expect(rows.find((row) => row.id === "dag:dag_1:verify-5")?.task).toMatchObject({
      name: "Verify Todo 5",
      status: "pending",
      category: "deep-low",
    })
  })

  test("#given runs created out of order #when projected #then the newest run is listed first", () => {
    const rows = projectTaskTree([], {
      runs: [
        run({ runId: "older", createdAt: "2026-11-25T07:58:49.337Z" }),
        run({ runId: "newer", createdAt: "2026-11-25T08:00:45.144Z" }),
      ],
    })
    expect(rows.map((row) => row.id)).toEqual(["main:main-1", "run:newer", "run:older"])
  })

  test("#given live node activity #when projected #then only non-terminal attached nodes carry it", () => {
    const activity = new Map([
      ["st_impl", "I read this as a change ask"],
      ["st_done", "finished"],
    ])
    const rows = projectTaskTree(
      [
        record({ task_id: "st_impl", name: "impl-5" }),
        record({ task_id: "st_done", name: "done", status: "completed" }),
      ],
      {
        runs: [run({ nodes: [node({ taskId: "st_impl" }), node({ id: "done", state: "completed", taskId: "st_done" })] })],
        activity,
      },
    )
    expect(rows.find((row) => row.id === "st_impl")?.activity).toBe("I read this as a change ask")
    expect(rows.find((row) => row.id === "st_done")?.activity).toBeUndefined()
  })

  test("#given a root with runs only #when projected #then the main row still appears", () => {
    const rows = projectTaskTree([], { runs: [run()] })
    expect(rows.map((row) => row.id)).toEqual(["main:main-1", "run:dag_1"])
  })
})
