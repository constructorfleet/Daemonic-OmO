import {
  initialNavigation,
  moveSelection,
  moveTurn,
  openSelection,
  reconcileNavigation,
  returnToMain,
  visibleNavigationItems,
  type NavigationState,
} from "./navigation.js"
import type { TaskRecord, TaskTreeItem } from "./state.js"
import { previewImage, type PreviewCell } from "./image-preview.js"
import {
  formatTurnBody,
  safeText,
  summarizeTurn,
  type TodoItem,
  type TodoState,
  type TodoStatus,
  type TranscriptDocument,
  type TranscriptTurn,
} from "./transcript.js"

export type ViewerFocus = "tree" | "transcript" | "todo"

export type TaskFilter = "completed" | "running" | "stopped"

export interface ViewerState extends NavigationState {
  readonly focus: ViewerFocus
  /** Turn under the transcript cursor. */
  readonly selectedTurnId?: string
  /** Turn whose body is expanded inline in the transcript. */
  readonly expandedTurnId?: string
  readonly todoVisible: boolean
  readonly todoHideCompleted: boolean
  readonly todoScroll: number
  readonly hiddenFilters: readonly TaskFilter[]
  /** Main-session roots whose subagent tasks are expanded in the tree. */
  readonly expandedRoots: readonly string[]
  readonly paused: boolean
}

export interface ViewerLimits {
  readonly transcriptScroll: number
  readonly todoScroll: number
}

export interface ViewerData {
  readonly items: readonly TaskTreeItem[]
  readonly transcript: TranscriptDocument
  readonly projectDir: string
  readonly refreshMs: number
  readonly invalidRecords: number
  readonly error?: string
}

export interface ViewerViewport {
  readonly listWidth: number
  readonly listHeight: number
  readonly detailWidth: number
  readonly detailHeight: number
  readonly todoWidth: number
  readonly todoHeight: number
}

export type ViewerHit =
  | { readonly kind: "item"; readonly id: string }
  | { readonly kind: "turn"; readonly id: string }

export interface PaneFrame {
  readonly lines: readonly string[]
  readonly hits: readonly (ViewerHit | undefined)[]
  /** Parallel to `lines`; present only for rows with styled image cells. */
  readonly cells?: readonly (readonly PreviewCell[] | undefined)[]
  /** Parallel to `lines`; absent entries render with the pane default. */
  readonly styles?: readonly (RowStyle | undefined)[]
}

export interface RowStyle {
  readonly fg?: string
  readonly bg?: string
  readonly dim?: boolean
  readonly bold?: boolean
  /** Paints a two-column accent rail before the row text; that text is wrapped two columns narrower. */
  readonly rail?: boolean
  readonly railColor?: string
}

export const RAIL_COLOR = "#7aa2f7"
export const RAIL_INACTIVE = "#8a94a8"

const STYLE = {
  accent: "#8be9fd",
  assistant: "#a5d6ff",
  thinking: "#7c8aa5",
  tool: "#e0af68",
  result: "#9ece6a",
  error: "#f7768e",
  image: "#cba6f7",
  text: "#cbd5e1",
  meta: "#7c8aa5",
  turnBg: "#141d33",
  selectedBg: "#1b2a4a",
} as const

export interface ViewerFrame {
  readonly header: string
  readonly footer: string
  readonly list: PaneFrame
  readonly detail: PaneFrame
  readonly limits: ViewerLimits
  /** Scroll offset that puts the expanded turn at the top of the detail pane. */
  readonly focusOffset?: number
  readonly todo?: PaneFrame
}

export type ViewerInput =
  | { readonly type: "move"; readonly delta: number }
  | { readonly type: "move-selection"; readonly delta: number }
  | { readonly type: "open" }
  | { readonly type: "open-item"; readonly id: string }
  | { readonly type: "exit-level" }
  | { readonly type: "back" }
  | { readonly type: "cycle-focus" }
  | { readonly type: "set-focus"; readonly focus: ViewerFocus }
  | { readonly type: "toggle-filter"; readonly filter: TaskFilter }
  | { readonly type: "toggle-todo-done" }
  | { readonly type: "toggle-turn" }
  | { readonly type: "toggle-todo" }
  | { readonly type: "expand-turn"; readonly id: string }
  | { readonly type: "scroll-transcript"; readonly direction: "older" | "newer"; readonly amount: number }
  | { readonly type: "follow" }
  | { readonly type: "set-paused"; readonly paused: boolean }
  | { readonly type: "toggle-pause" }

export interface ViewerContext {
  readonly items: readonly TaskTreeItem[]
  readonly transcript: TranscriptDocument
  readonly limits: ViewerLimits
}

export const EMPTY_TRANSCRIPT: TranscriptDocument = { lines: [], lineTurns: [], turns: [] }
const ZERO_LIMITS: ViewerLimits = { transcriptScroll: 0, todoScroll: 0 }

export function initialViewerState(items: readonly TaskTreeItem[]): ViewerState {
  return {
    ...initialNavigation(items),
    focus: "tree",
    todoVisible: true,
    todoHideCompleted: false,
    todoScroll: 0,
    hiddenFilters: [],
    expandedRoots: [],
    paused: false,
  }
}

