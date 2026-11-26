import type { TranscriptTodo } from "../transcript/model"

type TodoPaneProps = {
  readonly todo: TranscriptTodo | null
  readonly hideCompleted: boolean
  readonly onToggleCompleted: () => void
  readonly onClose: () => void
}

const ITEM_GLYPHS: Readonly<Record<string, string>> = {
  completed: "✓",
  in_progress: "●",
  pending: "○",
}

export function TodoPane({ todo, hideCompleted, onToggleCompleted, onClose }: TodoPaneProps) {
  if (todo === null) return null
  const showItem = (status: string): boolean => !hideCompleted || status !== "completed"
  return (
    <section className="sessions-todo" aria-labelledby="sessions-todo-title" data-testid="todo-pane" data-pane="todo" tabIndex={-1}>
      <header className="sessions-todo__header">
        <h2 id="sessions-todo-title">TODO {todo.done}/{todo.total}</h2>
        <div className="sessions-todo__actions">
          <button type="button" onClick={onToggleCompleted} aria-pressed={hideCompleted}>
            {hideCompleted ? "Show completed" : "Hide completed"}
          </button>
          <button type="button" aria-label="Close todo pane" onClick={onClose}>Close</button>
        </div>
      </header>
      {todo.now !== undefined && <p><strong>Now</strong> {todo.now}</p>}
      {todo.next !== undefined && <p><strong>Next</strong> {todo.next}</p>}
      <div className="sessions-todo__scroll">
        {todo.phases.map((phase) => {
          const done = phase.items.filter((item) => item.status === "completed").length
          return (
            <section className="sessions-todo__phase" key={phase.name}>
              <h3>{phase.name} <span>{done}/{phase.items.length}</span></h3>
              <ul>
                {phase.items.filter((item) => showItem(item.status)).map((item, index) => (
                  <li key={`${phase.name}-${item.status}-${index}`}>
                    <span aria-hidden="true">{ITEM_GLYPHS[item.status] ?? "○"}</span>
                    {item.text}
                  </li>
                ))}
              </ul>
            </section>
          )
        })}
      </div>
    </section>
  )
}
