export interface TaskRecord {
  readonly task_id: string
  readonly parent_session_id: string
  readonly root_session_id: string
  readonly child_session_id?: string
  readonly status: string
  readonly created_at: string
  readonly started_at?: string
  readonly terminal_at?: string
  readonly name?: string
  readonly task_summary?: string
  readonly description?: string
  readonly category?: string
  readonly agent_type?: string
  readonly model?: string
  readonly depth?: number
}

export interface TaskTreeItem {
  readonly id: string
  readonly kind: "main" | "task"
  readonly rootSessionId: string
  readonly depth: number
  readonly task?: TaskRecord
}

export function decodeTaskRecord(value: unknown): TaskRecord | undefined {
  if (!isRecord(value)) return undefined
  const taskId = string(value.task_id)
  const parent = string(value.parent_session_id)
  if (taskId === undefined || parent === undefined || !/^[A-Za-z0-9_-]+$/.test(taskId)) return undefined
  const root = string(value.root_session_id) ?? parent
  return {
    task_id: taskId,
    parent_session_id: parent,
    root_session_id: root,
    status: string(value.status) ?? "unknown",
    created_at: string(value.created_at) ?? "",
    ...(string(value.child_session_id) === undefined ? {} : { child_session_id: string(value.child_session_id) }),
    ...(string(value.started_at) === undefined ? {} : { started_at: string(value.started_at) }),
    ...(string(value.terminal_at) === undefined ? {} : { terminal_at: string(value.terminal_at) }),
    ...(string(value.name) === undefined ? {} : { name: string(value.name) }),
    ...(string(value.task_summary) === undefined ? {} : { task_summary: string(value.task_summary) }),
    ...(string(value.description) === undefined ? {} : { description: string(value.description) }),
    ...(string(value.category) === undefined ? {} : { category: string(value.category) }),
    ...(string(value.agent_type) === undefined ? {} : { agent_type: string(value.agent_type) }),
    ...(string(value.model) === undefined ? {} : { model: string(value.model) }),
    ...(typeof value.depth === "number" && Number.isFinite(value.depth) ? { depth: value.depth } : {}),
  }
}

export function projectTaskTree(records: readonly TaskRecord[]): readonly TaskTreeItem[] {
  const roots = [...new Set(records.map((record) => record.root_session_id || record.parent_session_id))].sort()
  const childrenBySession = new Map<string, TaskRecord>()
  for (const record of records) {
    if (record.child_session_id !== undefined) childrenBySession.set(record.child_session_id, record)
  }

  const items: TaskTreeItem[] = []
  for (const rootSessionId of roots) {
    items.push({ id: `main:${rootSessionId}`, kind: "main", rootSessionId, depth: 0 })
    const tasks = records
      .filter((record) => record.root_session_id === rootSessionId || record.parent_session_id === rootSessionId)
      .toSorted((a, b) => dateValue(a.created_at) - dateValue(b.created_at) || a.task_id.localeCompare(b.task_id))
    for (const task of tasks) {
      items.push({
        id: task.task_id,
        kind: "task",
        rootSessionId,
        depth: taskDepth(task, rootSessionId, childrenBySession),
        task,
      })
    }
  }
  return items
}

function taskDepth(task: TaskRecord, root: string, childrenBySession: ReadonlyMap<string, TaskRecord>): number {
  let depth = 1
  let parent = task.parent_session_id
  const seen = new Set([task.task_id])
  while (parent !== root && depth < 12) {
    const ancestor = childrenBySession.get(parent)
    if (ancestor === undefined || seen.has(ancestor.task_id)) break
    seen.add(ancestor.task_id)
    depth += 1
    parent = ancestor.parent_session_id
  }
  return depth
}

function dateValue(value: string): number {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
