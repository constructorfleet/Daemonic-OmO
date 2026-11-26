import { isRecord, requiredInteger, requiredString } from "./api-model-primitives"

export const RUN_STATES = ["queued", "creating", "active", "settled", "evaluating", "closed", "kept"] as const
export type RunState = (typeof RUN_STATES)[number]

export type ProjectRunSummary = {
  readonly id: string
  readonly projectId: string
  readonly state: RunState
}

type ProjectTaskItemBase = {
  readonly id: string
  readonly rootSessionId: string
  readonly depth: number
  readonly lastSibling?: boolean
  readonly ancestorLastSiblings?: readonly boolean[]
}

export type ProjectTaskRecord = {
  readonly task_id: string
  readonly parent_session_id: string
  readonly root_session_id: string
  readonly status: string
  readonly created_at: string
  readonly name?: string
  readonly task_summary?: string
  readonly description?: string
  readonly started_at?: string
  readonly terminal_at?: string
  readonly category?: string
  readonly agent_type?: string
  readonly model?: string
}

export type ProjectTaskItem =
  | (ProjectTaskItemBase & { readonly kind: "main" })
  | (ProjectTaskItemBase & {
      readonly kind: "run"
      readonly run: { readonly name: string; readonly status: string }
    })
  | (ProjectTaskItemBase & { readonly kind: "task"; readonly task: ProjectTaskRecord })

export function assertNever(value: never): never {
  throw new TypeError(`Unexpected task tree variant: ${JSON.stringify(value)}`)
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
  const kind = (["main", "run", "task"] as const).find((candidate) => candidate === value["kind"])
  if (kind === undefined) throw new TypeError("API task tree item kind is unknown")
  const depth = requiredInteger(value, "depth")
  if (depth < 0) throw new TypeError("API task tree item depth must be non-negative")
  const lastSibling = value["lastSibling"]
  if (lastSibling !== undefined && typeof lastSibling !== "boolean") {
    throw new TypeError("API task tree item lastSibling must be a boolean")
  }
  const ancestorLastSiblings = value["ancestorLastSiblings"]
  if (ancestorLastSiblings !== undefined && (
    !Array.isArray(ancestorLastSiblings) || !ancestorLastSiblings.every((item) => typeof item === "boolean")
  )) throw new TypeError("API task tree item ancestorLastSiblings must be boolean values")
  const common: ProjectTaskItemBase = {
    id: requiredString(value, "id"),
    rootSessionId: requiredString(value, "rootSessionId"),
    depth,
    ...(typeof lastSibling === "boolean" ? { lastSibling } : {}),
    ...(Array.isArray(ancestorLastSiblings) ? { ancestorLastSiblings } : {}),
  }
  switch (kind) {
    case "main":
      return { ...common, kind }
    case "run": {
      const run = value["run"]
      if (!isRecord(run) || typeof run["name"] !== "string" || typeof run["status"] !== "string") {
        throw new TypeError("API run tree item must include a name and status")
      }
      return { ...common, kind, run: { name: run["name"], status: run["status"] } }
    }
    case "task": {
      const task = value["task"]
      if (!isRecord(task)) throw new TypeError("API task tree item must include a task")
      const optionalString = (key: string): string | undefined => {
        const field = task[key]
        if (field !== undefined && typeof field !== "string") {
          throw new TypeError(`API task ${key} must be a string`)
        }
        return typeof field === "string" ? field : undefined
      }
      const name = optionalString("name")
      const taskSummary = optionalString("task_summary")
      const description = optionalString("description")
      const startedAt = optionalString("started_at")
      const terminalAt = optionalString("terminal_at")
      const category = optionalString("category")
      const agentType = optionalString("agent_type")
      const model = optionalString("model")
      return {
        ...common,
        kind,
        task: {
          task_id: requiredString(task, "task_id"),
          parent_session_id: requiredString(task, "parent_session_id"),
          root_session_id: requiredString(task, "root_session_id"),
          status: requiredString(task, "status"),
          created_at: requiredString(task, "created_at"),
          ...(name === undefined ? {} : { name }),
          ...(taskSummary === undefined ? {} : { task_summary: taskSummary }),
          ...(description === undefined ? {} : { description }),
          ...(startedAt === undefined ? {} : { started_at: startedAt }),
          ...(terminalAt === undefined ? {} : { terminal_at: terminalAt }),
          ...(category === undefined ? {} : { category }),
          ...(agentType === undefined ? {} : { agent_type: agentType }),
          ...(model === undefined ? {} : { model }),
        },
      }
    }
    default: {
      return assertNever(kind)
    }
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