export function updateViewer(state: ViewerState, input: ViewerInput, context: ViewerContext): ViewerState {
  const turns = context.transcript.turns
  const list = visibleTaskItems(state, context.items)
  switch (input.type) {
    case "move":
      if (state.focus === "todo") return scrollTodo(state, input.delta, context.limits.todoScroll)
      return state.focus === "transcript"
        ? moveTurnCursor(state, input.delta, turns)
        : moveSelection(state, input.delta, list)
    case "move-selection":
      return moveSelection(state, input.delta, list)
    case "open": {
      if (state.focus === "todo") return state
      if (state.focus === "transcript") return toggleSelectedTurn(state, turns)
      const selected = context.items.find((item) => item.id === state.selectedId)
      if (selected?.kind === "main") return toggleExpandedRoot(state, selected.rootSessionId)
      return enterTranscript(openSelection(state, context.items))
    }
    case "open-item": {
      if (!context.items.some((item) => item.id === input.id)) return state
      return enterTranscript(openSelection({ ...state, selectedId: input.id }, context.items))
    }
    case "exit-level":
      if (state.expandedTurnId !== undefined) return { ...state, expandedTurnId: undefined }
      return state.focus === "tree" ? exitToMain(state, context.items) : { ...state, focus: "tree" }
    case "back":
      return state.expandedTurnId !== undefined
        ? { ...state, expandedTurnId: undefined }
        : exitToMain(state, context.items)
    case "cycle-focus":
      return { ...state, focus: nextFocus(state, context.transcript) }
    case "set-focus": {
      if (input.focus === "todo" && (context.transcript.todo === undefined || !state.todoVisible)) return state
      if (input.focus === "transcript" && turns.length === 0) return state
      return { ...state, focus: input.focus }
    }
    case "toggle-filter": {
      const hiddenFilters = state.hiddenFilters.includes(input.filter)
        ? state.hiddenFilters.filter((filter) => filter !== input.filter)
        : [...state.hiddenFilters, input.filter]
      return { ...state, hiddenFilters }
    }
    case "toggle-todo-done":
      return context.transcript.todo === undefined
        ? state
        : { ...state, todoHideCompleted: !state.todoHideCompleted, todoScroll: 0 }
    case "toggle-todo": {
      if (context.transcript.todo === undefined) return state
      const todoVisible = !state.todoVisible
      return {
        ...state,
        todoVisible,
        focus: !todoVisible && state.focus === "todo" ? "tree" : state.focus,
      }
    }
    case "toggle-turn": {
      if (state.expandedTurnId !== undefined) return { ...state, expandedTurnId: undefined }
      const newest = turns.at(-1)
      if (newest === undefined) return state
      return { ...state, focus: "transcript", selectedTurnId: newest.id, expandedTurnId: newest.id }
    }
    case "expand-turn": {
      if (!turns.some((turn) => turn.id === input.id)) return state
      return {
        ...state,
        focus: "transcript",
        selectedTurnId: input.id,
        expandedTurnId: state.expandedTurnId === input.id ? undefined : input.id,
      }
    }
    case "scroll-transcript": {
      const amount = Math.max(0, input.amount)
      const delta = input.direction === "older" ? amount : -amount
      if (state.focus === "todo") return scrollTodo(state, delta, context.limits.todoScroll)
      return { ...state, scrollOffset: clamp(state.scrollOffset + delta, 0, context.limits.transcriptScroll) }
    }
    case "follow": {
      const newest = turns.at(-1)
      if (newest === undefined) return { ...state, scrollOffset: 0 }
      if (state.expandedTurnId !== undefined) {
        return { ...state, scrollOffset: 0, selectedTurnId: newest.id, expandedTurnId: newest.id }
      }
      return state.focus === "transcript"
        ? { ...state, scrollOffset: 0, selectedTurnId: newest.id }
        : { ...state, scrollOffset: 0 }
    }
    case "set-paused":
      return { ...state, paused: input.paused }
    case "toggle-pause":
      return { ...state, paused: !state.paused }
  }
}

function enterTranscript<S extends ViewerState>(state: S): S {
  return { ...state, focus: "transcript", selectedTurnId: undefined, expandedTurnId: undefined }
}

function toggleExpandedRoot<S extends ViewerState>(state: S, rootSessionId: string): S {
  const expandedRoots = state.expandedRoots.includes(rootSessionId)
    ? state.expandedRoots.filter((root) => root !== rootSessionId)
    : [...state.expandedRoots, rootSessionId]
  return { ...state, expandedRoots, scrollOffset: 0 }
}

function nextFocus(state: ViewerState, transcript: TranscriptDocument): ViewerFocus {
  const hasTurns = transcript.turns.length > 0
  const hasTodo = transcript.todo !== undefined && state.todoVisible
  if (state.focus === "tree") {
    if (hasTurns) return "transcript"
    return hasTodo ? "todo" : "tree"
  }
  if (state.focus === "transcript") return hasTodo ? "todo" : "tree"
  return "tree"
}

function scrollTodo<S extends ViewerState>(state: S, delta: number, maxScroll: number): S {
  const todoScroll = clamp(state.todoScroll + delta, 0, Math.max(0, maxScroll))
  return todoScroll === state.todoScroll ? state : { ...state, todoScroll }
}

function filterGroup(status: string): TaskFilter | undefined {
  if (status === "completed") return "completed"
  if (status === "running" || status === "pending") return "running"
  if (status === "paused" || status === "interrupted" || status === "cancelled") return "stopped"
  return undefined
}

