import type { SessionProject } from "./session-model"
import type { SessionFilter } from "./session-tree"

const FILTERS: readonly SessionFilter[] = ["completed", "running", "stopped"]
const READ_BUDGETS = [65_536, 262_144, 1_048_576, 4_194_304, 16_777_216, 67_108_864] as const

function formatBytes(value: number): string {
  return value >= 1_048_576 ? `${value / 1_048_576} MiB` : `${value / 1024} KiB`
}

type SessionsToolbarProps = {
  readonly projects: readonly SessionProject[]
  readonly projectId: string | null
  readonly hiddenFilters: readonly SessionFilter[]
  readonly hideCompleted: boolean
  readonly paused: boolean
  readonly readBudget: number
  readonly onProjectChange: (projectId: string) => void
  readonly onToggleFilter: (filter: SessionFilter) => void
  readonly onToggleCompleted: () => void
  readonly onTogglePause: () => void
  readonly onRefresh: () => void
  readonly onReadBudgetChange: (value: number) => void
}

export function SessionsToolbar({
  projects,
  projectId,
  hiddenFilters,
  hideCompleted,
  paused,
  readBudget,
  onProjectChange,
  onToggleFilter,
  onToggleCompleted,
  onTogglePause,
  onRefresh,
  onReadBudgetChange,
}: SessionsToolbarProps) {
  const budgets: readonly number[] = READ_BUDGETS.some((budget) => budget === readBudget)
    ? READ_BUDGETS
    : [...READ_BUDGETS, readBudget].sort((left: number, right: number) => left - right)
  return (
    <div className="sessions-toolbar">
      <div className="sessions-toolbar__project">
        <label htmlFor="sessions-project">Project</label>
        <select
          id="sessions-project"
          value={projectId ?? ""}
          onChange={(event) => onProjectChange(event.currentTarget.value)}
        >
          {projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}
        </select>
      </div>
      <div className="sessions-toolbar__filters" aria-label="Task status filters">
        {FILTERS.map((filter, index) => (
          <button
            type="button"
            aria-pressed={!hiddenFilters.includes(filter)}
            key={filter}
            onClick={() => onToggleFilter(filter)}
          >
            {index + 1} {filter}
          </button>
        ))}
        <button type="button" aria-pressed={hideCompleted} onClick={onToggleCompleted}>
          4 {hideCompleted ? "show done" : "hide done"}
        </button>
        <button type="button" aria-pressed={paused} onClick={onTogglePause}>{paused ? "Resume" : "Pause"}</button>
        <button type="button" onClick={onRefresh}>Refresh</button>
      </div>
      <label className="sessions-toolbar__budget">
        Read budget
        <select aria-label="Read budget" value={readBudget} onChange={(event) => onReadBudgetChange(Number(event.currentTarget.value))}>
          {budgets.map((budget) => <option value={budget} key={budget}>{formatBytes(budget)}</option>)}
        </select>
      </label>
    </div>
  )
}

export { formatBytes }
