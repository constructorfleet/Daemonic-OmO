import { useEffect, useRef } from "react"
import { useQuery } from "@tanstack/react-query"
import type { Project } from "./api-model"
import type { ProjectTaskItem } from "./project-activity-model"
import { projectTaskDocumentQueryKey } from "./project-task-stream"
import type { createApiClient } from "./api-client"
import type { createStreamStore } from "./stream"

type ProjectActivityApi = Pick<
  ReturnType<typeof createApiClient>,
  "getProjectTaskDocument" | "listProjectRunningRuns"
>

type ProjectActivityStream = Pick<ReturnType<typeof createStreamStore>, "subscribeDoc" | "unsubscribeDoc">

type ProjectActivityProps = {
  readonly project: Project
  readonly api: ProjectActivityApi
  readonly stream: ProjectActivityStream
}

export function ProjectActivity({ project, api, stream }: ProjectActivityProps) {
  const docId = `project:${project.id}:tasks`
  const subscriptionRevision = useRef<string | null>(null)
  const taskDocument = useQuery({
    queryKey: projectTaskDocumentQueryKey(docId),
    queryFn: () => api.getProjectTaskDocument(project.id),
    staleTime: Infinity,
  })
  const runs = useQuery({
    queryKey: ["project-runs", project.id],
    queryFn: () => api.listProjectRunningRuns(project.id),
    staleTime: Infinity,
  })

  useEffect(() => {
    const current = taskDocument.data
    if (current === undefined) return
    const revision = `${current.epoch}/${current.rev}`
    if (subscriptionRevision.current === revision) return
    subscriptionRevision.current = revision
    void stream.subscribeDoc({ docId: current.docId, epoch: current.epoch, rev: current.rev })
  }, [taskDocument.data, stream])

  useEffect(() => () => {
    void stream.unsubscribeDoc(docId)
  }, [docId, stream])

  const tasks = taskDocument.data?.snapshot.items.flatMap((item) =>
    item.kind === "task" && item.task !== undefined ? [{ ...item, task: item.task }] : [])
  const runningTasks = tasks?.filter(({ task }) =>
    task.status === "running" || task.status === "pending" || task.status === "scheduled").length ?? 0
  const completedTasks = tasks?.filter(({ task }) => task.status === "completed").length ?? 0
  const stoppedTasks = tasks?.filter(({ task }) =>
    task.status === "paused" || task.status === "interrupted" || task.status === "cancelled"
    || task.status === "failed" || task.status === "skipped").length ?? 0
  const runningRunCount = runs.data?.length ?? 0

  return (
    <div className="mt-2 grid gap-1 border-t border-hairline pt-2" data-testid="project-activity" data-project-id={project.id}>
      {taskDocument.isPending && <p className="max-w-prose text-sm text-muted" role="status">Loading task activity…</p>}
      {taskDocument.error !== null && (
        <p className="max-w-prose text-sm text-error" role="alert">Task activity unavailable: {taskDocument.error.message}</p>
      )}
      {runs.isPending && <p className="max-w-prose text-sm text-muted" role="status">Loading running runs…</p>}
      {runs.error !== null && (
        <p className="max-w-prose text-sm text-error" role="alert">Run activity unavailable: {runs.error.message}</p>
      )}
      <p className="m-0 max-w-prose text-sm text-muted tabular-nums" data-testid="project-task-counts" data-project-id={project.id}>
        Tasks: {runningTasks} running, {completedTasks} completed, {stoppedTasks} stopped
      </p>
      <p
        className="inline-flex max-w-52 w-fit items-center gap-2 whitespace-normal [overflow-wrap:anywhere] rounded-[var(--radius-control)] bg-selection px-2 py-1 text-sm font-semibold tabular-nums text-accent"
        data-testid="project-running-runs"
        data-project-id={project.id}
      >
        <span className="font-bold">{runningRunCount}</span>
        {" "}
        {runningRunCount === 1 ? "running run" : "running runs"}
      </p>
      {tasks !== undefined && tasks.length > 0 && (
        <ul className="m-0 grid list-none gap-1 p-0" aria-label={`${project.name} tasks`}>
          {tasks.map((item: ProjectTaskItem & { readonly task: NonNullable<ProjectTaskItem["task"]> }) => {
            const name = item.task.name ?? item.task.task_summary ?? item.task.description ?? item.task.task_id
            return (
              <li
                className="flex max-w-prose flex-wrap justify-between gap-2 text-sm text-text"
                data-testid="task-row"
                data-task-id={item.task.task_id}
                key={item.task.task_id}
              >
                <span className="min-w-0 max-w-full break-words">{name}</span>
                <span>{item.task.status}</span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