/** Items shown in the tree: collapsed main rows hide their subagents, and filtered groups disappear. */
export function visibleTaskItems(state: ViewerState, items: readonly TaskTreeItem[]): readonly TaskTreeItem[] {
  const expanded = new Set(state.expandedRoots)
  const selected = items.find((item) => item.id === state.selectedId)
  if (selected?.kind === "task") expanded.add(selected.rootSessionId)
  const hidden = new Set(state.hiddenFilters)
  return items.filter((item) => {
    if (item.kind === "main") return true
    if (!expanded.has(item.rootSessionId)) return false
    if (hidden.size === 0) return true
    if (item.id === state.selectedId || item.id === state.viewId) return true
    const group = filterGroup(item.task?.status ?? "")
    return group === undefined || !hidden.has(group)
  })
}

function exitToMain(state: ViewerState, items: readonly TaskTreeItem[]): ViewerState {
  return {
    ...returnToMain(state, items),
    focus: "tree",
    selectedTurnId: undefined,
    expandedTurnId: undefined,
  }
}

function moveTurnCursor(state: ViewerState, delta: number, turns: readonly TranscriptTurn[]): ViewerState {
  const turn = moveTurn(turns, state.selectedTurnId, delta)
  if (turn === undefined) return state
  return {
    ...state,
    selectedTurnId: turn.id,
    ...(state.expandedTurnId === undefined ? {} : { expandedTurnId: turn.id }),
  }
}

function toggleSelectedTurn(state: ViewerState, turns: readonly TranscriptTurn[]): ViewerState {
  const turn = turns.find((entry) => entry.id === state.selectedTurnId) ?? turns.at(-1)
  if (turn === undefined) return state
  return {
    ...state,
    selectedTurnId: turn.id,
    expandedTurnId: state.expandedTurnId === turn.id ? undefined : turn.id,
  }
}

export function reconcileViewer(
  state: ViewerState,
  items: readonly TaskTreeItem[],
  transcript?: TranscriptDocument,
): ViewerState {
  const { focus, selectedTurnId, expandedTurnId, expandedRoots, ...rest } = state
  const navigation = reconcileNavigation(rest, items)
  const roots = new Set(items.filter((item) => item.kind === "main").map((item) => item.rootSessionId))
  const keptRoots = expandedRoots.filter((root) => roots.has(root))
  const viewed = viewedItem(navigation, items)
  const viewChanged = navigation.viewId !== state.viewId
  const known = (id: string | undefined): id is string =>
    id !== undefined && (transcript === undefined || transcript.turns.some((turn) => turn.id === id))
  const nextFocus: ViewerFocus = focus === "transcript" && viewed !== undefined && (transcript === undefined || transcript.turns.length > 0)
    ? "transcript"
    : focus === "todo" && viewed !== undefined && state.todoVisible && (transcript === undefined || transcript.todo !== undefined)
      ? "todo"
      : "tree"
  const cursorFocus = nextFocus !== "tree"
  const keepSelection = cursorFocus && !viewChanged && known(selectedTurnId)
  const keepExpansion = nextFocus === "transcript" && !viewChanged && known(expandedTurnId)
  const expanded = keepExpansion ? expandedTurnId : undefined
  const selected = expanded
    ?? (keepSelection ? selectedTurnId : nextFocus === "transcript" ? newestTurnId(transcript) : undefined)
  return {
    ...navigation,
    focus: nextFocus,
    expandedRoots: keptRoots,
    ...(selected === undefined ? {} : { selectedTurnId: selected }),
    ...(expanded === undefined ? {} : { expandedTurnId: expanded }),
    scrollOffset: Math.max(0, navigation.scrollOffset),
  }
}

function newestTurnId(transcript: TranscriptDocument | undefined): string | undefined {
  return transcript === undefined ? undefined : transcript.turns.at(-1)?.id
}

export function clampViewer(state: ViewerState, limits: ViewerLimits): ViewerState {
  const scrollOffset = clamp(state.scrollOffset, 0, limits.transcriptScroll)
  const todoScroll = clamp(state.todoScroll, 0, Math.max(0, limits.todoScroll))
  if (scrollOffset === state.scrollOffset && todoScroll === state.todoScroll) return state
  return { ...state, scrollOffset, todoScroll }
}

export function viewedItem(state: { readonly viewId?: string }, items: readonly TaskTreeItem[]): TaskTreeItem | undefined {
  return items.find((item) => item.id === state.viewId)
}

