import { describe, expect, test } from "bun:test"

import type { TaskRecord, TaskTreeItem } from "../src/state"
import { buildTranscriptDocument, type TranscriptDocument, type TranscriptTurn } from "../src/transcript"
import {
  RAIL_COLOR,
  RAIL_INACTIVE,
  clampViewer,
  initialViewerState,
  projectViewer,
  reconcileViewer,
  updateViewer,
  wrapText,
  type ViewerContext,
  type ViewerData,
  type ViewerLimits,
  type ViewerState,
  type ViewerViewport,
} from "../src/viewer-model"

const record = (overrides: Partial<TaskRecord> = {}): TaskRecord => ({
  task_id: "st_a",
  parent_session_id: "main-1",
  root_session_id: "main-1",
  status: "completed",
  created_at: "2026-11-24T12:00:00.000Z",
  started_at: "2026-11-24T12:00:01.000Z",
  terminal_at: "2026-11-24T12:01:00.000Z",
  ...overrides,
})

const mainItem = (root = "main-1"): TaskTreeItem => ({
  id: `main:${root}`,
  kind: "main",
  rootSessionId: root,
  depth: 0,
})

const taskItem = (id: string, name: string, depth = 1, root = "main-1"): TaskTreeItem => ({
  id,
  kind: "task",
  rootSessionId: root,
  depth,
  task: record({ task_id: id, name, parent_session_id: "main-1", root_session_id: root }),
})

const turn = (id: string, text: string, thinking: string[] = []): TranscriptTurn => ({
  id,
  thinking,
  parts: [{ kind: "text", text }],
  results: [],
})

const pngFixture =
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAYAAAB/qH1jAAAAE0lEQVR4nGP4z8DwHxkzoPH/AwAHKQ/xs/M1WgAAAABJRU5ErkJggg=="

const imageTurn = (id: string): TranscriptTurn => ({
  id,
  thinking: [],
  parts: [],
  results: [
    {
      name: "read",
      isError: false,
      text: "Read image file [image/png]",
      images: [{ mimeType: "image/png", data: pngFixture }],
    },
  ],
})

const todoReport = [
  "Now: Build the widget (Build)",
  "Next: Test the widget (Verify)",
  "",
  "Remaining items (2):",
  "  - Build the widget [in_progress] (Build)",
  "  - Test the widget [pending] (Verify)",
  "Overall: 1/3 done, 2 open.",
  'Active phase 1/2 "Build" (0/2).',
  "  Setup:",
  "    - [X] Read the code",
  "  Build:",
  "    - [ ] Build the widget (in progress)",
  "    - [ ] Test the widget",
].join("\n")

const todoTranscript = (): TranscriptDocument =>
  transcriptOf([
    {
      id: "todo-turn",
      thinking: [],
      parts: [{ kind: "text", text: "planning" }],
      results: [{ name: "todo", isError: false, text: todoReport }],
    },
  ])

const transcriptOf = (turns: readonly TranscriptTurn[]): TranscriptDocument => buildTranscriptDocument(turns)

const makeData = (items: readonly TaskTreeItem[], transcript: TranscriptDocument): ViewerData => ({
  items,
  transcript,
  projectDir: "/tmp/project",
  refreshMs: 1_000,
  invalidRecords: 0,
})

const viewport = (overrides: Partial<ViewerViewport> = {}): ViewerViewport => ({
  listWidth: 32,
  listHeight: 14,
  detailWidth: 60,
  detailHeight: 24,
  todoWidth: 80,
  todoHeight: 12,
  ...overrides,
})

const context = (
  items: readonly TaskTreeItem[],
  transcript: TranscriptDocument,
  limits: ViewerLimits = { transcriptScroll: 0, todoScroll: 0 },
): ViewerContext => ({ items, transcript, limits })

const selectedTask = (items: readonly TaskTreeItem[], id = "st_a"): ViewerState => ({
  ...initialViewerState(items),
  selectedId: id,
  viewId: id,
})

