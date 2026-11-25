import type { DagNodeRecord, DagRunRecord } from "./dag.js"
import { isTerminalDagState, orderDagNodes } from "./dag.js"

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
  readonly kind: "main" | "run" | "task"
  readonly rootSessionId: string
  readonly depth: number
  readonly task?: TaskRecord
  /** For run rows: the DAG snapshot the row summarizes. */
  readonly run?: DagRunRecord
  /** For DAG node rows: the node that attached the task (or the node itself when unattached). */
  readonly node?: DagNodeRecord
  /** For live DAG node rows: newest assistant activity read from the task log. */
  readonly activity?: string
  /** For tasks: whether this is the last child at its depth, so the tree can close its branch. */
  readonly lastSibling?: boolean
  /** For tasks: whether each ancestor is a last child, so deeper levels keep their vertical guides. */
  readonly ancestorLastSiblings?: readonly boolean[]
}

export interface TaskTreeProjectionOptions {
  /** DAG runs to nest under their root session, newest first. */
  readonly runs?: readonly DagRunRecord[]
  /** Latest activity text keyed by attached task id. */
  readonly activity?: ReadonlyMap<string, string>
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

interface TreeBuild {
  readonly id: string
  readonly kind: "run" | "task"
  readonly task?: TaskRecord
  readonly run?: DagRunRecord
  readonly node?: DagNodeRecord
  readonly activity?: string
  readonly children: readonly TreeBuild[]
}

export function projectTaskTree(
  records: readonly TaskRecord[],
  options: TaskTreeProjectionOptions = {},
): readonly TaskTreeItem[] {
  const runs = options.runs ?? []
  const roots = [
    ...new Set([
      ...records.map((record) => record.root_session_id || record.parent_session_id),
      ...runs.map((run) => run.rootSessionId),
    ]),
  ].sort()
  const byParent = new Map<string, TaskRecord[]>()
  for (const record of records) {
    const siblings = byParent.get(record.parent_session_id)
    if (siblings === undefined) byParent.set(record.parent_session_id, [record])
    else siblings.push(record)
  }
  const byId = new Map(records.map((record) => [record.task_id, record] as const))

  const items: TaskTreeItem[] = []
  for (const rootSessionId of roots) {
    items.push({ id: `main:${rootSessionId}`, kind: "main", rootSessionId, depth: 0 })
    const inRoot = records.filter(
      (record) => record.root_session_id === rootSessionId || record.parent_session_id === rootSessionId,
    )
    const inRootIds = new Set(inRoot.map((record) => record.task_id))
    const seen = new Set<string>()
    const childrenOf = (sessionId: string): readonly TaskRecord[] =>
      (byParent.get(sessionId) ?? [])
        .filter((record) => inRootIds.has(record.task_id) && !seen.has(record.task_id))
        .toSorted(compareRecords)

    const buildTask = (record: TaskRecord, node?: DagNodeRecord): TreeBuild | undefined => {
      if (seen.has(record.task_id)) return undefined
      seen.add(record.task_id)
      const activity =
        node?.taskId === undefined || isTerminalDagState(node.state)
          ? undefined
          : options.activity?.get(node.taskId)
      const children = record.child_session_id === undefined ? [] : childrenOf(record.child_session_id)
      return {
        id: record.task_id,
        kind: "task",
        task: record,
        ...(node === undefined ? {} : { node }),
        ...(activity === undefined ? {} : { activity }),
        children: children.flatMap((child) => {
          const built = buildTask(child)
          return built === undefined ? [] : [built]
        }),
      }
    }
    const buildRun = (run: DagRunRecord): TreeBuild => {
      const nodes = orderDagNodes(run.nodes)
      return {
        id: `run:${run.runId}`,
        kind: "run",
        run,
        children: nodes.flatMap((node) => {
          const attached = node.taskId === undefined ? undefined : byId.get(node.taskId)
          const record =
            attached !== undefined && inRootIds.has(attached.task_id) && !seen.has(attached.task_id)
              ? attached
              : syntheticNodeRecord(rootSessionId, run, node)
          const built = buildTask(record, node)
          return built === undefined ? [] : [built]
        }),
      }
    }

    const runBuilds = runs
      .filter((run) => run.rootSessionId === rootSessionId)
      .toSorted(compareRuns)
      .map(buildRun)
    const top = childrenOf(rootSessionId).flatMap((record) => {
      const built = buildTask(record)
      return built === undefined ? [] : [built]
    })
    // Records whose parent session is missing still need to be reachable under their root.
    const orphans = inRoot.filter((record) => !seen.has(record.task_id)).toSorted(compareRecords)
    const loose = orphans.flatMap((record) => {
      const built = buildTask(record)
      return built === undefined ? [] : [built]
    })
    const children = [...runBuilds, ...top, ...loose]

    const emit = (
      build: TreeBuild,
      depth: number,
      lastSibling: boolean,
      ancestorLastSiblings: readonly boolean[],
    ): void => {
      items.push({
        id: build.id,
        kind: build.kind,
        rootSessionId,
        depth,
        lastSibling,
        ...(build.task === undefined ? {} : { task: build.task }),
        ...(build.run === undefined ? {} : { run: build.run }),
        ...(build.node === undefined ? {} : { node: build.node }),
        ...(build.activity === undefined ? {} : { activity: build.activity }),
        ...(ancestorLastSiblings.length === 0 ? {} : { ancestorLastSiblings }),
      })
      const childAncestors = [...ancestorLastSiblings, lastSibling]
      build.children.forEach((child, index) =>
        emit(child, depth + 1, index === build.children.length - 1, childAncestors),
      )
    }
    children.forEach((build, index) => emit(build, 1, index === children.length - 1, []))
  }
  return items
}

function syntheticNodeRecord(rootSessionId: string, run: DagRunRecord, node: DagNodeRecord): TaskRecord {
  const route = node.route
  const created = node.createdAt ?? run.createdAt ?? ""
  return {
    task_id: `dag:${run.runId}:${node.id}`,
    parent_session_id: rootSessionId,
    root_session_id: rootSessionId,
    status: node.state,
    created_at: created,
    ...(node.startedAt === undefined ? {} : { started_at: node.startedAt }),
    ...(node.completedAt === undefined || !isTerminalDagState(node.state) ? {} : { terminal_at: node.completedAt }),
    name: node.label ?? node.id,
    ...(route.kind === "category" ? { category: route.category } : { agent_type: route.agent }),
    ...(route.kind === "agent" && route.model !== undefined ? { model: route.model } : {}),
  }
}

function compareRuns(a: DagRunRecord, b: DagRunRecord): number {
  return dateValue(b.createdAt ?? "") - dateValue(a.createdAt ?? "") || a.runId.localeCompare(b.runId)
}

function compareRecords(a: TaskRecord, b: TaskRecord): number {
  return dateValue(a.created_at) - dateValue(b.created_at) || a.task_id.localeCompare(b.task_id)
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