export function projectViewer(
  state: ViewerState,
  data: ViewerData,
  viewport: ViewerViewport,
  now = Date.now(),
): ViewerFrame {
  const selected = data.items.find((item) => item.id === state.selectedId)
  const selectedRootExpanded = selected?.kind === "main" && state.expandedRoots.includes(selected.rootSessionId)
  const viewed = viewedItem(state, data.items)
  const expanded = state.expandedTurnId !== undefined
    && data.transcript.turns.some((turn) => turn.id === state.expandedTurnId)
  const hasTurns = data.transcript.turns.length > 0
  const listRail = state.focus === "tree" ? RAIL_COLOR : RAIL_INACTIVE
  const turnRail = state.focus === "transcript" ? RAIL_COLOR : RAIL_INACTIVE
  const header = `OMO AGENTS  •  ${safeText(data.projectDir)}  •  ${state.paused ? "paused" : `refresh ${data.refreshMs}ms`}${data.invalidRecords > 0 ? `  •  ${data.invalidRecords} unreadable` : ""}`
  const expandedIndex = expanded ? data.transcript.turns.findIndex((turn) => turn.id === state.expandedTurnId) : -1
  const todo = data.transcript.todo
  const todoHint = todo === undefined ? "" : (state.todoVisible ? "l hide todo  " : "l todo  ")
  const tabTarget = todo !== undefined && state.todoVisible ? "todo" : "tree"
  const treeAction = selected?.kind === "main"
    ? `enter/→ ${selectedRootExpanded ? "collapse" : "expand"}   o open`
    : hasTurns
      ? "enter/→ turns"
      : "enter follow"
  const footer = expanded
    ? `TURN ${expandedIndex + 1}/${data.transcript.turns.length}   ↑/↓ turn   enter/← close   j/k scroll   ${todoHint}p pause   r refresh   q quit`
    : state.focus === "todo" && todo !== undefined
      ? `TODO ${todo.done}/${todo.total}   ↑/↓ scroll   ${state.todoHideCompleted ? "4 show done" : "4 hide done"}   ← back   tab next   l hide   p pause   q quit`
      : state.focus === "transcript" && hasTurns
        ? `↑/↓ turn   enter expand   ← back   tab ${tabTarget}   t newest   1/2/3 filter   ${todoHint}p pause   q quit`
        : `↑/↓ select   ${treeAction}   1/2/3 filter   tab ${tabTarget}   ${todoHint}esc main   p pause   r refresh   q quit`
  const list = projectList(
    visibleTaskItems(state, data.items),
    state.selectedId,
    viewport.listWidth,
    viewport.listHeight,
    now,
    listRail,
    state.hiddenFilters,
    state.expandedRoots,
  )
  const detail = projectDetail(state, data, selected, viewed, viewport, now, turnRail)
  const todoPane = state.todoVisible && todo !== undefined
    ? projectTodoPane(todo, viewport.todoWidth, viewport.todoHeight, state.todoScroll, state.todoHideCompleted)
    : undefined
  return {
    header,
    footer,
    list,
    detail: detail.frame,
    limits: { transcriptScroll: detail.limits.transcriptScroll, todoScroll: todoPane?.maxScroll ?? 0 },
    ...(detail.focusOffset === undefined ? {} : { focusOffset: detail.focusOffset }),
    ...(todoPane === undefined ? {} : { todo: todoPane.frame }),
  }
}

interface PaneProjection {
  readonly frame: PaneFrame
  readonly limits: ViewerLimits
  readonly focusOffset?: number
}

function projectList(
  items: readonly TaskTreeItem[],
  selectedId: string | undefined,
  width: number,
  height: number,
  now: number,
  railColor: string,
  hiddenFilters: readonly TaskFilter[],
  expandedRoots: readonly string[],
): PaneFrame {
  const maxWidth = Math.max(1, Math.floor(width))
  const maxHeight = Math.max(1, Math.floor(height))
  if (items.length === 0) {
    const lines = wrapText("SESSION / AGENT TREE\n\nNo task records yet.\nKeep this view open while OmO delegates.", maxWidth).slice(0, maxHeight)
    return {
      lines,
      hits: lines.map(() => undefined),
      styles: lines.map((line, index) =>
        index === 0 ? { fg: STYLE.accent, bold: true } : { fg: STYLE.thinking },
      ),
    }
  }

  const rendered = new Map<string, { readonly rows: readonly StyledLine[]; readonly hit: ViewerHit }>()
  for (const item of items) {
    const hit: ViewerHit = { kind: "item", id: item.id }
    const selected = item.id === selectedId
    const logical = describeItem(item, selected, now, expandedRoots)
    const rows = logical.flatMap((line) =>
      wrapText(line.text, maxWidth).map((text, index) =>
        selected && index === 0 ? markSelectedTaskRow(text, line.style, railColor) : { text, style: line.style },
      ),
    )
    rendered.set(item.id, { rows, hit })
  }
  const itemCost = (item: TaskTreeItem): number => rendered.get(item.id)?.rows.length ?? 1
  const title: StyledLine[] = wrapText(
    hiddenFilters.length === 0 ? "SESSION / AGENT TREE" : `SESSION / AGENT TREE   –${hiddenFilters.join(" –")}`,
    maxWidth,
  ).map((text) => ({
    text,
    style: { fg: STYLE.accent, bold: true },
  }))
  const visibleItems = visibleNavigationItems(items, selectedId, Math.max(1, maxHeight - title.length - 4), itemCost)
  const firstIndex = items.findIndex((item) => item.id === visibleItems[0]?.id)
  const lastIndex = firstIndex + visibleItems.length
  const rows: StyledLine[] = [...title]
  const hits: (ViewerHit | undefined)[] = title.map(() => undefined)
  const hasCells = visibleItems.some((item) => rendered.get(item.id)?.rows.some((row) => row.cells !== undefined) === true)
  const cells: (readonly PreviewCell[] | undefined)[] = title.map(() => undefined)
  if (firstIndex > 0) {
    const indicator = wrapText("↑ more above", maxWidth).map((text) => ({ text, style: { fg: STYLE.meta, dim: true } }))
    rows.push(...indicator)
    hits.push(...indicator.map(() => undefined))
    cells.push(...indicator.map(() => undefined))
  }
  for (const item of visibleItems) {
    const entry = rendered.get(item.id)
    if (entry === undefined) continue
    rows.push(...entry.rows)
    hits.push(...entry.rows.map(() => entry.hit))
    cells.push(...entry.rows.map((row) => row.cells))
  }
  if (lastIndex < items.length) {
    const indicator = wrapText("↓ more below", maxWidth).map((text) => ({ text, style: { fg: STYLE.meta, dim: true } }))
    rows.push(...indicator)
    hits.push(...indicator.map(() => undefined))
    cells.push(...indicator.map(() => undefined))
  }
  return {
    lines: rows.slice(0, maxHeight).map((row) => row.text),
    hits: hits.slice(0, maxHeight),
    styles: rows.slice(0, maxHeight).map((row) => row.style),
    ...(hasCells ? { cells: cells.slice(0, maxHeight) } : {}),
  }
}

