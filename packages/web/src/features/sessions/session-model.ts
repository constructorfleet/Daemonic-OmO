import type { ProjectListItem } from "../../lib/api-model"
import { assertNever } from "../../lib/project-activity-model"
import type { ProjectTaskItem, ProjectTaskRecord } from "../../lib/project-activity-model"

export type SessionProject = {
  readonly id: string
  readonly name: string
  readonly cwd: string
}

export async function identifyProjects(items: readonly ProjectListItem[]): Promise<readonly SessionProject[]> {
  return Promise.all(items.map(async (item) => {
    if (!("registered" in item)) return { id: item.id, name: item.name, cwd: item.cwd }
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(item.cwd))
    const prefix = [...new Uint8Array(hash)].slice(0, 8).map((byte) => byte.toString(16).padStart(2, "0")).join("")
    return { id: `disc-${prefix}`, name: item.name, cwd: item.cwd }
  }))
}

export function sessionDocumentId(agentDirHash: string, sessionId: string): string {
  return `session:${agentDirHash}:${sessionId}`
}

export function transcriptDocumentId(
  projectId: string,
  item: ProjectTaskItem,
  agentDirHash: string | undefined,
): string | null {
  switch (item.kind) {
    case "main":
      return agentDirHash === undefined
        ? null
        : sessionDocumentId(agentDirHash, item.rootSessionId)
    case "run":
      return null
    case "task":
      return `task:${projectId}:${item.task.task_id}`
    default:
      return assertNever(item)
  }
}

export function statusCounts(items: readonly ProjectTaskItem[], rootSessionId: string): Readonly<Record<string, number>> {
  const result: Record<string, number> = {}
  for (const item of items) {
    switch (item.kind) {
      case "main":
      case "run":
        break
      case "task":
        if (item.task.root_session_id === rootSessionId) {
          const status = item.task.status
          result[status] = (result[status] ?? 0) + 1
        }
        break
      default:
        assertNever(item)
    }
  }
  return result
}

export function elapsedLabel(task: ProjectTaskRecord, now: number): string {
  const start = Date.parse(task.started_at ?? task.created_at)
  if (!Number.isFinite(start)) return "unknown"
  const terminalAt = task.terminal_at === undefined ? now : Date.parse(task.terminal_at)
  const elapsed = Math.max(0, Math.floor(((Number.isFinite(terminalAt) ? terminalAt : now) - start) / 1000))
  if (elapsed < 60) return `${elapsed}s`
  if (elapsed < 3600) return `${Math.floor(elapsed / 60)}m`
  return `${Math.floor(elapsed / 3600)}h ${Math.floor((elapsed % 3600) / 60)}m`
}

export function itemDisplayName(item: ProjectTaskItem): string {
  switch (item.kind) {
    case "main":
      return item.rootSessionId
    case "run":
      return item.run.name
    case "task":
      return item.task.name ?? item.task.task_summary ?? item.task.description ?? item.task.task_id
    default:
      return assertNever(item)
  }
}
