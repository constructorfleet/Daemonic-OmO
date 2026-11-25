# ADR 0001: Transcript reading, turn identity, and scroll anchoring

- Status: Accepted
- Date: 2026-11-24

## Context

The viewer reads OmO Native task-store and session files that it does not own. Session files can be tens of megabytes, tasks can be resumed into several session files, and inline turn expansion needs to address a turn across refreshes. Rendering also needs to stay responsive while the refresh timer runs.

## Decision

- Reads are bounded to the last 4 MiB of the selected root or child session by default (`--read-bytes`, 64 KiB to 64 MiB), using at most the first and last file when a task has several session files. The small per-task event log is read separately.
- Tool-result images ride inside those session entries as base64. They are decoded only when their turn is expanded, resized to the pane, and cached by content hash, so the base64 never reaches the text rows or a second read path.
- The refresh cadence owns all transcript I/O. Rendering and input handling read from the loaded transcript document and do not touch the filesystem. Pause stops the refresh reads; opening a different item still loads its document.
- A turn is identified by the session entry id, falling back to the entry timestamp and then a window-relative index. If the expanded turn leaves the loaded window, the expansion closes.
- Transcript scroll is anchored to the newest line: the offset is the number of wrapped rows back from the end. New output therefore moves content that the user has scrolled back to.
- Expanding a turn inserts its body into the transcript rows at the turn's position, after the turn's own lines. When the expansion target changes, the viewport recenters on the turn's first row without a second scroll model.
- Root sessions and child sessions use the same transcript-document interface, line-to-turn mapping, and inline turn expansion.

## Consequences

Turn selection is exact while a turn remains in the loaded window, but not for turns older than that window. Scroll anchoring follows output rather than pinning a line; changing that would require a new decision and a different state model. Image previews inherit the same window: an image entry that falls outside the read budget is not shown, and a larger budget costs proportional JSON parse time per refresh. The task-store layout remains the integration contract: the viewer reads it directly and never imports upstream code.