function markSelectedTaskRow(text: string, style: RowStyle | undefined, railColor: string): StyledLine {
  return {
    text,
    style,
    cells: [
      { text: text.slice(0, 2), fg: "#0b1020", bg: railColor, bold: true },
      {
        text: text.slice(2),
        bg: STYLE.selectedBg,
        ...(style?.fg === undefined ? {} : { fg: style.fg }),
        ...(style?.bold === true ? { bold: true } : {}),
        ...(style?.dim === true ? { dim: true } : {}),
      },
    ],
  }
}

interface StyledLine {
  readonly text: string
  readonly style?: RowStyle
  readonly cells?: readonly PreviewCell[]
}

function statusColor(status: string): string {
  if (status === "running") return STYLE.tool
  if (status === "completed") return STYLE.result
  if (status === "error" || status === "lost") return STYLE.error
  return STYLE.thinking
}

function describeItem(
  item: TaskTreeItem,
  selected: boolean,
  now: number,
  expandedRoots: readonly string[],
): readonly StyledLine[] {
  const prefix = selected ? "› " : "  "
  const selection: RowStyle | undefined = selected ? { bg: STYLE.selectedBg, bold: true } : undefined
  if (item.kind === "main") {
    const expanded = expandedRoots.includes(item.rootSessionId)
    return [
      {
        text: `${prefix}${expanded ? "▾" : "▸"} ◆ Main session  ${item.rootSessionId.slice(0, 12)}`,
        style: { fg: STYLE.accent, ...selection },
      },
    ]
  }
  const task = item.task
  if (task === undefined) return []
  const indent = item.ancestorLastSiblings === undefined
    ? "  ".repeat(Math.max(0, item.depth - 1))
    : item.ancestorLastSiblings.map((ancestorIsLast) => (ancestorIsLast ? "  " : "│ ")).join("")
  const branch = item.lastSibling === false ? "├─" : "└─"
  const continuation = item.lastSibling === false ? "│ " : "  "
  const name = safeText(task.name ?? task.task_summary ?? task.description ?? task.task_id)
  return [
    {
      text: `${prefix}${indent}${branch}${statusGlyph(task.status)} ${name}`,
      style: { fg: statusColor(task.status), ...selection },
    },
    {
      text: `${prefix}${indent}${continuation}  ${task.status.toUpperCase()}  ${elapsed(task, now)}`,
      style: { fg: STYLE.meta, dim: true, ...selection },
    },
  ]
}

function projectDetail(
  state: ViewerState,
  data: ViewerData,
  selected: TaskTreeItem | undefined,
  viewed: TaskTreeItem | undefined,
  viewport: ViewerViewport,
  now: number,
  railColor: string,
): PaneProjection {
  const width = Math.max(1, Math.floor(viewport.detailWidth))
  const height = Math.max(1, Math.floor(viewport.detailHeight))
  if (data.error !== undefined) {
    const errorLines = wrapText(
      `STORE ERROR\n\n${safeText(data.error)}\n\nThe viewer is read-only. Fix the path or restart with --state-dir.`,
      width,
    ).slice(0, height)
    return {
      frame: {
        lines: errorLines,
        hits: errorLines.map(() => undefined),
        styles: errorLines.map((line) => (line.startsWith("STORE ERROR") ? { fg: STYLE.error, bold: true } : { fg: STYLE.text })),
      },
      limits: ZERO_LIMITS,
    }
  }
  if (viewed === undefined) {
    const lines = wrapText("No session selected.", width).slice(0, height)
    return { frame: { lines, hits: lines.map(() => undefined), styles: lines.map(() => ({ fg: STYLE.meta })) }, limits: ZERO_LIMITS }
  }

  const knownTurn = (id: string | undefined): id is string =>
    id !== undefined && data.transcript.turns.some((turn) => turn.id === id)
  const expandedTurnId = knownTurn(state.expandedTurnId) ? state.expandedTurnId : undefined
  const cursorTurnId = knownTurn(state.selectedTurnId) ? state.selectedTurnId : expandedTurnId
  const heading = viewed.kind === "main"
    ? mainHeading(viewed, data)
    : taskHeading(viewed, data, selected, now)
  const headingRows = heading.flatMap((line) =>
    wrapText(line, width).map((text) => ({ text, style: headingStyle(line, viewed) })),
  )
  const headingLines = headingRows.map((row) => row.text)
  const headingStyles = headingRows.map((row) => row.style)
  const rows = transcriptRows(data.transcript, width, cursorTurnId, expandedTurnId, railColor)
  const available = Math.max(0, height - headingLines.length)
  const maxScroll = Math.max(0, rows.rows.length - available)
  const offset = clamp(state.scrollOffset, 0, maxScroll)
  const end = rows.rows.length - offset
  const start = Math.max(0, end - available)
  const visible = rows.rows.slice(start, end)
  const lines = [...headingLines, ...visible.map((row) => row.text)]
  const hits: (ViewerHit | undefined)[] = [
    ...headingLines.map(() => undefined),
    ...visible.map((row): ViewerHit | undefined => (row.turnId === undefined ? undefined : { kind: "turn", id: row.turnId })),
  ]
  if (available > 0 && rows.rows.length === 0) {
    const waiting = viewed.kind === "main" ? "(waiting for main-session output…)" : "(waiting for transcript output…)"
    const waitingLines = wrapText(waiting, width)
    lines.push(...waitingLines)
    hits.push(...waitingLines.map(() => undefined))
    headingStyles.push(...waitingLines.map(() => ({ fg: STYLE.meta })))
  }
  const focusStart = cursorTurnId === undefined ? undefined : rows.turnStarts.get(cursorTurnId)
  const focusOffset = focusStart === undefined || available === 0
    ? undefined
    : clamp(rows.rows.length - available - focusStart, 0, maxScroll)
  const visibleCells = visible.some((row) => row.cells !== undefined)
    ? [
        ...headingLines.map(() => undefined),
        ...visible.map((row) => row.cells),
      ].slice(0, height)
    : undefined
  return {
    frame: {
      lines: lines.slice(0, height),
      hits: hits.slice(0, height),
      styles: [...headingStyles, ...visible.map((row) => row.style)].slice(0, height),
      ...(visibleCells === undefined ? {} : { cells: visibleCells }),
    },
    limits: { transcriptScroll: maxScroll, todoScroll: 0 },
    ...(focusOffset === undefined ? {} : { focusOffset }),
  }
}

