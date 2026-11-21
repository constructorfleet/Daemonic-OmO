import { BoxRenderable, TextRenderable, createCliRenderer } from "@opentui/core"

import {
  adjustScroll,
  followTranscript,
  initialNavigation,
  moveSelection,
  openSelection,
  reconcileNavigation,
  returnToMain,
  type NavigationState,
} from "./navigation.js"
import { projectTaskTree, type TaskRecord, type TaskTreeItem } from "./state.js"
import { loadTaskRecords, readTaskTranscript } from "./storage.js"
import { safeText, visibleTranscript } from "./transcript.js"

export interface ViewerOptions {
  readonly projectDir: string
  readonly stateDir: string
  readonly refreshMs: number
}

export async function runViewer(options: ViewerOptions): Promise<void> {
  const renderer = await createCliRenderer({ exitOnCtrlC: false })
  renderer.setTerminalTitle("OmO Agent Viewer")
  const shell = new BoxRenderable(renderer, {
    width: "100%",
    height: "100%",
    flexDirection: "column",
    padding: 1,
    gap: 1,
    backgroundColor: "#0b1020",
  })
  const header = new TextRenderable(renderer, { content: "OMO AGENTS  •  loading task store", fg: "#8be9fd" })
  const content = new BoxRenderable(renderer, { width: "100%", flexGrow: 1, flexDirection: "row", gap: 1 })
  const listPanel = new BoxRenderable(renderer, {
    width: "35%",
    height: "100%",
    flexDirection: "column",
    padding: 1,
    border: true,
    borderStyle: "rounded",
    borderColor: "#34405e",
  })
  const detailPanel = new BoxRenderable(renderer, {
    width: "65%",
    height: "100%",
    flexDirection: "column",
    padding: 1,
    border: true,
    borderStyle: "rounded",
    borderColor: "#34405e",
  })
  const listText = new TextRenderable(renderer, { content: "", fg: "#d8dee9" })
  const detailText = new TextRenderable(renderer, { content: "", fg: "#cbd5e1" })
  const footer = new TextRenderable(renderer, {
    content: "↑/↓ select  enter follow  esc main  j/k scroll  g latest  p pause  r refresh  q quit",
    fg: "#7c8aa5",
  })
  listPanel.add(listText)
  detailPanel.add(detailText)
  content.add(listPanel)
  content.add(detailPanel)
  shell.add(header)
  shell.add(content)
  shell.add(footer)
  renderer.root.add(shell)

  let snapshot = loadTaskRecords(options.stateDir)
  let items = projectTaskTree(snapshot.records)
  let navigation = initialNavigation(items)
  let paused = false
  let lastReadError: string | undefined
  let closed = false

  const itemById = (): Map<string, TaskTreeItem> => new Map(items.map((item) => [item.id, item]))

  const render = (): void => {
    const selected = itemById().get(navigation.selectedId ?? "")
    const viewed = itemById().get(navigation.viewId ?? "")
    const selectedRoot = selected?.rootSessionId ?? viewed?.rootSessionId
    const selectedTranscript = viewed?.kind === "task" ? readTaskTranscript(options.stateDir, viewed.id) : []
    const maxTranscriptRows = Math.max(4, renderer.height - 13)
    const transcript = visibleTranscript(selectedTranscript, maxTranscriptRows, navigation.scrollOffset)

    header.content = `OMO AGENTS  •  ${safeText(options.projectDir)}  •  ${paused ? "paused" : `refresh ${options.refreshMs}ms`}${snapshot.invalidRecords > 0 ? `  •  ${snapshot.invalidRecords} unreadable` : ""}`
    listText.content = renderTaskList(items, navigation.selectedId)
    detailText.content = renderDetail(viewed, items, selectedRoot, selectedTranscript, transcript, lastReadError)
    renderer.requestRender()
  }

  const refresh = (): void => {
    if (paused || closed) return
    try {
      snapshot = loadTaskRecords(options.stateDir)
      items = projectTaskTree(snapshot.records)
      navigation = reconcileNavigation(navigation, items)
      lastReadError = undefined
    } catch (error) {
      lastReadError = error instanceof Error ? error.message : String(error)
    }
    render()
  }

  const shutdown = (): void => {
    if (closed) return
    closed = true
    clearInterval(timer)
    renderer.destroy()
  }

  renderer.keyInput.on("keypress", (key) => {
    if (key.ctrl && key.name === "c") return shutdown()
    if (key.name === "q") return shutdown()
    if (key.name === "up") navigation = moveSelection(navigation, -1, items)
    else if (key.name === "down") navigation = moveSelection(navigation, 1, items)
    else if (key.name === "return" || key.name === "enter") navigation = openSelection(navigation, items)
    else if (key.name === "escape") navigation = returnToMain(navigation, items)
    else if (key.name === "r") {
      paused = false
      refresh()
      return
    } else if (key.name === "p") paused = !paused
    else if (key.name === "g") navigation = followTranscript(navigation)
    else if (key.name === "k" && itemById().get(navigation.viewId ?? "")?.kind === "task")
      navigation = adjustScroll(navigation, 1)
    else if (key.name === "j" && itemById().get(navigation.viewId ?? "")?.kind === "task")
      navigation = adjustScroll(navigation, -1)
    else return
    render()
  })

  const timer = setInterval(refresh, options.refreshMs)
  render()
}

