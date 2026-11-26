import type { KeyboardEvent as ReactKeyboardEvent } from "react"
import type { ProjectTaskItem } from "../../lib/project-activity-model"
import type { TranscriptState } from "../transcript/model"
import { visibleSessionItems } from "./session-tree"
import type { SessionFilter } from "./session-tree"

type SessionKeyboardState = {
  readonly items: readonly ProjectTaskItem[]
  readonly selectedId: string | null
  readonly viewedId: string | null
  readonly selectedItem: ProjectTaskItem | null
  readonly selectedTurnId: string | null
  readonly expandedTurnId: string | null
  readonly hiddenFilters: readonly SessionFilter[]
  readonly paneFocus: "tree" | "transcript" | "todo"
  readonly todoVisible: boolean
  readonly transcript: TranscriptState | null
}

type SessionKeyboardActions = {
  readonly focusPane: (pane: "tree" | "transcript" | "todo") => void
  readonly selectItem: (item: ProjectTaskItem) => void
  readonly selectId: (id: string) => void
  readonly selectTurn: (id: string) => void
  readonly toggleTurn: (id: string) => void
  readonly closeDetail: () => void
  readonly toggleFilter: (filter: SessionFilter) => void
  readonly toggleCompleted: () => void
  readonly toggleTodo: () => void
  readonly scrollTodo: (direction: number) => void
  readonly scrollPage: (direction: number) => void
  readonly followLatest: () => void
  readonly openNewestTurn: () => void
  readonly togglePause: () => void
  readonly refresh: () => void
}

export function handleSessionKeyDown(
  event: ReactKeyboardEvent<HTMLElement>,
  state: SessionKeyboardState,
  actions: SessionKeyboardActions,
): void {
  const target = event.target
  if (target instanceof HTMLElement && ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)) return
  const shown = visibleSessionItems(state.items, {
    selectedId: state.selectedId,
    viewedId: state.viewedId,
    hiddenFilters: state.hiddenFilters,
  })
  const selectionIndex = shown.findIndex((item) => item.id === state.selectedId)
  const turns = state.transcript?.snapshot.turns ?? []
  const turnIndex = turns.findIndex((turn) => turn.id === state.selectedTurnId)
  if (event.key === "Tab") {
    event.preventDefault()
    const panes: readonly ("tree" | "transcript" | "todo")[] =
      state.todoVisible && state.transcript?.snapshot.todo != null
        ? ["tree", "transcript", "todo"]
        : ["tree", "transcript"]
    const current = panes.indexOf(state.paneFocus)
    actions.focusPane(panes[(current + (event.shiftKey ? panes.length - 1 : 1)) % panes.length] ?? "tree")
  } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
    event.preventDefault()
    const delta = event.key === "ArrowDown" ? 1 : -1
    if (state.paneFocus === "tree") {
      const item = shown[Math.max(0, Math.min(shown.length - 1, selectionIndex + delta))]
      if (item !== undefined) actions.selectId(item.id)
    } else if (state.paneFocus === "transcript") {
      const turn = turns[Math.max(0, Math.min(turns.length - 1, turnIndex + delta))]
      if (turn !== undefined) {
        actions.selectTurn(turn.id)
        if (state.expandedTurnId !== null) actions.toggleTurn(turn.id)
      }
    } else actions.scrollTodo(delta)
  } else if ((event.key === "Enter" || event.key === "ArrowRight") && state.paneFocus === "tree" && state.selectedItem !== null) {
    event.preventDefault()
    actions.selectItem(state.selectedItem)
    actions.focusPane("transcript")
  } else if ((event.key === "Enter" || event.key === "ArrowRight") && state.paneFocus === "transcript" && state.selectedTurnId !== null) {
    event.preventDefault()
    actions.toggleTurn(state.selectedTurnId)
  } else if (event.key === "ArrowLeft" || event.key === "Escape") {
    event.preventDefault()
    actions.closeDetail()
  } else if (event.key === "1" || event.key === "2" || event.key === "3") {
    actions.toggleFilter((["completed", "running", "stopped"] as const)[Number(event.key) - 1] ?? "completed")
  } else if (event.key === "4") actions.toggleCompleted()
  else if (event.key === "t") actions.openNewestTurn()
  else if (event.key === "l") actions.toggleTodo()
  else if (event.key === "j" || event.key === "k") {
    const direction = event.key === "j" ? 1 : -1
    if (state.paneFocus === "todo") actions.scrollTodo(direction)
    else actions.scrollPage(direction)
  }
  else if (event.key === "g") actions.followLatest()
  else if (event.key === "p") actions.togglePause()
  else if (event.key === "r") actions.refresh()
}