function headingStyle(line: string, viewed: TaskTreeItem): RowStyle {
  if (line === "MAIN SESSION" || line.startsWith("AGENT  ")) return { fg: STYLE.accent, bold: true }
  if (line.startsWith("TRANSCRIPT")) return { fg: STYLE.meta }
  if (line.startsWith("Status")) return { fg: statusColor(viewed.task?.status ?? ""), bold: true }
  if (line.startsWith("Choose an agent") || line.startsWith("Press t") || line.startsWith("Escape")) return { fg: STYLE.thinking }
  if (line.startsWith("Agent record disappeared")) return { fg: STYLE.error }
  return { fg: STYLE.text }
}

const TODO_GLYPH: Record<TodoStatus, string> = { pending: "○", in_progress: "●", completed: "✓" }
const TODO_COLOR: Record<TodoStatus, string> = { pending: STYLE.meta, in_progress: STYLE.tool, completed: STYLE.result }

function projectTodoPane(
  todo: TodoState,
  width: number,
  maxRows: number,
  scroll: number,
  hideCompleted: boolean,
): { readonly frame: PaneFrame; readonly maxScroll: number } {
  const limit = Math.max(1, Math.floor(maxRows))
  const fullRows = todoPaneRows(todo, width, false, hideCompleted)
  const rows = fullRows.length <= limit ? fullRows : todoPaneRows(todo, width, true, hideCompleted)
  const maxScroll = Math.max(0, rows.length - limit)
  const offset = clamp(scroll, 0, maxScroll)
  const window = rows.slice(offset, offset + limit)
  const lines = window.map((row) => row.text)
  const styles = window.map((row) => row.style)
  if (maxScroll > 0) {
    lines.push(`↑/↓ scroll   ${offset + 1}-${offset + window.length}/${rows.length}`)
    styles.push({ fg: STYLE.meta, dim: true })
  }
  return {
    frame: { lines, hits: lines.map(() => undefined), styles },
    maxScroll,
  }
}

function todoPaneRows(
  todo: TodoState,
  width: number,
  compact: boolean,
  hideCompleted: boolean,
): readonly StyledLine[] {
  const rows: StyledLine[] = wrapText(`TODO ${todo.done}/${todo.total}   Now: ${todo.now ?? "—"}`, width).map((text) => ({
    text,
    style: { fg: STYLE.accent, bold: true },
  }))
  if (!compact && todo.next !== undefined) {
    rows.push(...wrapText(`Next: ${todo.next}`, width).map((text) => ({ text, style: { fg: STYLE.meta } })))
  }
  const skipCompleted = compact || hideCompleted
  let shown = 0
  for (const phase of todo.phases) {
    const open = phase.items.filter((item) => item.status !== "completed")
    if (skipCompleted && open.length === 0) continue
    const done = phase.items.length - open.length
    rows.push(...wrapText(`${phase.name}  ${done}/${phase.items.length}`, width).map((text) => ({
      text,
      style: { fg: STYLE.assistant, bold: true },
    })))
    for (const item of skipCompleted ? open : phase.items) {
      rows.push(...todoItemRows(item, width))
      shown += 1
    }
  }
  if (todo.phases.length === 0) {
    for (const item of todo.remaining) {
      if (skipCompleted && item.status === "completed") continue
      rows.push(...todoItemRows(item, width))
      shown += 1
    }
  }
  if (shown === 0) {
    rows.push({
      text: hideCompleted ? "No open items." : "All items complete.",
      style: { fg: STYLE.result },
    })
  }
  return rows
}

function todoItemRows(item: TodoItem, width: number): readonly StyledLine[] {
  return wrapText(`${TODO_GLYPH[item.status]} ${item.text}`, width).map((text) => ({
    text,
    style: { fg: TODO_COLOR[item.status], ...(item.status === "completed" ? { dim: true } : {}) },
  }))
}

