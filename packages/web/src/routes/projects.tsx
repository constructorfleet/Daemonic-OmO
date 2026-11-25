import { useEffect, useMemo, useRef, useState } from "react"
import type { FormEvent } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { EmptyState } from "../components/empty-state"
import { ApiError, createApiClient } from "../lib/api"
import type { DiscoveredProject, Project, ProjectListItem } from "../lib/api"
import { ProjectActivity } from "../lib/project-activity"
import { ProjectSettingsForm } from "../lib/project-settings-form"
import { PROJECTS_QUERY_KEY, createStreamStore } from "../lib/stream"
import type { StreamStoreOptions } from "../lib/stream"
import { isRecord } from "../lib/api-model"

export type ProjectsApi = ReturnType<typeof createApiClient>

type ProjectsPageProps = {
  readonly api?: ProjectsApi
  readonly eventSourceFactory?: StreamStoreOptions["eventSourceFactory"]
}

type ProjectListResponse = {
  readonly items: readonly ProjectListItem[]
  readonly headSeq: number
}

const defaultApi = createApiClient()

export const Route = createFileRoute("/projects")({
  component: () => <ProjectsPage />,
})

function isRegisteredProject(item: ProjectListItem): item is Project {
  return !("registered" in item)
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError || error instanceof Error) return error.message
  return "The request could not be completed"
}

function compatibilitySummary(value: unknown): { readonly version: string; readonly tested: string; readonly failures: readonly { readonly name: string; readonly detail: string }[] } | null {
  if (!isRecord(value)) return null
  const checks = Array.isArray(value["checks"]) ? value["checks"] : []
  const failures = checks.flatMap((check) => {
    if (!isRecord(check) || check["ok"] !== false) return []
    return [{
      name: typeof check["name"] === "string" ? check["name"] : "Compatibility check",
      detail: typeof check["detail"] === "string" ? check["detail"] : "Check failed",
    }]
  })
  return {
    version: typeof value["omoVersion"] === "string" ? value["omoVersion"] : "unknown",
    tested: typeof value["testedVersion"] === "string" ? value["testedVersion"] : "unknown",
    failures,
  }
}

function CompatibilityBanner({ report, error }: { readonly report: unknown; readonly error: unknown }) {
  if (error !== null) {
    return <p className="max-w-prose border-b border-hairline py-3 text-sm text-muted" role="status">Compatibility status unavailable: {errorMessage(error)}</p>
  }
  if (report === null) {
    return <p className="max-w-prose border-b border-hairline py-3 text-sm text-muted" role="status">Compatibility report has not run yet.</p>
  }
  const summary = compatibilitySummary(report)
  if (summary === null) return null
  return (
    <section className="grid gap-2 border-b border-hairline py-3" aria-label="Compatibility status">
      <p className="max-w-prose text-sm text-heading">omo {summary.version}; tested against {summary.tested}</p>
      {summary.failures.map((failure) => (
        <p className="max-w-prose text-sm text-error" key={failure.name}>
          {failure.name}: {failure.detail}
        </p>
      ))}
    </section>
  )
}

