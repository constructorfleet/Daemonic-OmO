import type { createApiClient } from "../../lib/api-client"
import type { TranscriptState } from "./model"
import { TurnDetail } from "./turn-detail"

type TranscriptApi = Pick<ReturnType<typeof createApiClient>, "getTurnBody" | "getDocumentImage">

type TranscriptPaneProps = {
  readonly api: TranscriptApi
  readonly state: TranscriptState | null
  readonly selectedTurnId: string | null
  readonly expandedTurnId: string | null
  readonly followLatest: boolean
  readonly loadingOlder: boolean
  readonly onSelectTurn: (turnId: string) => void
  readonly onFollowLatest: () => void
  readonly onLoadOlder: () => void
}

function rowKind(line: string): string {
  if (line.startsWith("thinking:")) return "thinking"
  if (line.startsWith("assistant:")) return "assistant"
  if (line.startsWith("tool[error]:") || line.startsWith("error:")) return "error"
  if (line.startsWith("tool:")) return "tool"
  if (line.startsWith("result")) return "result"
  return "text"
}

function transcriptLines(lines: readonly string[]) {
  return lines.map((line, index) => (
    <p className={`transcript-line transcript-line--${rowKind(line)}`} key={`${index}-${line}`}>
      {line}
    </p>
  ))
}

export function TranscriptPane({
  api,
  state,
  selectedTurnId,
  expandedTurnId,
  followLatest,
  loadingOlder,
  onSelectTurn,
  onFollowLatest,
  onLoadOlder,
}: TranscriptPaneProps) {
  if (state === null) {
    return (
    <section className="transcript-pane" aria-labelledby="transcript-title" data-pane="transcript" tabIndex={-1}>
        <h2 id="transcript-title">Transcript</h2>
        <p>Select a session or task to load its transcript.</p>
      </section>
    )
  }
  const turns = state.snapshot.turns
  return (
    <section className="transcript-pane" aria-labelledby="transcript-title" data-testid="transcript-pane" data-pane="transcript" tabIndex={-1}>
      <header className="transcript-pane__header">
        <div>
          <h2 id="transcript-title">Transcript</h2>
          <p>TURN {turns.findIndex((turn) => turn.id === selectedTurnId) + 1} / {turns.length}</p>
        </div>
        <label className="transcript-pane__follow">
          <input type="checkbox" checked={followLatest} onChange={onFollowLatest} />
          Follow latest
        </label>
      </header>

      {state.snapshot.gone && <p className="sessions-gone" role="status">session file gone</p>}
      {state.snapshot.mode === "events" && transcriptLines(state.snapshot.events)}
      {state.snapshot.mode === "session" && (
        <div className="transcript-pane__turns">
          {state.snapshot.turns.map((turn) => {
            const expanded = expandedTurnId === turn.id
            const selected = selectedTurnId === turn.id
            return (
              <article
                className="transcript-turn"
                data-selected={selected}
                data-testid="transcript-turn"
                data-turn-id={turn.id}
                key={turn.id}
              >
                <button
                  className="transcript-turn__summary"
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => onSelectTurn(turn.id)}
                >
                  <span className="transcript-turn__rail" aria-hidden="true">{selected ? "▏" : " "}</span>
                  <span className="transcript-turn__number">{turn.summary || turn.id}</span>
                  <span className="transcript-turn__preview">{turn.lines[0] ?? "Turn has no text preview"}</span>
                </button>
                <div className="transcript-turn__lines">{transcriptLines(turn.lines)}</div>
                {expanded && <TurnDetail api={api} docId={state.docId} turn={turn} />}
              </article>
            )
          })}
        </div>
      )}

      {state.snapshot.mode === "session" && state.snapshot.errors.map((error, index) => (
        <p className="transcript-line transcript-line--error" key={`${index}-${error}`}>error: {error}</p>
      ))}
      {state.snapshot.hasOlder && (
        <button className="sessions-control" type="button" disabled={loadingOlder} onClick={onLoadOlder}>
          {loadingOlder ? "Loading older turns…" : "Load older turns"}
        </button>
      )}
      {turns.length === 0 && state.snapshot.mode === "session" && (
        <p className="text-muted">No transcript turns are available in the current read window.</p>
      )}
    </section>
  )
}
