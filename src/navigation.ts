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

/** Returns a contiguous list window measured in rendered lines (tasks use two lines). */
export function visibleNavigationItems<T extends NavigationItem>(
  items: readonly T[],
  selectedId: string | undefined,
  maxRows: number,
): readonly T[] {
  if (maxRows <= 0 || items.length === 0) return []
  const selectedIndex = items.findIndex((item) => item.id === selectedId)
  let start = selectedIndex < 0 ? 0 : selectedIndex
  let end = selectedIndex < 0 ? 0 : selectedIndex + 1
  let rows = selectedIndex < 0 ? 0 : rowCost(items[selectedIndex]!)
  let before = 0
  let after = 0

  while (start > 0 || end < items.length) {
    const previousCost = start > 0 ? rowCost(items[start - 1]!) : Number.POSITIVE_INFINITY
    const nextCost = end < items.length ? rowCost(items[end]!) : Number.POSITIVE_INFINITY
    const choosePrevious = previousCost < nextCost || (previousCost === nextCost && before <= after)
    const cost = choosePrevious ? previousCost : nextCost
    if (rows + cost > maxRows) {
      const otherCost = choosePrevious ? nextCost : previousCost
      if (rows + otherCost > maxRows) break
      if (choosePrevious) {
        end += 1
        after += 1
        rows += nextCost
      } else {
        start -= 1
        before += 1
        rows += previousCost
      }
      continue
    }
    if (choosePrevious) {
      start -= 1
      before += 1
    } else {
      end += 1
      after += 1
    }
    rows += cost
  }
  return items.slice(start, end)
}

function rowCost(item: NavigationItem): number {
  return item.kind === "main" ? 1 : 2
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
