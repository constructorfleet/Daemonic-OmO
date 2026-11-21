import { describe, expect, test } from "bun:test"

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

  test("#given records with missing parents or unknown fields #when projected #then it keeps each task reachable", () => {
    const rows = projectTaskTree([
      record({ task_id: "orphan", parent_session_id: "missing-session", root_session_id: "main-1" }),
    ])

    expect(rows.map((row) => row.id)).toEqual(["main:main-1", "orphan"])
  })
})
