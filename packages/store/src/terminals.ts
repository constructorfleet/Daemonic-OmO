/**
 * Monitors and background shells are not listed by any RPC call; the harness keeps their
 * current state in `work-custody` entries in the session JSONL. Each entry replaces the
 * previous one for its wake source, so the last record wins.
 *
 * The launching tool call (`monitor` / `bash` inside an `eval` cell) carries the arguments
 * that the custody record does not: filter, timeout, persistence, and the full command.
 */

export type TerminalKind = "monitor" | "shell"

export type TerminalWakeState = "open" | "passive"

export type SessionLifecycleState = "running" | "waiting_background" | "waiting_human" | "done" | "paused"

export interface TerminalItem {
  readonly id: string
  readonly kind: TerminalKind
  /** `open` while the session is parked on this watch, `passive` while it is busy elsewhere. */
  readonly state?: TerminalWakeState
  readonly description: string
  readonly startedAtMs?: number
  readonly command?: string
  readonly filter?: string
  readonly timeoutMs?: number
  readonly persistent?: boolean
}

export interface TerminalSnapshot {
  readonly items: readonly TerminalItem[]
  /** Last lifecycle state recorded by the session that owns these watches. */
  readonly sessionState?: SessionLifecycleState
}

const MONITOR_SOURCE = "terminal-monitors"
const SHELL_SOURCE = "terminal-background-sessions"
const LIFECYCLE_STATES = new Set<string>(["running", "waiting_background", "waiting_human", "done", "paused"])

const MONITOR_ID = /Monitor started with ID:\s*(mon_[A-Za-z0-9]+)/
const SHELL_ID = /background with ID:\s*(bash_\d+)/i

interface CustodyRecord {
  readonly state?: TerminalWakeState
  readonly items: readonly unknown[]
}

interface LaunchRecord {
  readonly description?: string
  readonly command?: string
  readonly filter?: string
  readonly timeoutMs?: number
  readonly persistent?: boolean
}

export function parseTerminals(text: string): TerminalSnapshot {
  const custody = new Map<TerminalKind, CustodyRecord>()
  const launches = new Map<string, LaunchRecord>()
  let sessionState: SessionLifecycleState | undefined

  for (const line of text.split("\n")) {
    if (!line.includes("work-custody") && !line.includes("session-lifecycle") && !line.includes('"toolCalls"')) continue
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (!isRecord(entry)) continue
    if (entry.type === "custom" && isRecord(entry.data)) {
      if (entry.customType === "work-custody") {
        const kind = wakeSourceKind(entry.data)
        if (kind !== undefined) {
          custody.set(kind, {
            ...(entry.data.state === "open" || entry.data.state === "passive" ? { state: entry.data.state } : {}),
            items: Array.isArray(entry.data.items) ? entry.data.items : [],
          })
        }
      } else if (entry.customType === "session-lifecycle" && typeof entry.data.state === "string" && LIFECYCLE_STATES.has(entry.data.state)) {
        sessionState = entry.data.state as SessionLifecycleState
      }
      continue
    }
    if (entry.type !== "message" || !isRecord(entry.message)) continue
    const details = isRecord(entry.message.details) ? entry.message.details : isRecord(entry.details) ? entry.details : undefined
    if (details === undefined || !Array.isArray(details.toolCalls)) continue
    for (const call of details.toolCalls) {
      if (!isRecord(call) || !isRecord(call.args)) continue
      const preview = typeof call.resultPreview === "string" ? call.resultPreview : ""
      const id = call.name === "monitor" ? MONITOR_ID.exec(preview)?.[1] : call.name === "bash" ? SHELL_ID.exec(preview)?.[1] : undefined
      if (id === undefined) continue
      launches.set(id, {
        ...(string(call.args.description) === undefined ? {} : { description: string(call.args.description) }),
        ...(string(call.args.command) === undefined ? {} : { command: string(call.args.command) }),
        ...(string(call.args.filter) === undefined ? {} : { filter: string(call.args.filter) }),
        ...(number(call.args.timeout_ms) === undefined ? {} : { timeoutMs: number(call.args.timeout_ms) }),
        ...(call.args.persistent === true ? { persistent: true } : {}),
      })
    }
  }

  const items: TerminalItem[] = []
  for (const kind of ["monitor", "shell"] as const) {
    const record = custody.get(kind)
    if (record === undefined) continue
    for (const raw of record.items) {
      if (!isRecord(raw)) continue
      const id = string(raw.id)
      if (id === undefined) continue
      const launch = launches.get(id)
      const description = string(raw.description) ?? string(raw.label) ?? launch?.description ?? launch?.command ?? id
      items.push({
        id,
        kind,
        ...(record.state === undefined ? {} : { state: record.state }),
        description,
        ...(startedAt(raw) === undefined ? {} : { startedAtMs: startedAt(raw) }),
        ...(launch?.command === undefined ? {} : { command: launch.command }),
        ...(launch?.filter === undefined ? {} : { filter: launch.filter }),
        ...(launch?.timeoutMs === undefined ? {} : { timeoutMs: launch.timeoutMs }),
        ...(launch?.persistent === true ? { persistent: true } : {}),
      })
    }
  }
  items.sort((a, b) => (b.startedAtMs ?? 0) - (a.startedAtMs ?? 0) || a.id.localeCompare(b.id))
  return { items, ...(sessionState === undefined ? {} : { sessionState }) }
}

function wakeSourceKind(record: Record<string, unknown>): TerminalKind | undefined {
  const source = record.source
  const key = record.key
  if (source === MONITOR_SOURCE || key === `wake-source:${MONITOR_SOURCE}`) return "monitor"
  if (source === SHELL_SOURCE || key === `wake-source:${SHELL_SOURCE}`) return "shell"
  return undefined
}

function startedAt(item: Record<string, unknown>): number | undefined {
  const millis = number(item.startedAtMs)
  if (millis !== undefined) return millis
  const seconds = number(item.startedAt)
  return seconds === undefined ? undefined : seconds * 1000
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
