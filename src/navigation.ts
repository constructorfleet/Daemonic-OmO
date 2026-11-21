import type { TaskTreeItem } from "./state.js"

export type NavigationItem = Pick<TaskTreeItem, "id" | "kind" | "rootSessionId">

export interface NavigationState {
  readonly selectedId?: string
  readonly viewId?: string
  /** Number of rows back from the newest transcript line; zero follows new output. */
  readonly scrollOffset: number
}

export function initialNavigation(items: readonly NavigationItem[] = []): NavigationState {
  const main = items.find((item) => item.kind === "main")
  return { ...(main === undefined ? {} : { selectedId: main.id, viewId: main.id }), scrollOffset: 0 }
}

export function moveSelection(state: NavigationState, delta: number, items: readonly NavigationItem[]): NavigationState {
  if (items.length === 0) return { scrollOffset: 0 }
  const current = Math.max(0, items.findIndex((item) => item.id === state.selectedId))
  const index = (current + delta + items.length) % items.length
  return { ...state, selectedId: items[index]?.id, scrollOffset: 0 }
}

export function openSelection(state: NavigationState, items: readonly NavigationItem[]): NavigationState {
  const selected = items.find((item) => item.id === state.selectedId)
  if (selected === undefined) return state
  return { ...state, viewId: selected.id, scrollOffset: 0 }
}

export function returnToMain(state: NavigationState, items: readonly NavigationItem[]): NavigationState {
  const current = items.find((item) => item.id === state.viewId)
  const root = items.find((item) => item.kind === "main" && item.rootSessionId === current?.rootSessionId)
  const main = root ?? items.find((item) => item.kind === "main")
  return { ...state, selectedId: main?.id, viewId: main?.id, scrollOffset: 0 }
}

export function adjustScroll(state: NavigationState, delta: number): NavigationState {
  return { ...state, scrollOffset: Math.max(0, state.scrollOffset + delta) }
}

export function followTranscript(state: NavigationState): NavigationState {
  return { ...state, scrollOffset: 0 }
}

export function reconcileNavigation(state: NavigationState, items: readonly NavigationItem[]): NavigationState {
  if (items.length === 0) return { scrollOffset: 0 }
  const selectedExists = items.some((item) => item.id === state.selectedId)
  const viewExists = items.some((item) => item.id === state.viewId)
  const fallback = initialNavigation(items)
  return {
    ...state,
    selectedId: selectedExists ? state.selectedId : fallback.selectedId,
    viewId: viewExists ? state.viewId : fallback.viewId,
  }
}