describe("viewer state", () => {
  test("#given items #when initialized #then the first main session is selected and viewed", () => {
    const items = [mainItem(), taskItem("st_a", "alpha")]
    const state = initialViewerState(items)
    expect(state).toMatchObject({
      selectedId: "main:main-1",
      viewId: "main:main-1",
      focus: "tree",
      todoVisible: true,
      paused: false,
      scrollOffset: 0,
    })
    expect(state.expandedTurnId).toBeUndefined()
  })

  test("#given a task tree #when initialized #then main rows are collapsed and enter expands their subagents", () => {
    const items = [mainItem(), taskItem("st_a", "alpha"), taskItem("st_b", "bravo")]
    const transcript = transcriptOf([turn("t1", "one")])
    const collapsed = projectViewer(initialViewerState(items), makeData(items, transcript), viewport())
    expect(collapsed.list.lines.some((line) => line.includes("alpha"))).toBe(false)
    expect(collapsed.list.lines.some((line) => line.includes("▸ ◆ Main session"))).toBe(true)
    expect(collapsed.footer).toContain("enter/→ expand")
    expect(collapsed.footer).toContain("o open")

    let state = updateViewer(initialViewerState(items), { type: "open" }, context(items, transcript))
    expect(state.expandedRoots).toEqual(["main-1"])
    const expanded = projectViewer(state, makeData(items, transcript), viewport())
    expect(expanded.list.lines.some((line) => line.includes("└─✓ alpha"))).toBe(true)
    expect(expanded.list.lines.some((line) => line.includes("▾ ◆ Main session"))).toBe(true)
    expect(expanded.footer).toContain("enter/→ collapse")

    state = updateViewer(state, { type: "open" }, context(items, transcript))
    expect(state.expandedRoots).toEqual([])
  })

  test("#given two main sessions #when one is expanded #then the other keeps its subagents collapsed", () => {
    const items = [mainItem(), taskItem("st_a", "alpha"), mainItem("main-2"), taskItem("st_b", "bravo", 1, "main-2")]
    const transcript = transcriptOf([])
    const state = updateViewer(initialViewerState(items), { type: "open" }, context(items, transcript))
    const frame = projectViewer(state, makeData(items, transcript), viewport())
    expect(frame.list.lines.some((line) => line.includes("alpha"))).toBe(true)
    expect(frame.list.lines.some((line) => line.includes("bravo"))).toBe(false)
    expect(frame.list.lines.some((line) => line.includes("main-2") && line.includes("▸"))).toBe(true)
  })

  test("#given nested subagents #when a main is expanded #then deeper rows keep their ancestor guides", () => {
    const items: TaskTreeItem[] = [
      mainItem(),
      { ...taskItem("st_parent", "parent"), lastSibling: false },
      { ...taskItem("st_child", "child", 2), lastSibling: true, ancestorLastSiblings: [false] },
      taskItem("st_sibling", "sibling"),
    ]
    const transcript = transcriptOf([])
    const state = updateViewer(initialViewerState(items), { type: "open" }, context(items, transcript))
    const frame = projectViewer(state, makeData(items, transcript), viewport())
    expect(frame.list.lines).toContain("  ├─✓ parent")
    expect(frame.list.lines).toContain("  │ └─✓ child")
    expect(frame.list.lines).toContain("  └─✓ sibling")
  })

  test("#given a selected task #when it is opened and then backed out #then the view follows the selection and returns to main", () => {
    const items = [mainItem(), taskItem("st_a", "alpha")]
    const transcript = transcriptOf([])
    let state = initialViewerState(items)
    state = updateViewer(state, { type: "open" }, context(items, transcript))
    state = updateViewer(state, { type: "move", delta: 1 }, context(items, transcript))
    expect(state.selectedId).toBe("st_a")
    state = updateViewer(state, { type: "open" }, context(items, transcript))
    expect(state.viewId).toBe("st_a")
    state = updateViewer(state, { type: "back" }, context(items, transcript))
    expect(state.viewId).toBe("main:main-1")
  })

  test("#given a task selected in the tree #when enter opens it #then the transcript takes focus and selects the newest turn", () => {
    const items = [mainItem(), taskItem("st_a", "alpha")]
    const transcript = transcriptOf([turn("t1", "one"), turn("t2", "two")])
    let state = initialViewerState(items)
    state = updateViewer(state, { type: "open" }, context(items, transcript))
    state = updateViewer(state, { type: "move", delta: 1 }, context(items, transcript))
    expect(state.selectedId).toBe("st_a")
    expect(state.selectedTurnId).toBeUndefined()
    state = updateViewer(state, { type: "open" }, context(items, transcript))
    expect(state.focus).toBe("transcript")
    expect(state.expandedTurnId).toBeUndefined()
    state = reconcileViewer(state, items, transcript)
    expect(state.viewId).toBe("st_a")
    expect(state.selectedTurnId).toBe("t2")
  })

  test("#given transcript focus #when the arrows move #then turns move and the tree selection stays put", () => {
    const items = [mainItem(), taskItem("st_a", "alpha")]
    const transcript = transcriptOf([turn("t1", "one"), turn("t2", "two")])
    const state: ViewerState = { ...selectedTask(items), focus: "transcript", selectedTurnId: "t2" }
    const moved = updateViewer(state, { type: "move", delta: -1 }, context(items, transcript))
    expect(moved.selectedTurnId).toBe("t1")
    expect(moved.selectedId).toBe("st_a")
    const expanded: ViewerState = { ...moved, expandedTurnId: "t1" }
    expect(updateViewer(expanded, { type: "move", delta: 1 }, context(items, transcript)).expandedTurnId).toBe("t2")
  })

  test("#given a selected turn #when enter is pressed twice #then its detail opens and closes", () => {
    const items = [mainItem(), taskItem("st_a", "alpha")]
    const transcript = transcriptOf([turn("t1", "one"), turn("t2", "two")])
    const state: ViewerState = { ...selectedTask(items), focus: "transcript", selectedTurnId: "t2" }
    const opened = updateViewer(state, { type: "open" }, context(items, transcript))
    expect(opened.expandedTurnId).toBe("t2")
    expect(updateViewer(opened, { type: "open" }, context(items, transcript)).expandedTurnId).toBeUndefined()
  })

  test("#given a detail and transcript focus #when left is pressed #then it backs out one level at a time", () => {
    const items = [mainItem(), taskItem("st_a", "alpha")]
    const transcript = transcriptOf([turn("t1", "one")])
    const state: ViewerState = {
      ...selectedTask(items),
      focus: "transcript",
      selectedTurnId: "t1",
      expandedTurnId: "t1",
    }
    const collapsed = updateViewer(state, { type: "exit-level" }, context(items, transcript))
    expect(collapsed.expandedTurnId).toBeUndefined()
    expect(collapsed.focus).toBe("transcript")
    expect(collapsed.selectedTurnId).toBe("t1")
    const toTree = updateViewer(collapsed, { type: "exit-level" }, context(items, transcript))
    expect(toTree.focus).toBe("tree")
    expect(toTree.viewId).toBe("st_a")
    const toMain = updateViewer(toTree, { type: "exit-level" }, context(items, transcript))
    expect(toMain.viewId).toBe("main:main-1")
    expect(toMain.selectedTurnId).toBeUndefined()
  })

  test("#given a task without turns #when it is opened #then focus stays on the tree", () => {
    const items = [mainItem(), taskItem("st_a", "alpha")]
    const empty = transcriptOf([])
    let state = initialViewerState(items)
    state = updateViewer(state, { type: "open" }, context(items, empty))
    state = updateViewer(state, { type: "move", delta: 1 }, context(items, empty))
    state = updateViewer(state, { type: "open" }, context(items, empty))
    state = reconcileViewer(state, items, empty)
    expect(state.focus).toBe("tree")
    expect(state.selectedTurnId).toBeUndefined()
    expect(state.viewId).toBe("st_a")
  })

  test("#given transcript focus #when g is pressed #then the newest turn becomes the cursor", () => {
    const items = [mainItem(), taskItem("st_a", "alpha")]
    const transcript = transcriptOf([turn("t1", "one"), turn("t2", "two")])
    const state: ViewerState = { ...selectedTask(items), focus: "transcript", selectedTurnId: "t1" }
    expect(updateViewer(state, { type: "follow" }, context(items, transcript)).selectedTurnId).toBe("t2")
  })

  test("#given a task clicked in the tree #when it opens #then the transcript takes focus", () => {
    const items = [mainItem(), taskItem("st_a", "alpha")]
    const transcript = transcriptOf([turn("t1", "one")])
    const state = updateViewer(initialViewerState(items), { type: "open-item", id: "st_a" }, context(items, transcript))
    expect(state.viewId).toBe("st_a")
    expect(state.focus).toBe("transcript")
  })

  test("#given hidden completed tasks #when the tree renders #then they disappear, pinned rows stay, and movement skips them", () => {
    const runningItem: TaskTreeItem = {
      id: "st_b",
      kind: "task",
      rootSessionId: "main-1",
      depth: 1,
      task: record({ task_id: "st_b", name: "bravo", status: "running" }),
    }
    const items = [mainItem(), taskItem("st_a", "alpha"), runningItem]
    const transcript = transcriptOf([turn("t1", "one")])
    let state = updateViewer(initialViewerState(items), { type: "open" }, context(items, transcript))
    expect(state.expandedRoots).toEqual(["main-1"])
    state = updateViewer(state, { type: "toggle-filter", filter: "completed" }, context(items, transcript))
    expect(state.hiddenFilters).toEqual(["completed"])
    const frame = projectViewer(state, makeData(items, transcript), viewport())
    expect(frame.list.lines.some((line) => line.includes("alpha"))).toBe(false)
    expect(frame.list.lines.some((line) => line.includes("bravo"))).toBe(true)
    expect(frame.list.lines.slice(0, 2).join(" ")).toContain("–completed")
    const moved = updateViewer(state, { type: "move", delta: 1 }, context(items, transcript))
    expect(moved.selectedId).toBe("st_b")
    state = updateViewer({ ...state, hiddenFilters: ["completed"], selectedId: "st_a", viewId: "st_a" }, { type: "move", delta: 1 }, context(items, transcript))
    expect(state.selectedId).toBe("st_b")
  })

  test("#given a pinned completed task #when completed is hidden #then the row stays reachable", () => {
    const items = [mainItem(), taskItem("st_a", "alpha")]
    const transcript = transcriptOf([turn("t1", "one")])
    const state = updateViewer(
      { ...initialViewerState(items), selectedId: "st_a", viewId: "st_a" },
      { type: "toggle-filter", filter: "completed" },
      context(items, transcript),
    )
    const frame = projectViewer(state, makeData(items, transcript), viewport())
    expect(frame.list.lines.some((line) => line.includes("alpha"))).toBe(true)
  })

  test("#given a todo report #when focus cycles #then it walks tree, transcript and todo", () => {
    const items = [mainItem(), taskItem("st_a", "alpha")]
    const todoDocument = todoTranscript()
    let state = initialViewerState(items)
    state = updateViewer(state, { type: "cycle-focus" }, context(items, todoDocument))
    expect(state.focus).toBe("transcript")
    state = updateViewer(state, { type: "cycle-focus" }, context(items, todoDocument))
    expect(state.focus).toBe("todo")
    state = updateViewer(state, { type: "cycle-focus" }, context(items, todoDocument))
    expect(state.focus).toBe("tree")
  })

  test("#given todo focus #when arrows move #then the todo scrolls within its limits", () => {
    const items = [mainItem(), taskItem("st_a", "alpha")]
    const todoDocument = todoTranscript()
    const state: ViewerState = { ...selectedTask(items), focus: "todo" }
    const limits = projectViewer(state, makeData(items, todoDocument), viewport({ todoHeight: 2 })).limits
    expect(limits.todoScroll).toBeGreaterThan(0)
    const scrolled = updateViewer(state, { type: "move", delta: 1 }, context(items, todoDocument, limits))
    expect(scrolled.todoScroll).toBe(1)
    const clamped = updateViewer(state, { type: "move", delta: 99 }, context(items, todoDocument, limits))
    expect(clamped.todoScroll).toBe(limits.todoScroll)
    expect(clampViewer({ ...state, todoScroll: 99 }, limits).todoScroll).toBe(limits.todoScroll)
  })

  test("#given a todo report #when completed items are hidden #then only open items remain", () => {
    const items = [mainItem(), taskItem("st_a", "alpha")]
    const todoDocument = todoTranscript()
    const state = updateViewer(selectedTask(items), { type: "toggle-todo-done" }, context(items, todoDocument))
    expect(state.todoHideCompleted).toBe(true)
    const frame = projectViewer(state, makeData(items, todoDocument), viewport())
    expect(frame.todo?.lines.some((line) => line.includes("✓ Read the code"))).toBe(false)
    expect(frame.todo?.lines.some((line) => line.includes("● Build the widget"))).toBe(true)
  })

  test("#given turns #when a turn expands, steps, and closes #then the arrows walk turns and back returns to the tree", () => {
    const items = [mainItem(), taskItem("st_a", "alpha")]
    const transcript = transcriptOf([turn("t1", "one"), turn("t2", "two")])
    let state = selectedTask(items)
    state = updateViewer(state, { type: "toggle-turn" }, context(items, transcript))
    expect(state.expandedTurnId).toBe("t2")
    state = updateViewer(state, { type: "move", delta: -1 }, context(items, transcript))
    expect(state.expandedTurnId).toBe("t1")
    expect(state.selectedId).toBe("st_a")
    state = updateViewer(state, { type: "back" }, context(items, transcript))
    expect(state.expandedTurnId).toBeUndefined()
    expect(state.viewId).toBe("st_a")
    state = updateViewer(state, { type: "back" }, context(items, transcript))
    expect(state.viewId).toBe("main:main-1")
  })

  test("#given a clicked turn #when the same turn is clicked again #then the expansion closes", () => {
    const items = [mainItem(), taskItem("st_a", "alpha")]
    const transcript = transcriptOf([turn("t1", "one"), turn("t2", "two")])
    let state = updateViewer(selectedTask(items), { type: "expand-turn", id: "t1" }, context(items, transcript))
    expect(state.expandedTurnId).toBe("t1")
    state = updateViewer(state, { type: "expand-turn", id: "t1" }, context(items, transcript))
    expect(state.expandedTurnId).toBeUndefined()
    state = updateViewer(state, { type: "expand-turn", id: "missing" }, context(items, transcript))
    expect(state.expandedTurnId).toBeUndefined()
  })

  test("#given a root session with turns #when the newest turn expands #then root turns expand like task turns", () => {
    const items = [mainItem()]
    const transcript = transcriptOf([turn("root-1", "root output")])
    let state = initialViewerState(items)
    state = updateViewer(state, { type: "toggle-turn" }, context(items, transcript))
    expect(state.expandedTurnId).toBe("root-1")
    const frame = projectViewer(state, makeData(items, transcript), viewport({ detailHeight: 40 }))
    expect(frame.detail.lines.some((line) => line.includes("TURN 1 / 1"))).toBe(true)
    expect(frame.detail.lines.some((line) => line.includes("end of turn 1"))).toBe(true)
  })

  test("#given an unbounded scroll #when the transcript is taller than the pane #then the offset clamps and never blanks the view", () => {
    const items = [mainItem(), taskItem("st_a", "alpha")]
    const transcript = transcriptOf(Array.from({ length: 24 }, (_, index) => turn(`t${index}`, `turn ${index}`)))
    const data = makeData(items, transcript)
    const limits = projectViewer(selectedTask(items), data, viewport({ detailHeight: 16 })).limits
    expect(limits.transcriptScroll).toBeGreaterThan(0)

    let state = updateViewer(
      selectedTask(items),
      { type: "scroll-transcript", direction: "older", amount: 999 },
      context(items, transcript, limits),
    )
    expect(state.scrollOffset).toBe(limits.transcriptScroll)
    const scrolled = projectViewer(state, data, viewport({ detailHeight: 16 }))
    expect(scrolled.detail.lines.length).toBeGreaterThan(0)
    expect(scrolled.detail.lines.some((line) => line.includes("waiting"))).toBe(false)

    state = updateViewer(state, { type: "scroll-transcript", direction: "newer", amount: 999 }, context(items, transcript, limits))
    expect(state.scrollOffset).toBe(0)
  })

  test("#given a long turn body #when expanded #then the body extends the transcript scroll instead of a separate pane", () => {
    const items = [mainItem(), taskItem("st_a", "alpha")]
    const longTurn: TranscriptTurn = {
      id: "t1",
      thinking: Array.from({ length: 40 }, (_, index) => `thought ${index}`),
      parts: [],
      results: [],
    }
    const transcript = transcriptOf([longTurn])
    const data = makeData(items, transcript)
    const plain = projectViewer(selectedTask(items), data, viewport({ detailHeight: 20 })).limits.transcriptScroll
    const base: ViewerState = { ...selectedTask(items), expandedTurnId: "t1" }
    const frame = projectViewer(base, data, viewport({ detailHeight: 20 }))
    expect(frame.limits.transcriptScroll).toBeGreaterThan(plain)
    expect(frame.detail.lines.some((line) => line.includes("thought 39"))).toBe(true)
    const scrolled = updateViewer(
      base,
      { type: "scroll-transcript", direction: "older", amount: 999 },
      context(items, transcript, frame.limits),
    )
    expect(scrolled.scrollOffset).toBe(frame.limits.transcriptScroll)
    expect(projectViewer(scrolled, data, viewport({ detailHeight: 20 })).detail.lines.some((line) => line.includes("thought 0"))).toBe(true)
  })

  test("#given a viewed item that disappears #when reconciled #then the expansion closes with the fallback view", () => {
    const items = [mainItem(), taskItem("st_a", "alpha")]
    const transcript = transcriptOf([turn("t1", "one")])
    const state: ViewerState = { ...selectedTask(items, "st_a"), expandedTurnId: "t1" }
    const reconciled = reconcileViewer(state, [mainItem()], transcript)
    expect(reconciled.viewId).toBe("main:main-1")
    expect(reconciled.expandedTurnId).toBeUndefined()
  })

  test("#given a refreshed transcript without the expanded turn #when reconciled #then the expansion closes", () => {
    const items = [mainItem(), taskItem("st_a", "alpha")]
    const state: ViewerState = { ...selectedTask(items), expandedTurnId: "t1" }
    const reconciled = reconcileViewer(state, items, transcriptOf([turn("t2", "two")]))
    expect(reconciled.expandedTurnId).toBeUndefined()
  })

  test("#given a limit smaller than the stored offset #when clamped #then the offset clamps", () => {
    const state: ViewerState = {
      ...selectedTask([mainItem(), taskItem("st_a", "alpha")]),
      scrollOffset: 9,
    }
    expect(clampViewer(state, { transcriptScroll: 3, todoScroll: 0 }).scrollOffset).toBe(3)
  })
})