function mainHeading(viewed: TaskTreeItem, data: ViewerData): readonly string[] {
  const tasks = data.items.filter((item) => item.kind === "task" && item.rootSessionId === viewed.rootSessionId)
  const counts = countStatuses(tasks)
  return [
    "MAIN SESSION",
    "",
    `Session  ${viewed.rootSessionId}`,
    `Agents   ${tasks.length}`,
    `Running  ${counts.running ?? 0}`,
    `Queued   ${counts.pending ?? 0}`,
    `Done     ${counts.completed ?? 0}`,
    `Failed   ${(counts.error ?? 0) + (counts.lost ?? 0)}`,
    "",
    "Choose an agent from the left and press Enter or → to enter its turn list.",
    "↑/↓ pick a turn, Enter or → opens its detail, ← backs out one level.",
    "Tab moves focus between the task list, the transcript, and the todo pane.",
    "Press t to open the newest turn's detail; click any transcript line to open that turn.",
    "Escape from any agent view returns here.",
    "",
    `TRANSCRIPT ${data.transcript.lines.length} lines`,
    "",
  ]
}

function taskHeading(
  viewed: TaskTreeItem,
  data: ViewerData,
  selected: TaskTreeItem | undefined,
  now: number,
): readonly string[] {
  const task = viewed.task
  if (task === undefined) return ["Agent record disappeared. Refreshing the tree…"]
  const selectedRoot = selected?.rootSessionId ?? viewed.rootSessionId
  return [
    `AGENT  ${safeText(task.name ?? task.task_summary ?? task.task_id)}`,
    "",
    `Status    ${task.status}`,
    `Started   ${task.started_at ?? task.created_at}`,
    `Elapsed   ${elapsed(task, now)}`,
    task.category === undefined ? undefined : `Category  ${safeText(task.category)}`,
    task.agent_type === undefined ? undefined : `Agent     ${safeText(task.agent_type)}`,
    task.model === undefined ? undefined : `Model     ${safeText(task.model)}`,
    `Task ID   ${task.task_id}`,
    "",
    `TRANSCRIPT ${data.transcript.lines.length} lines  •  ${viewed.rootSessionId === selectedRoot ? "current session" : "other session"}`,
    "",
  ].filter((line): line is string => line !== undefined)
}

interface WrappedRow {
  readonly text: string
  readonly turnId?: string
  readonly style?: RowStyle
  readonly cells?: readonly PreviewCell[]
}

interface TranscriptRows {
  readonly rows: readonly WrappedRow[]
  /** First rendered row of each turn that has transcript lines. */
  readonly turnStarts: ReadonlyMap<string, number>
}

const transcriptRowCache = new WeakMap<TranscriptDocument, Map<string, TranscriptRows>>()

function transcriptRows(
  document: TranscriptDocument,
  width: number,
  cursorTurnId: string | undefined,
  expandedTurnId: string | undefined,
  railColor: string,
): TranscriptRows {
  let perKey = transcriptRowCache.get(document)
  if (perKey === undefined) {
    perKey = new Map()
    transcriptRowCache.set(document, perKey)
  }
  const key = `${width}:${cursorTurnId ?? ""}:${expandedTurnId ?? ""}:${railColor}`
  const cached = perKey.get(key)
  if (cached !== undefined) return cached
  const turns = document.turns
  const expandedIndex = expandedTurnId === undefined ? -1 : turns.findIndex((turn) => turn.id === expandedTurnId)
  const expanded = expandedIndex < 0 ? undefined : turns[expandedIndex]
  const lastLine = new Map<string, number>()
  document.lineTurns.forEach((turnId, index) => {
    if (turnId !== undefined) lastLine.set(turnId, index)
  })
  const rows: WrappedRow[] = []
  const turnStarts = new Map<string, number>()
  let emitted = expanded === undefined
  document.lines.forEach((line, index) => {
    const turnId = document.lineTurns[index]
    const highlighted = cursorTurnId !== undefined && turnId === cursorTurnId
    const wrapWidth = highlighted ? Math.max(1, width - 2) : width
    const style = transcriptLineStyle(line, highlighted, railColor)
    if (turnId !== undefined && !turnStarts.has(turnId)) turnStarts.set(turnId, rows.length)
    for (const text of wrapText(line, wrapWidth)) {
      rows.push(turnId === undefined ? { text, style } : { text, turnId, style })
    }
    if (expanded !== undefined && turnId === expanded.id && lastLine.get(expanded.id) === index) {
      rows.push(...turnBlock(expanded, expandedIndex, turns.length, width, railColor))
      emitted = true
    }
  })
  if (!emitted && expanded !== undefined) rows.push(...turnBlock(expanded, expandedIndex, turns.length, width, railColor))
  const built: TranscriptRows = { rows, turnStarts }
  perKey.set(key, built)
  return built
}

const MAX_TURN_IMAGES = 3
const MAX_IMAGE_ROWS = 12
const TURN_ROW = (railColor: string): RowStyle => ({ rail: true, railColor, bg: STYLE.turnBg })

function transcriptLineStyle(line: string, highlighted: boolean, railColor: string): RowStyle {
  const base = transcriptKindStyle(line)
  return highlighted ? { ...base, bg: STYLE.turnBg, rail: true, railColor } : base
}

function transcriptKindStyle(line: string): RowStyle {
  if (line.startsWith("assistant:")) return { fg: STYLE.assistant }
  if (line.startsWith("thinking:")) return { fg: STYLE.thinking, dim: true }
  if (line.startsWith("tool:")) return { fg: STYLE.tool }
  if (line.startsWith("result[error]")) return { fg: STYLE.error }
  if (line.startsWith("result")) return { fg: STYLE.result }
  if (line.startsWith("error:")) return { fg: STYLE.error }
  return { fg: STYLE.text }
}