function renderTaskList(items: readonly TaskTreeItem[], selectedId: string | undefined): string {
  if (items.length === 0) return "No task records yet.\n\nKeep this view open while OmO delegates."
  const lines = ["SESSION / AGENT TREE", ""]
  for (const item of items) {
    const active = item.id === selectedId
    const prefix = active ? "› " : "  "
    if (item.kind === "main") {
      lines.push(`${prefix}◆ Main session  ${item.rootSessionId.slice(0, 12)}`)
      continue
    }
    const task = item.task
    if (task === undefined) continue
    const indent = "  ".repeat(Math.max(0, item.depth - 1))
    const glyph = statusGlyph(task.status)
    const name = safeText(task.name ?? task.task_summary ?? task.description ?? task.task_id)
    lines.push(`${prefix}${indent}${glyph} ${name}`)
    lines.push(`    ${indent}${task.status.toUpperCase()}  ${elapsed(task)}`)
  }
  return lines.join("\n")
}

function renderDetail(
  item: TaskTreeItem | undefined,
  items: readonly TaskTreeItem[],
  rootSession: string | undefined,
  allTranscript: readonly string[],
  visible: readonly string[],
  error: string | undefined,
): string {
  if (error !== undefined) return `STORE ERROR\n\n${safeText(error)}\n\nThe viewer is read-only. Fix the path or restart with --state-dir.`
  if (item === undefined) return "No session selected."
  if (item.kind === "main") {
    const tasks = items.filter((candidate) => candidate.kind === "task" && candidate.rootSessionId === item.rootSessionId)
    const counts = countStatuses(tasks)
    return [
      "MAIN SESSION",
      "",
      `Session  ${item.rootSessionId}`,
      `Agents   ${tasks.length}`,
      `Running  ${counts.running ?? 0}`,
      `Queued   ${counts.pending ?? 0}`,
      `Done     ${counts.completed ?? 0}`,
      `Failed   ${(counts.error ?? 0) + (counts.lost ?? 0)}`,
      "",
      "Choose an agent from the left and press Enter to follow its transcript.",
      "Escape from any agent view returns here.",
    ].join("\n")
  }

  const task = item.task
  if (task === undefined) return "Agent record disappeared. Refreshing the tree…"
  const heading = [
    `AGENT  ${safeText(task.name ?? task.task_summary ?? task.task_id)}`,
    "",
    `Status    ${task.status}`,
    `Started   ${task.started_at ?? task.created_at}`,
    `Elapsed   ${elapsed(task)}`,
    task.category === undefined ? undefined : `Category  ${safeText(task.category)}`,
    task.agent_type === undefined ? undefined : `Agent     ${safeText(task.agent_type)}`,
    task.model === undefined ? undefined : `Model     ${safeText(task.model)}`,
    `Task ID   ${task.task_id}`,
    "",
    `TRANSCRIPT  ${allTranscript.length} lines  •  ${item.rootSessionId === rootSession ? "current session" : "other session"}`,
    "",
  ].filter((line): line is string => line !== undefined)
  return [...heading, ...(visible.length === 0 ? ["(waiting for transcript output…)"] : visible)].join("\n")
}

function countStatuses(items: readonly TaskTreeItem[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const item of items) {
    const status = item.task?.status ?? "unknown"
    counts[status] = (counts[status] ?? 0) + 1
  }
  return counts
}

function statusGlyph(status: string): string {
  if (status === "running") return "●"
  if (status === "pending") return "◦"
  if (status === "completed") return "✓"
  if (status === "error" || status === "lost") return "✗"
  if (status === "cancelled" || status === "interrupted") return "‖"
  return "?"
}

function elapsed(task: TaskRecord): string {
  const started = Date.parse(task.started_at ?? task.created_at)
  const ended = task.terminal_at === undefined ? Date.now() : Date.parse(task.terminal_at)
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) return "—"
  const seconds = Math.floor((ended - started) / 1000)
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`
  return `${Math.floor(seconds / 3600)}h${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}m`
}