export function ProjectsPage({ api = defaultApi, eventSourceFactory }: ProjectsPageProps) {
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState<Project | null>(null)
  const [registerOpen, setRegisterOpen] = useState(false)
  const [cwd, setCwd] = useState("")
  const [name, setName] = useState("")
  const [actionError, setActionError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const streamStarted = useRef(false)
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.me() })
  const projects = useQuery({
    queryKey: PROJECTS_QUERY_KEY,
    queryFn: async () => {
      const identity = await api.me()
      return api.listProjects(true, identity.role === "admin" ? identity.user.id : undefined)
    },
  })
  const health = useQuery({ queryKey: ["health"], queryFn: () => api.health() })
  const items = projects.data?.items ?? []
  const registered = items.filter(isRegisteredProject)
  const discovered = items.filter((item): item is DiscoveredProject => "registered" in item)
  const stream = useMemo(() => createStreamStore({
    queryClient,
    api,
    ...(eventSourceFactory === undefined ? {} : { eventSourceFactory }),
  }), [api, eventSourceFactory, queryClient])

  useEffect(() => {
    if (projects.data === undefined || streamStarted.current) return
    stream.start(projects.data.headSeq)
    streamStarted.current = true
  }, [projects.data, stream])

  useEffect(() => () => stream.close(), [stream])

  function cacheProject(project: Project): void {
    queryClient.setQueryData<Project>(["project", project.id], project)
    queryClient.setQueryData<ProjectListResponse>(PROJECTS_QUERY_KEY, (current) => {
      if (current === undefined) return current
      const items = current.items.filter((item) =>
        isRegisteredProject(item) ? item.id !== project.id : item.cwd !== project.cwd)
      return { items: [project, ...items], headSeq: current.headSeq }
    })
  }

  async function registerProject(project: Parameters<ProjectsApi["createProject"]>[0]): Promise<boolean> {
    try {
      const created = await api.createProject(project)
      cacheProject(created)
      setActionError(null)
      setStatus(`${created.name} registered`)
      return true
    } catch (cause) {
      setActionError(errorMessage(cause))
      return false
    }
  }

  async function submitRegistration(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const project = { cwd, ...(name.trim().length === 0 ? {} : { name: name.trim() }) }
    if (!await registerProject(project)) return
    setCwd("")
    setName("")
    setRegisterOpen(false)
  }

  function savedProject(project: Project): void {
    cacheProject(project)
    setSelected(project)
  }

  return (
    <section className="grid gap-6" aria-label="Projects overview">
      <CompatibilityBanner report={health.data?.omo ?? null} error={health.error} />
      {selected === null && (
        <div className="flex flex-wrap items-center justify-between gap-4">
          <p className="max-w-prose text-sm text-muted">
            {me.data === undefined ? "Loading account" : `Projects for ${me.data.user.name}`}
          </p>
          <button
            className={`min-w-48 whitespace-normal [overflow-wrap:anywhere] min-h-11 rounded-[var(--radius-control)] px-5 py-2 font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus ${
              registerOpen
                ? "border border-control-edge text-heading hover:bg-selection"
                : "bg-accent text-panel hover:brightness-95"
            }`}
            type="button"
            aria-expanded={registerOpen}
            aria-controls="project-registration"
            onClick={() => setRegisterOpen(!registerOpen)}
          >
            {registerOpen ? "Cancel registration" : "Register project"}
          </button>
        </div>
      )}

      {selected === null && registerOpen && (
        <form id="project-registration" className="grid max-w-2xl gap-4 border-b border-hairline pb-6" onSubmit={(event) => void submitRegistration(event)}>
          <h2 className="text-lg font-semibold text-heading">Register a project</h2>
          <label className="grid gap-2 text-sm text-heading">
            Project directory
            <input
              className="min-h-11 rounded-[var(--radius-control)] border border-muted bg-panel px-3 text-base text-text"
              type="text"
              required
              placeholder="/path/to/project"
              value={cwd}
              onChange={(event) => setCwd(event.currentTarget.value)}
            />
          </label>
          <label className="grid gap-2 text-sm text-heading">
            Project name
            <input
              className="min-h-11 rounded-[var(--radius-control)] border border-muted bg-panel px-3 text-base text-text"
              type="text"
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
            />
          </label>
          <button className="max-w-52 whitespace-normal [overflow-wrap:anywhere] min-h-11 w-fit rounded-[var(--radius-control)] bg-accent px-5 py-2 font-semibold text-panel" type="submit">
            Register project
          </button>
        </form>
      )}

      {selected === null && actionError !== null && <p className="max-w-prose text-sm text-error" role="alert">{actionError}</p>}
      {selected === null && status !== null && <p className="max-w-prose text-sm text-success" role="status">{status}</p>}
      {selected === null && projects.isPending && <p className="text-sm text-muted" role="status">Loading projects…</p>}
      {selected === null && projects.error !== null && <p className="max-w-prose text-sm text-error" role="alert">{errorMessage(projects.error)}</p>}

      {selected === null && !registerOpen && projects.data !== undefined && items.length === 0 && (
        <EmptyState
          description="No projects available for this account."
          nextStep="Register a project directory or check that its omo session files are available."
        />
      )}

      {selected === null && registered.length > 0 && (
        <section className="grid gap-2" aria-labelledby="registered-projects-title">
          <h2 id="registered-projects-title" className="text-lg font-semibold text-heading">Registered projects</h2>
          {registered.map((project) => (
            <article className="flex flex-wrap items-center justify-between gap-4 border-b border-hairline py-4" key={project.id}>
              <div className="grid min-w-0 gap-2">
                <h3 className="break-words text-base font-semibold text-heading">{project.name}</h3>
                <p className="break-all text-sm text-muted">{project.cwd}</p>
                <p className="text-sm text-success">{project.state === "active" ? "Active project" : "Archived project"}</p>
                <ProjectActivity project={project} api={api} stream={stream} />
              </div>
              <button
                className="min-h-11 rounded-[var(--radius-control)] border border-control-edge px-4 text-heading hover:bg-selection"
                type="button"
                onClick={() => setSelected(project)}
                aria-label={`Edit settings for ${project.name}`}
              >
                Edit settings
              </button>
            </article>
          ))}
        </section>
      )}

      {selected === null && discovered.length > 0 && (
        <section className="grid gap-2" aria-labelledby="discovered-projects-title">
          <h2 id="discovered-projects-title" className="text-lg font-semibold text-heading">Discovered projects</h2>
          {discovered.map((project) => (
            <article className="flex flex-wrap items-center justify-between gap-4 border-b border-hairline py-4" key={project.cwd}>
              <div className="grid min-w-0 gap-2">
                <h3 className="break-words text-base font-semibold text-heading">{project.name}</h3>
                <p className="break-all text-sm text-muted">{project.cwd}</p>
                <p className="max-w-prose text-sm text-muted">Latest session {new Date(project.latestSessionAt).toLocaleString()}</p>
              </div>
              <button
                className="max-w-52 whitespace-normal [overflow-wrap:anywhere] min-h-11 rounded-[var(--radius-control)] border border-control-edge px-4 py-2 text-heading hover:bg-selection"
                type="button"
                onClick={() => void registerProject(project)}
              >
                Register {project.name}
              </button>
            </article>
          ))}
        </section>
      )}

      {selected !== null && (
        <ProjectSettingsForm
          project={selected}
          api={api}
          onSaved={savedProject}
          onCancel={() => setSelected(null)}
        />
      )}
    </section>
  )
}
