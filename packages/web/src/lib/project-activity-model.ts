import { isRecord, requiredInteger, requiredString } from "./api-model-primitives"

export const RUN_STATES = ["queued", "creating", "active", "settled", "evaluating", "closed", "kept"] as const
export type RunState = (typeof RUN_STATES)[number]

export type ProjectRunSummary = {
  readonly id: string
  readonly projectId: string
  readonly state: RunState
}

export type ProjectTaskItem = {
  readonly id: string
  readonly kind: "main" | "run" | "task"
  readonly task?: {
    readonly task_id: string
    readonly parent_session_id: string
    readonly root_session_id: string
    readonly status: string
    readonly created_at: string
    readonly name?: string
    readonly task_summary?: string
    readonly description?: string
  }
}

export type ProjectTaskDocument = {
  readonly docId: string
  readonly epoch: number
  readonly rev: number
  readonly snapshot: {
    readonly items: readonly ProjectTaskItem[]
    readonly invalidRecords: number
    readonly agentDirHash?: string
  }
}

export function parseProjectRunList(value: unknown): readonly ProjectRunSummary[] {
  if (!isRecord(value) || !Array.isArray(value["items"])) {
    throw new TypeError("API runs response must include items")
  }
  return value["items"].map((item): ProjectRunSummary => {
    if (!isRecord(item)) throw new TypeError("API run must be an object")
    const state = RUN_STATES.find((candidate) => candidate === item["state"])
    if (state === undefined) throw new TypeError("API run state is unknown")
    return {
      id: requiredString(item, "id"),
      projectId: requiredString(item, "projectId"),
      state,
    }
  })
}

export function parseProjectTaskItem(value: unknown): ProjectTaskItem {
  if (!isRecord(value)) throw new TypeError("API task tree item must be an object")
  const kind = value["kind"]
  if (kind !== "main" && kind !== "run" && kind !== "task") {
    throw new TypeError("API task tree item kind is unknown")
  }
  if (kind !== "task") return { id: requiredString(value, "id"), kind }
  const task = value["task"]
  if (!isRecord(task)) throw new TypeError("API task tree item must include a task")
  const name = task["name"]
  const taskSummary = task["task_summary"]
  const description = task["description"]
  if (
    (name !== undefined && typeof name !== "string")
    || (taskSummary !== undefined && typeof taskSummary !== "string")
    || (description !== undefined && typeof description !== "string")
  ) throw new TypeError("API task has an invalid display name")
  return {
    id: requiredString(value, "id"),
    kind,
    task: {
      task_id: requiredString(task, "task_id"),
      parent_session_id: requiredString(task, "parent_session_id"),
      root_session_id: requiredString(task, "root_session_id"),
      status: requiredString(task, "status"),
      created_at: requiredString(task, "created_at"),
      ...(typeof name === "string" ? { name } : {}),
      ...(typeof taskSummary === "string" ? { task_summary: taskSummary } : {}),
      ...(typeof description === "string" ? { description } : {}),
    },
  }
}

export function parseProjectTaskDocument(value: unknown): ProjectTaskDocument {
  if (!isRecord(value) || !isRecord(value["snapshot"])) {
    throw new TypeError("API task document must include a snapshot")
  }
  const snapshot = value["snapshot"]
  const items = snapshot["items"]
  if (!Array.isArray(items)) throw new TypeError("API task document snapshot must include items")
  const agentDirHash = snapshot["agentDirHash"]
  if (agentDirHash !== undefined && typeof agentDirHash !== "string") {
    throw new TypeError("API task document agentDirHash must be a string")
  }
  return {
    docId: requiredString(value, "docId"),
    epoch: requiredInteger(value, "epoch"),
    rev: requiredInteger(value, "rev"),
    snapshot: {
      items: items.map(parseProjectTaskItem),
      invalidRecords: requiredInteger(snapshot, "invalidRecords"),
      ...(typeof agentDirHash === "string" ? { agentDirHash } : {}),
    },
  }
}
