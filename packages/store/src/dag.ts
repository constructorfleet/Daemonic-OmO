export type DagRoute =
  | { readonly kind: "category"; readonly category: string }
  | { readonly kind: "agent"; readonly agent: string; readonly model?: string }

export interface DagNodeRecord {
  readonly id: string
  readonly label?: string
  readonly state: string
  readonly route: DagRoute
  readonly dependsOn: readonly string[]
  readonly taskId?: string
  readonly createdAt?: string
  readonly startedAt?: string
  readonly completedAt?: string
  readonly attempt?: number
}

export interface DagWaveRecord {
  readonly index: number
  readonly nodeIds: readonly string[]
}

export interface DagRunRecord {
  readonly runId: string
  readonly name: string
  readonly status: string
  readonly rootSessionId: string
  readonly createdAt?: string
  readonly nodes: readonly DagNodeRecord[]
  readonly waves: readonly DagWaveRecord[]
}

const TERMINAL_NODE_STATES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled", "skipped"])

/** Node states whose activity and clocks are frozen. */
export function isTerminalDagState(state: string): boolean {
  return TERMINAL_NODE_STATES.has(state)
}

const NODE_STATE_RANKS: Readonly<Record<string, number>> = {
  running: 0,
  scheduled: 1,
  pending: 1,
  blocked: 1,
  paused: 1,
  failed: 2,
  completed: 3,
  skipped: 4,
  cancelled: 4,
}

/**
 * The daemon lists what is executing first, then what is waiting, then how it settled.
 * Mirrors `selectNodeRows` in omo-senpi's dag-status-row-format so the tree tells the same story.
 */
export function orderDagNodes(nodes: readonly DagNodeRecord[]): readonly DagNodeRecord[] {
  return nodes.toSorted((a, b) => {
    const rankDelta = nodeRank(a) - nodeRank(b)
    if (rankDelta !== 0) return rankDelta
    if (nodeRank(a) === 0) return startedAtValue(a) - startedAtValue(b)
    return recencyValue(b) - recencyValue(a)
  })
}

function nodeRank(node: DagNodeRecord): number {
  return NODE_STATE_RANKS[node.state] ?? 1
}

function startedAtValue(node: DagNodeRecord): number {
  const parsed = node.startedAt === undefined ? Number.NaN : Date.parse(node.startedAt)
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER
}

function recencyValue(node: DagNodeRecord): number {
  const parsed = Date.parse(node.completedAt ?? node.startedAt ?? "")
  return Number.isFinite(parsed) ? parsed : 0
}

export function decodeDagRun(value: unknown): DagRunRecord | undefined {
  if (!isRecord(value)) return undefined
  const runId = text(value.runId)
  if (runId === undefined) return undefined
  const rootSessionId = text(value.rootSessionId) ?? text(value.parentSessionId)
  if (rootSessionId === undefined) return undefined

  const nodes: DagNodeRecord[] = []
  if (Array.isArray(value.nodes)) {
    for (const entry of value.nodes) {
      const node = decodeDagNode(entry)
      if (node !== undefined) nodes.push(node)
    }
  }
  const knownIds = new Set(nodes.map((node) => node.id))
  const waves: DagWaveRecord[] = []
  if (Array.isArray(value.waves)) {
    for (const entry of value.waves) {
      if (!isRecord(entry)) continue
      const index = typeof entry.index === "number" && Number.isFinite(entry.index) ? entry.index : waves.length
      const nodeIds = Array.isArray(entry.nodeIds)
        ? entry.nodeIds.filter((id): id is string => typeof id === "string" && knownIds.has(id))
        : []
      waves.push({ index, nodeIds })
    }
    waves.sort((a, b) => a.index - b.index)
  }
  if (waves.length === 0 && nodes.length > 0) waves.push({ index: 0, nodeIds: nodes.map((node) => node.id) })

  return {
    runId,
    name: text(value.name) ?? runId,
    status: text(value.status) ?? "unknown",
    rootSessionId,
    ...(text(value.createdAt) === undefined ? {} : { createdAt: text(value.createdAt) }),
    nodes,
    waves,
  }
}

function decodeDagNode(value: unknown): DagNodeRecord | undefined {
  if (!isRecord(value)) return undefined
  const id = text(value.id)
  if (id === undefined) return undefined
  const dependsOn = Array.isArray(value.dependsOn)
    ? value.dependsOn.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : []
  const attempt = typeof value.attempt === "number" && Number.isFinite(value.attempt) ? value.attempt : undefined
  return {
    id,
    ...(text(value.label) === undefined ? {} : { label: text(value.label) }),
    state: text(value.state) ?? "pending",
    route: decodeRoute(value.route),
    dependsOn,
    ...(text(value.taskId) === undefined ? {} : { taskId: text(value.taskId) }),
    ...(text(value.createdAt) === undefined ? {} : { createdAt: text(value.createdAt) }),
    ...(text(value.startedAt) === undefined ? {} : { startedAt: text(value.startedAt) }),
    ...(text(value.completedAt) === undefined ? {} : { completedAt: text(value.completedAt) }),
    ...(attempt === undefined ? {} : { attempt }),
  }
}

function decodeRoute(value: unknown): DagRoute {
  if (isRecord(value) && value.kind === "agent") {
    const agent = text(value.agent) ?? "unknown"
    const model = text(value.model)
    return model === undefined ? { kind: "agent", agent } : { kind: "agent", agent, model }
  }
  const category = isRecord(value) ? text(value.category) : undefined
  return { kind: "category", category: category ?? "unspecified" }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
