import { useEffect, useRef, useState } from "react"
import type { KeyboardEvent as ReactKeyboardEvent } from "react"
import { SessionHeading } from "./session-heading"
import { SessionTree } from "./session-tree"
import { SessionsToolbar } from "./sessions-toolbar"
import { TodoPane } from "./todo-pane"
import { useSessionExplorer } from "./use-session-explorer"
import { handleSessionKeyDown } from "./session-keyboard"
import { assertNever } from "../../lib/project-activity-model"
import { TranscriptPane } from "../transcript/transcript-pane"
import "./sessions.css"
import "../transcript/transcript.css"

export function SessionsPageView() {
  const session = useSessionExplorer()
  const pageRef = useRef<HTMLElement>(null)
  const [paneFocus, setPaneFocus] = useState<"tree" | "transcript" | "todo">("tree")

  function scrollOwner(): HTMLElement {
    const content = pageRef.current?.closest<HTMLElement>("main.workspace__content")
    return content !== null && content !== undefined && getComputedStyle(content).overflowY !== "visible"
      ? content
      : document.documentElement
  }

  function scrollToLatest(): void {
    const owner = scrollOwner()
    owner.scrollTo({ top: owner.scrollHeight })
  }

  useEffect(() => {
    if (!session.followLatest) return
    const newest = session.transcript?.snapshot.turns.at(-1)
    if (newest === undefined) return
    session.setSelectedTurnId(newest.id)
    scrollToLatest()
  }, [session.followLatest, session.transcript?.snapshot.turns.length])

  function focusPane(pane: "tree" | "transcript" | "todo"): void {
    setPaneFocus(pane)
    pageRef.current?.querySelector<HTMLElement>(`[data-pane="${pane}"]`)?.focus()
  }

  function closeDetail(): void {
    if (session.expandedTurnId !== null) {
      session.setExpandedTurnId(null)
      focusPane("transcript")
      return
    }
    const active = session.items.find((item) => item.id === session.viewedId) ?? session.selectedItem
    if (active === null) {
      session.setViewedId(null)
      focusPane("tree")
      return
    }
    switch (active.kind) {
      case "main":
        session.setViewedId(null)
        break
      case "run":
      case "task": {
        const root = session.items.find((item) =>
          item.kind === "main" && item.rootSessionId === active.rootSessionId)
        session.setSelectedId(root?.id ?? active.id)
        session.setViewedId(root?.id ?? null)
        break
      }
      default:
        assertNever(active)
    }
    focusPane("tree")
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLElement>): void {
    handleSessionKeyDown(event, {
      items: session.items,
      selectedId: session.selectedId,
      viewedId: session.viewedId,
      selectedItem: session.selectedItem,
      selectedTurnId: session.selectedTurnId,
      expandedTurnId: session.expandedTurnId,
      hiddenFilters: session.hiddenFilters,
      paneFocus,
      todoVisible: session.todoVisible,
      transcript: session.transcript,
    }, {
      focusPane,
      selectItem: (item) => {
        session.selectItem(item)
        focusPane("transcript")
      },
      selectId: session.setSelectedId,
      selectTurn: session.setSelectedTurnId,
      toggleTurn: (id) => session.setExpandedTurnId((current) => current === id ? null : id),
      closeDetail,
      toggleFilter: session.toggleFilter,
      toggleCompleted: () => session.setHideCompleted((current) => !current),
      toggleTodo: () => session.setTodoVisible((current) => !current),
      scrollTodo: (direction) => {
        const pane = pageRef.current?.querySelector<HTMLElement>(".sessions-todo__scroll")
        if (pane !== undefined && pane !== null) pane.scrollBy({ top: direction * pane.clientHeight / 2 })
      },
      scrollPage: (direction) => {
        const owner = scrollOwner()
        owner.scrollBy({ top: direction * owner.clientHeight / 5 })
      },
      followLatest: () => {
        const newest = session.transcript?.snapshot.turns.at(-1)
        if (newest !== undefined) session.setSelectedTurnId(newest.id)
        session.setFollowLatest(true)
        scrollToLatest()
      },
      openNewestTurn: () => {
        const newest = session.transcript?.snapshot.turns.at(-1)
        if (newest === undefined) return
        session.setSelectedTurnId(newest.id)
        session.setExpandedTurnId(newest.id)
        session.setFollowLatest(true)
        scrollToLatest()
        focusPane("transcript")
      },
      togglePause: session.togglePause,
      refresh: () => void session.refresh(),
    })
  }

  function toggleFollowLatest(): void {
    const next = !session.followLatest
    session.setFollowLatest(next)
    if (next) {
      const newest = session.transcript?.snapshot.turns.at(-1)
      if (newest !== undefined) session.setSelectedTurnId(newest.id)
    }
  }

  return (
    <section
      className="sessions-page"
      aria-label="Sessions explorer"
      ref={pageRef}
      data-testid="sessions-page"
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      <SessionsToolbar
        projects={session.projects.data?.projects ?? []}
        projectId={session.projectId}
        hiddenFilters={session.hiddenFilters}
        hideCompleted={session.hideCompleted}
        paused={session.paused}
        readBudget={session.readBudget}
        onProjectChange={session.changeProject}
        onToggleFilter={session.toggleFilter}
        onToggleCompleted={() => session.setHideCompleted((value) => !value)}
        onTogglePause={session.togglePause}
        onRefresh={() => void session.refresh()}
        onReadBudgetChange={(value) => void session.updateReadBudget(value)}
      />

      {session.actionError !== null && <p role="alert">{session.actionError}</p>}
      {session.projects.isPending && <p role="status">Loading projects…</p>}
      {session.projects.error !== null && <p role="alert">Projects unavailable: {session.projects.error.message}</p>}
      {session.projects.data !== undefined && session.projects.data.projects.length === 0 && (
        <p>No projects are available for this account. Register a project to load its sessions.</p>
      )}
      {session.selectedProject !== undefined && (
        <>
          {session.taskDocument.isPending && <p role="status">Loading sessions for {session.selectedProject.name}…</p>}
          {session.taskDocument.error !== null && <p role="alert">Task tree unavailable: {session.taskDocument.error.message}</p>}
          <div className="sessions-grid">
            <div className="sessions-column">
              <SessionTree
                items={session.items}
                selectedId={session.selectedId}
                viewedId={session.viewedId}
                hiddenFilters={session.hiddenFilters}
                onSelect={(item) => {
                  session.selectItem(item)
                  focusPane("transcript")
                }}
              />
              {session.todoVisible && (
                <TodoPane
                  todo={session.transcript?.snapshot.todo ?? null}
                  hideCompleted={session.hideCompleted}
                  onToggleCompleted={() => session.setHideCompleted((value) => !value)}
                  onClose={() => session.setTodoVisible(false)}
                />
              )}
            </div>
            <div className="sessions-column">
              <SessionHeading item={session.viewedItem} items={session.items} />
              {session.transcriptQuery.isPending && <p role="status">Loading transcript…</p>}
              {session.transcriptQuery.error !== null && (
                <p role="alert">Transcript unavailable: {session.transcriptQuery.error.message}</p>
              )}
              <TranscriptPane
                api={session.api}
                state={session.transcript}
                selectedTurnId={session.selectedTurnId}
                expandedTurnId={session.expandedTurnId}
                followLatest={session.followLatest}
                loadingOlder={session.loadingOlder}
                onSelectTurn={(turnId) => {
                  session.setSelectedTurnId(turnId)
                  session.setExpandedTurnId((current) => current === turnId ? null : turnId)
                  session.setFollowLatest(false)
                }}
                onFollowLatest={toggleFollowLatest}
                onLoadOlder={() => void session.loadOlder()}
              />
            </div>
          </div>
        </>
      )}
      <span className="sr-only" aria-live="polite">
        {session.paused ? "Stream application paused" : "Stream application active"}
      </span>
    </section>
  )
}
