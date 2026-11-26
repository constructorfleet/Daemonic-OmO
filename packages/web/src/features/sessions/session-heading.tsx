import type { ProjectTaskItem } from "../../lib/project-activity-model"
import { assertNever } from "../../lib/project-activity-model"
import { elapsedLabel, itemDisplayName, statusCounts } from "./session-model"

function formatDate(value: string | undefined): string {
  if (value === undefined) return "Unknown"
  const parsed = new Date(value)
  return Number.isNaN(parsed.valueOf()) ? "Unknown" : parsed.toLocaleString()
}

type SessionHeadingProps = {
  readonly item: ProjectTaskItem | null
  readonly items: readonly ProjectTaskItem[]
}

export function SessionHeading({ item, items }: SessionHeadingProps) {
  if (item === null) {
    return (
      <header className="sessions-page__heading">
        <h2>Transcript</h2>
      </header>
    )
  }
  switch (item.kind) {
    case "main": {
      const counts = statusCounts(items, item.rootSessionId)
      return (
        <header className="sessions-page__heading">
          <div>
            <h2>Main session {item.rootSessionId.slice(0, 12)}</h2>
            <div className="sessions-page__metadata">
              <span>Session ID {item.rootSessionId}</span>
              <span>{Object.entries(counts).map(([status, count]) => `${count} ${status}`).join(" · ") || "No child tasks"}</span>
            </div>
          </div>
        </header>
      )
    }
    case "run":
      return (
        <header className="sessions-page__heading">
          <div>
            <h2>{item.run.name}</h2>
            <div className="sessions-page__metadata"><span>Status {item.run.status}</span></div>
          </div>
        </header>
      )
    case "task": {
      const task = item.task
      return (
        <header className="sessions-page__heading">
          <div>
            <h2>{itemDisplayName(item)}</h2>
            <div className="sessions-page__metadata">
              <span>Status {task.status}</span>
              <span>Started {formatDate(task.started_at ?? task.created_at)}</span>
              <span>Elapsed {elapsedLabel(task, Date.now())}</span>
              {task.category !== undefined && <span>Category {task.category}</span>}
              {task.agent_type !== undefined && <span>Agent type {task.agent_type}</span>}
              {task.model !== undefined && <span>Model {task.model}</span>}
              <span>Task ID {task.task_id}</span>
            </div>
          </div>
        </header>
      )
    }
    default:
      return assertNever(item)
  }
}
