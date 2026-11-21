import { describe, expect, test } from "bun:test"

import {
  initialNavigation,
  moveSelection,
  openSelection,
  returnToMain,
  visibleNavigationItems,
  type NavigationItem,
} from "../src/navigation"

const items: NavigationItem[] = [
  { id: "main:main-1", kind: "main" },
  { id: "st_1", kind: "task" },
  { id: "st_2", kind: "task" },
]

describe("agent view navigation", () => {
  test("#given the main view #when a task is opened #then Esc returns to main", () => {
    const state = openSelection(moveSelection(initialNavigation(), 1, items), items)
    expect(state.selectedId).toBe("st_1")
    expect(state.viewId).toBe("st_1")
    expect(returnToMain(state, items).viewId).toBe("main:main-1")
  })

  test("#given the last row #when moving down #then selection wraps to the main row", () => {
    const state = moveSelection({ ...initialNavigation(), selectedId: "st_2" }, 1, items)
    expect(state.selectedId).toBe("main:main-1")
  })

  test("#given an open transcript #when selection moves #then the viewed task stays pinned", () => {
    const state = openSelection({ ...initialNavigation(), selectedId: "st_1", viewId: "st_1" }, items)
    const moved = moveSelection(state, 1, items)
    expect(moved.selectedId).toBe("st_2")
    expect(moved.viewId).toBe("st_1")
  })

  test("#given more tasks than fit #when selection moves past the viewport #then the selected task remains visible", () => {
    const many = Array.from({ length: 12 }, (_, index) => ({
      id: `st_${index}`,
      kind: "task" as const,
      rootSessionId: "main-1",
    }))
    const visible = visibleNavigationItems(many, "st_10", 8)
    expect(visible.map((item) => item.id)).toEqual(["st_8", "st_9", "st_10", "st_11"])
  })
})
