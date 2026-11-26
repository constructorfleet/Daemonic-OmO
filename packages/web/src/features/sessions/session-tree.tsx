import { assertNever } from "../../lib/project-activity-model"
import type { ProjectTaskItem } from "../../lib/project-activity-model"
import { elapsedLabel, itemDisplayName, statusCounts } from "./session-model"
import "./session-tree.css"

export type SessionFilter = "completed" | "running" | "stopped"

type SessionTreeProps = {
  readonly items: readonly ProjectTaskItem[]
  readonly selectedId: string | null
  readonly viewedId: string | null
  readonly hiddenFilters: readonly SessionFilter[]
  readonly onSelect: (item: ProjectTaskItem) => void
}

type SessionSelection = {
  readonly selectedId: string | null
  readonly viewedId: string | null
  readonly hiddenFilters: readonly SessionFilter[]
}

type LeafItem = Extract<ProjectTaskItem, { readonly kind: "run" | "task" }>

type LeafRow = {
  readonly name: string
  readonly status: string
  readonly depth: number
  readonly meta: string
  readonly testId: "run-row" | "task-row"
  readonly taskId?: string
}

const STATUS_GLYPHS: Readonly<Record<string, string>> = {
  running: "▶",
  pending: "○",
  scheduled: "◷",
  completed: "✓",
  failed: "✗",
  error: "✗",
  lost: "✗",
  paused: "Ⅱ",
  interrupted: "⊘",
  cancelled: "⊘",
  skipped: "⊘",
}

function statusGroup(status: string): SessionFilter | undefined {
  if (status === "completed") return "completed"
  if (status === "running" || status === "pending" || status === "scheduled") return "running"
  if (["paused", "cancelled", "interrupted", "failed", "error", "lost", "skipped"].includes(status)) return "stopped"
  return undefined
}

function statusTone(status: string): string {
  if (status === "running") return "running"
  if (status === "completed") return "completed"
  if (status === "failed" || status === "error" || status === "lost") return "error"
  return "other"
}

export function visibleSessionItems(
  items: readonly ProjectTaskItem[],
  selection: SessionSelection,
): readonly ProjectTaskItem[] {
  return items.filter((item) => {
    switch (item.kind) {
      case "main":
      case "run":
        return true
      case "task": {
        const group = statusGroup(item.task.status)
        return item.id === selection.selectedId || item.id === selection.viewedId
          || group === undefined || !selection.hiddenFilters.includes(group)
      }
      default:
        return assertNever(item)
    }
  })
}

function leafRow(item: LeafItem, now: number): LeafRow {
  switch (item.kind) {
    case "run":
      return {
        name: item.run.name,
        status: item.run.status,
        depth: item.depth,
        meta: item.run.status,
        testId: "run-row",
      }
    case "task":
      return {
        name: itemDisplayName(item),
        status: item.task.status,
        depth: item.depth,
        meta: `${item.task.status} · ${elapsedLabel(item.task, now)}`,
        testId: "task-row",
        taskId: item.task.task_id,
      }
    default:
      return assertNever(item)
  }
}

export function SessionTree({ items, selectedId, viewedId, hiddenFilters, onSelect }: SessionTreeProps) {
  const shown = visibleSessionItems(items, { selectedId, viewedId, hiddenFilters })
  return (
    <section className="sessions-tree" aria-labelledby="sessions-tree-title" data-pane="tree" tabIndex={-1}>
      <h2 id="sessions-tree-title">Sessions and tasks</h2>
      {shown.length === 0 && <p className="text-sm text-muted">No sessions or tasks in this project.</p>}
      <ul className="sessions-tree__list">
        {shown.map((item) => {
          switch (item.kind) {
            case "main": {
              const summary = statusCounts(items, item.rootSessionId)
              const statusCount = Object.entries(summary).map(([status, count]) => `${count} ${status}`).join(", ")
              return (
                <li key={item.id}>
                  <button
                    className="sessions-tree__row sessions-tree__main"
                    type="button"
                    aria-current={selectedId === item.id ? "true" : undefined}
                    data-selected={selectedId === item.id}
                    onClick={() => onSelect(item)}
                  >
                    <span className="sessions-tree__glyph" aria-hidden="true">◆</span>
                    <span className="sessions-tree__name">Main {item.rootSessionId.slice(0, 12)}</span>
                    <span className="sessions-tree__meta">{statusCount || "no child tasks"}</span>
                  </button>
                </li>
              )
            }
            case "run":
            case "task": {
              const row = leafRow(item, Date.now())
              return (
                <li key={item.id}>
                  <button
                    className={`sessions-tree__row sessions-tree__status--${statusTone(row.status)}`}
                    type="button"
                    aria-current={selectedId === item.id ? "true" : undefined}
                    data-selected={selectedId === item.id}
                    data-viewed={viewedId === item.id}
                    data-testid={row.testId}
                    {...(row.taskId === undefined ? {} : { "data-task-id": row.taskId })}
                    style={{ paddingInlineStart: `calc(var(--space-4) * ${row.depth})` }}
                    onClick={() => onSelect(item)}
                  >
                    <span className="sessions-tree__glyph" aria-hidden="true">{STATUS_GLYPHS[row.status] ?? "○"}</span>
                    <span className="sessions-tree__name">{row.name}</span>
                    <span className="sessions-tree__meta">{row.meta}</span>
                  </button>
                </li>
              )
            }
            default:
              return assertNever(item)
          }
        })}
      </ul>
    </section>
  )
}