function bodyStyle(line: string): RowStyle {
  if (line === "THINKING") return { fg: STYLE.thinking, bold: true }
  if (line === "ASSISTANT") return { fg: STYLE.assistant, bold: true }
  if (line.startsWith("CALL ")) return { fg: STYLE.tool, bold: true }
  if (line === "RESULTS") return { fg: STYLE.result, bold: true }
  const trimmed = line.trimStart()
  if (trimmed.startsWith("result[error]")) return { fg: STYLE.error }
  if (trimmed.startsWith("result")) return { fg: STYLE.result }
  return { fg: STYLE.text }
}

function turnBlock(turn: TranscriptTurn, index: number, total: number, width: number, railColor: string): readonly WrappedRow[] {
  const inner = Math.max(1, width - 2)
  const base = TURN_ROW(railColor)
  const rows: WrappedRow[] = wrapText(`▾ TURN ${index + 1} / ${total}   ${summarizeTurn(turn)}`, inner)
    .map((text) => ({ text, turnId: turn.id, style: { ...base, fg: STYLE.accent, bold: true } }))
  const body = wrappedTurnBody(turn, inner)
  if (body.length === 0) {
    rows.push({
      text: "(this turn recorded no thinking, text, calls or results)",
      turnId: turn.id,
      style: { ...base, fg: STYLE.meta },
    })
  }
  for (const text of body) rows.push({ text, turnId: turn.id, style: { ...base, ...bodyStyle(text) } })
  const images = turn.results.flatMap((result) => result.images ?? [])
  for (const image of images.slice(0, MAX_TURN_IMAGES)) {
    const preview = previewImage(image.data, image.mimeType, Math.max(4, inner), MAX_IMAGE_ROWS)
    rows.push({
      text: preview === undefined
        ? `IMAGE ${image.mimeType}`
        : `IMAGE ${preview.sourceWidth}x${preview.sourceHeight} ${image.mimeType}`,
      turnId: turn.id,
      style: { ...base, fg: STYLE.image, bold: true },
    })
    if (preview === undefined) {
      rows.push({ text: "(preview unavailable)", turnId: turn.id, style: { ...base, fg: STYLE.error } })
    } else {
      for (const cells of preview.rows) {
        rows.push({ text: cells.map((cell) => cell.text).join(""), cells, turnId: turn.id, style: base })
      }
    }
    rows.push({ text: "", turnId: turn.id, style: base })
  }
  if (images.length > MAX_TURN_IMAGES) {
    rows.push({
      text: `(${images.length - MAX_TURN_IMAGES} more images in this turn)`,
      turnId: turn.id,
      style: { ...base, fg: STYLE.meta },
    })
  }
  rows.push({ text: `▴ end of turn ${index + 1}`, turnId: turn.id, style: { ...base, fg: STYLE.meta, dim: true } })
  return rows
}

const turnBodyCache = new WeakMap<TranscriptTurn, Map<number, readonly string[]>>()

function wrappedTurnBody(turn: TranscriptTurn, width: number): readonly string[] {
  let perWidth = turnBodyCache.get(turn)
  if (perWidth === undefined) {
    perWidth = new Map()
    turnBodyCache.set(turn, perWidth)
  }
  const cached = perWidth.get(width)
  if (cached !== undefined) return cached
  const lines = formatTurnBody(turn).flatMap((line) => wrapText(line, width))
  perWidth.set(width, lines)
  return lines
}

export function wrapText(text: string, width: number): readonly string[] {
  const limit = Math.max(1, Math.floor(width))
  const expanded = text.replaceAll("\t", "    ")
  return expanded.split("\n").flatMap((line) => wrapLine(line, limit))
}

function wrapLine(text: string, width: number): readonly string[] {
  if (text.length === 0) return [""]
  const lines: string[] = []
  let rest = text
  while (stringWidth(rest) > width) {
    const cut = breakIndex(rest, width)
    const head = rest.slice(0, cut).trimEnd()
    if (head.length > 0) lines.push(head)
    rest = rest.slice(cut).trimStart()
  }
  if (rest.length > 0) lines.push(rest)
  return lines.length === 0 ? [""] : lines
}

function breakIndex(text: string, width: number): number {
  let used = 0
  let index = 0
  let lastSpace = -1
  for (const character of text) {
    const characterWidth = stringWidth(character)
    if (used + characterWidth > width) {
      if (text[index] === " " && index > 0) return index
      break
    }
    used += characterWidth
    index += character.length
    if (character === " ") lastSpace = index
  }
  if (lastSpace > 0 && lastSpace >= Math.floor(width / 2)) return lastSpace
  return Math.max(1, index)
}

const stringWidth: (text: string) => number = (() => {
  const bun = (globalThis as { Bun?: { stringWidth?: (text: string) => number } }).Bun
  return bun?.stringWidth ?? ((text: string) => [...text].length)
})()

function countStatuses(items: readonly TaskTreeItem[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const item of items) {
    const status = item.task?.status ?? "unknown"
    counts[status] = (counts[status] ?? 0) + 1
  }
  return counts
}

function statusGlyph(status: string): string {
  if (status === "running") return "●"
  if (status === "pending") return "◦"
  if (status === "completed") return "✓"
  if (status === "error" || status === "lost") return "✗"
  if (status === "cancelled" || status === "interrupted") return "‖"
  return "?"
}

function elapsed(task: TaskRecord, now: number): string {
  const started = Date.parse(task.started_at ?? task.created_at)
  const ended = task.terminal_at === undefined ? now : Date.parse(task.terminal_at)
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) return "—"
  const seconds = Math.floor((ended - started) / 1000)
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`
  return `${Math.floor(seconds / 3600)}h${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}m`
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
