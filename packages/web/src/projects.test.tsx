import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, describe, expect, it } from "bun:test"
import { ProjectsPage, type ProjectsApi } from "./routes/projects"
import type { Project, ProjectListItem } from "./lib/api"
import type { StreamEventSource } from "./lib/stream"

GlobalRegistrator.register()

afterEach(cleanup)
afterAll(async () => GlobalRegistrator.unregister())

function registeredProject(): Project {
  return {
    id: "project-1",
    userId: "user-1",
    name: "demo",
    cwd: "/tmp/demo",
    agentDir: "/tmp/agent",
    stateDir: "/tmp/agent/projects/demo",
    settings: { fullAccessOptIn: false, maxRunning: 1, worktreeForAdhoc: false },
    state: "active",
    revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }
}

function renderProjects(items: readonly ProjectListItem[]) {
  let currentItems = items
  const updates: { readonly id: string; readonly input: { readonly revision: number; readonly settings?: Partial<Project["settings"]> } }[] = []
  const api: ProjectsApi = {
    me: async () => ({
      user: { id: "user-1", name: "Ari", email: "ari@example.test", role: "member" },
      role: "member",
      csrfToken: "csrf-1",
    }),
    health: async () => ({ version: "1.0.0", headSeq: 1, omo: null }),
    listProjects: async () => ({ items: currentItems, headSeq: 1 }),
    getProject: async () => registeredProject(),
    getProjectTaskDocument: async (projectId) => ({
      docId: `project:${projectId}:tasks`,
      epoch: 7,
      rev: 3,
      snapshot: {
        items: [
          {
            id: "task-running",
            kind: "task",
            rootSessionId: "root-1",
            depth: 1,
            task: {
              task_id: "task-running",
              parent_session_id: "root-1",
              root_session_id: "root-1",
              status: "running",
              created_at: "2026-11-25T08:00:00.000Z",
              name: "Live task",
            },
          },
          {
            id: "task-completed",
            kind: "task",
            rootSessionId: "root-1",
            depth: 1,
            task: {
              task_id: "task-completed",
              parent_session_id: "root-1",
              root_session_id: "root-1",
              status: "completed",
              created_at: "2026-11-25T07:00:00.000Z",
              name: "Finished task",
            },
          },
          {
            id: "task-failed",
            kind: "task",
            rootSessionId: "root-1",
            depth: 1,
            task: {
              task_id: "task-failed",
              parent_session_id: "root-1",
              root_session_id: "root-1",
              status: "failed",
              created_at: "2026-11-25T06:00:00.000Z",
              name: "Failed task",
            },
          },
        ],
        invalidRecords: 0,
        agentDirHash: "agent-hash",
      },
    }),
    listProjectRunningRuns: async (projectId) => [
      { id: "run-1", projectId, state: "active" },
    ],
    createProject: async () => {
      const project = registeredProject()
      currentItems = [project]
      return project
    },
    updateProject: async (id, input) => {
      updates.push({ id, input })
      return { ...registeredProject(), revision: input.revision + 1, settings: { ...registeredProject().settings, ...input.settings } }
    },
    logout: async () => {},
    subscribeDoc: async () => {},
    unsubscribeDoc: async () => {},
  }
  const queryClient = new QueryClient()
  const sources: StreamEventSource[] = []
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ProjectsPage
        api={api}
        eventSourceFactory={(url) => {
          const source: StreamEventSource = {
            addEventListener: () => {},
            close: () => {},
          }
          sources.push(source)
          return source
        }}
      />
    </QueryClientProvider>,
  )
  return { ...view, updates, sources }
}

describe("projects page", () => {
  it("registers a discovered project and refreshes the list", async () => {
    const view = renderProjects([{
      cwd: "/tmp/demo",
      name: "demo",
      stateDir: "/tmp/agent/projects/demo",
      latestSessionId: "session-1",
      latestSessionAt: 1,
      registered: false,
    }])

    fireEvent.click(await view.findByRole("button", { name: "Register demo" }))

    expect(await view.findByRole("button", { name: "Edit settings for demo" })).toBeTruthy()
    await waitFor(() => expect(view.getByTestId("project-running-runs").textContent).toContain("1"))
  })

  it("keeps the registration form distinct from the empty project state", async () => {
    const view = renderProjects([])

    fireEvent.click(await view.findByRole("button", { name: "Register project" }))

    expect(await view.findByRole("button", { name: "Cancel registration" })).toBeTruthy()
    expect(view.getAllByRole("button", { name: "Register project" })).toHaveLength(1)
    expect(view.queryByRole("heading", { name: "Nothing to show yet" })).toBeNull()
  })

  it("returns to the empty project state when registration is cancelled", async () => {
    const view = renderProjects([])
    fireEvent.click(await view.findByRole("button", { name: "Register project" }))

    fireEvent.click(await view.findByRole("button", { name: "Cancel registration" }))

    expect(view.queryByRole("form")).toBeNull()
    expect(await view.findByRole("heading", { name: "Nothing to show yet" })).toBeTruthy()
  })

  it("saves run limits inside the canonical project settings object", async () => {
    const view = renderProjects([registeredProject()])

    await waitFor(() => expect(view.getByTestId("project-running-runs").textContent).toContain("1"))
    fireEvent.click(await view.findByRole("button", { name: "Edit settings for demo" }))
    expect(view.queryByRole("heading", { name: "Registered projects" })).toBeNull()
    const maxRunning = await view.findByRole("spinbutton", { name: "Maximum parallel runs" })
    if (!(maxRunning instanceof HTMLInputElement)) throw new TypeError("maximum parallel runs must be an input")
    fireEvent.input(maxRunning, { target: { value: "2" } })
    expect(maxRunning.value).toBe("2")
    const saveButton = view.getByRole("button", { name: "Save settings" })
    const form = saveButton.closest("form")
    if (form === null) throw new TypeError("settings save button must be inside a form")
    fireEvent.submit(form)

    await waitFor(() => expect(view.updates).toHaveLength(1))
    await view.findByText("Settings saved")
    expect(view.updates).toEqual([{ id: "project-1", input: { revision: 1, settings: { maxRunning: 2 } } }])
  })

  it("shows task status counts, task rows, and running project runs", async () => {
    const view = renderProjects([registeredProject()])

    expect((await view.findByTestId("project-task-counts")).textContent)
      .toContain("1 running, 1 completed, 1 stopped")
    await waitFor(() => expect(view.getByTestId("project-running-runs").textContent).toContain("1"))
    expect(view.getAllByTestId("task-row").map((row) => row.getAttribute("data-task-id")))
      .toEqual(["task-running", "task-completed", "task-failed"])
    expect(view.getByText("Failed task")).toBeTruthy()
    expect(view.sources).toHaveLength(1)
  })
})