describe("viewer frame", () => {
  const items = [mainItem(), taskItem("st_a", "alpha")]
  const transcript = transcriptOf([turn("t1", "first"), turn("t2", "second")])

  test("#given a narrow list #when a task name wraps #then every visual row of the task hits the task", () => {
    const longName = "charlie-task-with-a-name-long-enough-to-wrap-across-many-lines"
    const wrappedItems = [mainItem(), taskItem("st_a", "alpha"), taskItem("st_b", "bravo"), taskItem("st_c", longName)]
    const state = selectedTask(wrappedItems, "st_c")
    const frame = projectViewer(state, makeData(wrappedItems, transcript), viewport({ listWidth: 20, listHeight: 16, detailWidth: 40, detailHeight: 16 }))
    const rows = frame.list.lines.map((line, index) => ({ line, hit: frame.list.hits[index] }))
    const charlie = rows.filter(({ hit }) => hit?.kind === "item" && hit.id === "st_c")
    expect(charlie.length).toBeGreaterThan(2)
    expect(charlie.map(({ line }) => line).join(" ")).toContain("charlie")
  })

  test("#given a wrapped transcript line #when projected #then every visual row keeps the source turn", () => {
    const longText = "word ".repeat(30).trim()
    const longTranscript = transcriptOf([turn("t1", longText)])
    const state = selectedTask(items)
    const frame = projectViewer(
      state,
      makeData(items, longTranscript),
      viewport({ detailWidth: 30, detailHeight: 24 }),
    )
    const turnRows = frame.detail.lines
      .map((line, index) => ({ line, hit: frame.detail.hits[index] }))
      .filter(({ hit }) => hit?.kind === "turn")
    expect(turnRows.length).toBeGreaterThan(2)
    expect(turnRows.every(({ hit }) => hit?.kind === "turn" && hit.id === "t1")).toBe(true)
    expect(turnRows.some(({ line }) => line.includes("assistant: word"))).toBe(true)
  })

  test("#given a click on a transcript row #when the row is later in the window #then the hit names the right turn", () => {
    const state = selectedTask(items)
    const frame = projectViewer(state, makeData(items, transcript), viewport({ detailWidth: 40, detailHeight: 24 }))
    const index = frame.detail.lines.findIndex((line) => line.includes("assistant: second"))
    expect(index).toBeGreaterThan(-1)
    expect(frame.detail.hits[index]).toEqual({ kind: "turn", id: "t2" })
  })

  test("#given an expanded turn #when projected #then its body sits inline after that turn and before the next", () => {
    const state: ViewerState = { ...selectedTask(items), expandedTurnId: "t1" }
    const frame = projectViewer(state, makeData(items, transcript), viewport({ detailWidth: 40, detailHeight: 40 }))
    const lines = frame.detail.lines
    const first = lines.findIndex((line) => line.includes("assistant: first"))
    const header = lines.findIndex((line) => line.includes("TURN 1 / 2"))
    const end = lines.findIndex((line) => line.includes("end of turn 1"))
    const second = lines.findIndex((line) => line.includes("assistant: second"))
    expect(first).toBeGreaterThan(-1)
    expect(first).toBeLessThan(header)
    expect(header).toBeLessThan(end)
    expect(end).toBeLessThan(second)
  })

  test("#given an expanded turn #when a row of its body is clicked #then the hit still names that turn", () => {
    const state: ViewerState = { ...selectedTask(items), expandedTurnId: "t1" }
    const frame = projectViewer(state, makeData(items, transcript), viewport({ detailWidth: 40, detailHeight: 40 }))
    const index = frame.detail.lines.findIndex((line) => line.includes("end of turn 1"))
    expect(index).toBeGreaterThan(-1)
    expect(frame.detail.hits[index]).toEqual({ kind: "turn", id: "t1" })
  })

  test("#given an expanded turn with an image result #when projected #then preview cells sit inside the turn block", () => {
    const imageTranscript = transcriptOf([turn("t1", "first"), imageTurn("t2")])
    const state: ViewerState = { ...selectedTask(items), expandedTurnId: "t2" }
    const frame = projectViewer(state, makeData(items, imageTranscript), viewport({ detailWidth: 40, detailHeight: 40 }))
    const caption = frame.detail.lines.findIndex((line) => line.includes("IMAGE 4x2 image/png"))
    expect(caption).toBeGreaterThan(-1)
    expect(frame.detail.lines[caption + 1]).toBe("▀▀▀▀")
    expect(frame.detail.cells?.[caption + 1]?.map((cell) => cell.text).join("")).toBe("▀▀▀▀")
    expect(frame.detail.cells?.[caption + 1]?.map((cell) => cell.fg)).toEqual([
      "#ff0000",
      "#ff0000",
      "#ff0000",
      "#ff0000",
    ])
    expect(frame.detail.styles?.[caption]?.fg).toBe("#cba6f7")
    expect(frame.detail.styles?.[caption]?.rail).toBe(true)
    const end = frame.detail.lines.findIndex((line) => line.includes("end of turn 2"))
    expect(caption).toBeLessThan(end)
    const collapsed = projectViewer(selectedTask(items), makeData(items, imageTranscript), viewport({ detailWidth: 40, detailHeight: 40 }))
    expect(collapsed.detail.lines.some((line) => line.includes("IMAGE 4x2"))).toBe(false)
    expect(collapsed.detail.cells).toBeUndefined()
  })

  test("#given transcript focus #when a turn is selected but closed #then it carries the rail and the footer offers expand", () => {
    const state: ViewerState = { ...selectedTask(items), focus: "transcript", selectedTurnId: "t1" }
    const frame = projectViewer(state, makeData(items, transcript), viewport({ detailWidth: 40, detailHeight: 30 }))
    const firstRow = frame.detail.lines.findIndex((line) => line.includes("assistant: first"))
    const secondRow = frame.detail.lines.findIndex((line) => line.includes("assistant: second"))
    expect(frame.detail.styles?.[firstRow]).toMatchObject({ rail: true, bg: "#141d33", fg: "#a5d6ff" })
    expect(frame.detail.styles?.[secondRow]?.rail).toBeUndefined()
    expect(frame.detail.lines.some((line) => line.includes("TURN 1 / 2"))).toBe(false)
    expect(frame.footer).toContain("enter expand")
    expect(frame.footer).not.toContain("TURN 1/2")
    expect(projectViewer(selectedTask(items), makeData(items, transcript), viewport()).footer).toContain("enter/→ turns")
  })

  test("#given an expanded turn #when projected #then its rows carry the pointer rail and other turns do not", () => {
    const pointerTranscript = transcriptOf([turn("t1", "first"), turn("t2", "second")])
    const state: ViewerState = { ...selectedTask(items), expandedTurnId: "t1" }
    const frame = projectViewer(state, makeData(items, pointerTranscript), viewport({ detailWidth: 40, detailHeight: 40 }))
    const firstRow = frame.detail.lines.findIndex((line) => line.includes("assistant: first"))
    const secondRow = frame.detail.lines.findIndex((line) => line.includes("assistant: second"))
    const headerRow = frame.detail.lines.findIndex((line) => line.includes("TURN 1 / 2"))
    expect(frame.detail.styles?.[firstRow]).toMatchObject({ rail: true, bg: "#141d33", fg: "#a5d6ff" })
    expect(frame.detail.styles?.[headerRow]).toMatchObject({ rail: true, fg: "#8be9fd", bold: true })
    expect(frame.detail.styles?.[secondRow]?.rail).toBeUndefined()
    expect(frame.footer).toStartWith("TURN 1/2")
    expect(frame.footer).not.toContain("l todo")
  })

  test("#given transcript kinds #when projected #then thinking, assistant, tool and result rows each get a color", () => {
    const kindsTranscript = transcriptOf([
      {
        id: "k1",
        thinking: ["ponder"],
        parts: [
          { kind: "text", text: "hello" },
          { kind: "call", call: { name: "read", arguments: { path: "/tmp/x" } } },
        ],
        results: [{ name: "read", isError: false, text: "ok" }],
      },
    ])
    const frame = projectViewer(selectedTask(items), makeData(items, kindsTranscript), viewport({ detailWidth: 60, detailHeight: 30 }))
    const styleOf = (needle: string) => frame.detail.styles?.[frame.detail.lines.findIndex((line) => line.includes(needle))]
    expect(styleOf("thinking:")?.fg).toBe("#7c8aa5")
    expect(styleOf("thinking:")?.dim).toBe(true)
    expect(styleOf("assistant: hello")?.fg).toBe("#a5d6ff")
    expect(styleOf("tool: read")?.fg).toBe("#e0af68")
    expect(styleOf("result(read)")?.fg).toBe("#9ece6a")
  })

  test("#given a selected tree row #when projected #then the row is highlighted and its status is colored", () => {
    const frame = projectViewer(selectedTask(items), makeData(items, transcript), viewport())
    const taskRow = frame.list.lines.findIndex((line) => line.includes("alpha"))
    const metaRow = taskRow + 1
    const mainRow = frame.list.lines.findIndex((line) => line.includes("Main session"))
    const titleRow = frame.list.lines.findIndex((line) => line.includes("SESSION / AGENT TREE"))
    expect(frame.list.styles?.[taskRow]).toMatchObject({ fg: "#9ece6a", bg: "#1b2a4a", bold: true })
    expect(frame.list.cells?.[taskRow]?.[0]).toMatchObject({ text: "› ", bg: RAIL_COLOR, bold: true })
    expect(frame.list.cells?.[taskRow]?.[1]).toMatchObject({ bg: "#1b2a4a", fg: "#9ece6a", bold: true })
    expect(frame.list.cells?.[metaRow]?.[0]).toMatchObject({ bg: RAIL_COLOR })
    expect(frame.list.cells?.[mainRow]).toBeUndefined()
    expect(frame.list.styles?.[mainRow]?.fg).toBe("#8be9fd")
    expect(frame.list.styles?.[titleRow]).toMatchObject({ fg: "#8be9fd", bold: true })
  })

  test("#given a transcript with a todo report #when projected #then the checklist gets its own pane below the panes", () => {
    const todoDocument = todoTranscript()
    const frame = projectViewer(selectedTask(items), makeData(items, todoDocument), viewport())
    expect(frame.todo).toBeDefined()
    expect(frame.todo?.lines[0]).toContain("TODO 1/3")
    expect(frame.todo?.lines[0]).toContain("Now: Build the widget (Build)")
    expect(frame.todo?.styles?.[0]).toMatchObject({ fg: "#8be9fd", bold: true })
    expect(frame.todo?.lines.some((line) => line.includes("Next: Test the widget"))).toBe(true)
    expect(frame.todo?.lines.some((line) => line.includes("Setup  1/1"))).toBe(true)
    expect(frame.todo?.lines.some((line) => line.includes("✓ Read the code"))).toBe(true)
    expect(frame.todo?.lines.some((line) => line.includes("● Build the widget"))).toBe(true)
    expect(frame.detail.lines.some((line) => line.includes("TODO"))).toBe(false)
    expect(frame.footer).toContain("l hide todo")
  })

  test("#given a todo report #when l toggles the pane #then it hides and returns", () => {
    const todoDocument = todoTranscript()
    let state = updateViewer(selectedTask(items), { type: "toggle-todo" }, context(items, todoDocument))
    expect(state.todoVisible).toBe(false)
    let frame = projectViewer(state, makeData(items, todoDocument), viewport())
    expect(frame.todo).toBeUndefined()
    expect(frame.footer).toContain("l todo")
    state = updateViewer(state, { type: "toggle-todo" }, context(items, todoDocument))
    expect(state.todoVisible).toBe(true)
    frame = projectViewer(state, makeData(items, todoDocument), viewport())
    expect(frame.todo).toBeDefined()
  })

  test("#given no todo report #when the todo pane toggles #then the state is unchanged", () => {
    const state = updateViewer(selectedTask(items), { type: "toggle-todo" }, context(items, transcript))
    expect(state.todoVisible).toBe(true)
    expect(projectViewer(state, makeData(items, transcript), viewport()).todo).toBeUndefined()
  })

  test("#given a short todo pane #when projected #then completed items give way to open ones", () => {
    const frame = projectViewer(selectedTask(items), makeData(items, todoTranscript()), viewport({ todoHeight: 4 }))
    expect(frame.todo?.lines.some((line) => line.includes("✓ Read the code"))).toBe(false)
    expect(frame.todo?.lines.some((line) => line.includes("● Build the widget"))).toBe(true)
    expect(frame.todo?.lines.some((line) => line.includes("○ Test the widget"))).toBe(true)
  })

  test("#given a tiny todo pane #when projected #then the list scrolls with a position hint", () => {
    const frame = projectViewer(selectedTask(items), makeData(items, todoTranscript()), viewport({ todoHeight: 2 }))
    expect(frame.todo?.lines).toHaveLength(3)
    expect(frame.todo?.lines.at(-1)).toContain("scroll")
    expect(frame.limits.todoScroll).toBeGreaterThan(0)
  })

  test("#given the transcript focus #when projected #then the turn rail is active blue and the tree rail is inactive", () => {
    const state: ViewerState = { ...selectedTask(items), focus: "transcript", selectedTurnId: "t1" }
    const frame = projectViewer(state, makeData(items, transcript), viewport())
    const turnRow = frame.detail.lines.findIndex((line) => line.includes("assistant: first"))
    const taskRow = frame.list.lines.findIndex((line) => line.includes("alpha"))
    expect(frame.detail.styles?.[turnRow]?.railColor).toBe(RAIL_COLOR)
    expect(frame.list.cells?.[taskRow]?.[0]?.bg).toBe(RAIL_INACTIVE)
    const treeState: ViewerState = { ...selectedTask(items), selectedTurnId: "t1" }
    const treeFrame = projectViewer(treeState, makeData(items, transcript), viewport())
    const treeTurnRow = treeFrame.detail.lines.findIndex((line) => line.includes("assistant: first"))
    const treeTaskRow = treeFrame.list.lines.findIndex((line) => line.includes("alpha"))
    expect(treeFrame.detail.styles?.[treeTurnRow]?.railColor).toBe(RAIL_INACTIVE)
    expect(treeFrame.list.cells?.[treeTaskRow]?.[0]?.bg).toBe(RAIL_COLOR)
  })

  test("#given a middle turn expanded in a long transcript #when the focus offset is applied #then that turn starts at the top of the pane", () => {    const many = transcriptOf(Array.from({ length: 30 }, (_, index) => turn(`t${index}`, `turn ${index}`)))
    const data = makeData(items, many)
    const state: ViewerState = { ...selectedTask(items), expandedTurnId: "t10" }
    const frame = projectViewer(state, data, viewport({ detailWidth: 40, detailHeight: 16 }))
    expect(frame.focusOffset).toBeDefined()
    expect(frame.focusOffset).toBeGreaterThan(0)
    expect(frame.detail.lines.some((line) => line.includes("TURN 11 / 30"))).toBe(false)
    const focused = projectViewer({ ...state, scrollOffset: frame.focusOffset! }, data, viewport({ detailWidth: 40, detailHeight: 16 }))
    const lines = focused.detail.lines
    const transcriptLine = lines.findIndex((line) => line.includes("TRANSCRIPT"))
    expect(transcriptLine).toBeGreaterThan(-1)
    expect(lines[transcriptLine + 2]).toContain("assistant: turn 10")
    expect(lines[transcriptLine + 3]).toContain("TURN 11 / 30")
  })
})

describe("wrapText", () => {
  test("#given prose #when wrapped #then it prefers word boundaries and preserves newlines", () => {
    expect(wrapText("one two three", 7)).toEqual(["one two", "three"])
    expect(wrapText("abcdefgh", 3)).toEqual(["abc", "def", "gh"])
    expect(wrapText("a\nb", 10)).toEqual(["a", "b"])
    expect(wrapText("", 10)).toEqual([""])
  })
})
