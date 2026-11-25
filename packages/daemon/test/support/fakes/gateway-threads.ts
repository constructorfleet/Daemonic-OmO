import { sessionId as toSessionId, threadId as toThreadId } from "../../../src/core/ids"
import type { ThreadSnapshot, ThreadState } from "../../../src/core/ports"
import type { SessionId, ThreadId } from "../../../src/core/types"

export interface SeedThreadInput {
  readonly name?: string
  readonly cwd?: string
  readonly state?: ThreadState
  readonly controls?: readonly string[]
}

export interface CreateThreadRecordInput {
  readonly name: string
  readonly cwd: string
  readonly model: string | null
  readonly visible: boolean
}

export interface FakeThreadRecord {
  readonly thread: ThreadId
  name: string
  cwd: string
  state: ThreadState
  controls: readonly string[]
  readonly sessionId: SessionId | null
  readonly surface: string | null
  model: string | null
  visible: boolean
  /** Held `unattended` after a host restart: only `releaseHold` starts a turn. */
  held: boolean
  readonly sentKeys: Set<string>
}

export class FakeThreadStore {
  private readonly threads = new Map<string, FakeThreadRecord>()
  private readonly idempotency = new Map<string, ThreadId>()
  private threadSeq = 0

  seed(input: SeedThreadInput = {}): ThreadId {
    const thread = this.newThreadId()
    this.threads.set(thread, {
      thread,
      name: input.name ?? `seeded-${thread}`,
      cwd: input.cwd ?? "/fake/project",
      state: input.state ?? "idle",
      controls: input.controls ?? ["interrupt", "close"],
      sessionId: toSessionId(`session-${thread}`),
      surface: "seeded",
      model: null,
      visible: true,
      held: false,
      sentKeys: new Set(),
    })
    return thread
  }

  create(input: CreateThreadRecordInput): FakeThreadRecord {
    const thread = this.newThreadId()
    const record: FakeThreadRecord = {
      thread,
      name: input.name,
      cwd: input.cwd,
      state: "idle",
      controls: ["interrupt", "close"],
      sessionId: toSessionId(`session-${thread}`),
      surface: "created",
      model: input.model,
      visible: input.visible,
      held: false,
      sentKeys: new Set(),
    }
    this.threads.set(thread, record)
    return record
  }

  bindIdempotencyKey(key: string, thread: ThreadId): void {
    this.idempotency.set(key, thread)
  }

  byIdempotencyKey(key: string): FakeThreadRecord | undefined {
    const thread = this.idempotency.get(key)
    return thread === undefined ? undefined : this.threads.get(thread)
  }

  find(thread: ThreadId): FakeThreadRecord | undefined {
    return this.threads.get(thread)
  }

  has(thread: ThreadId): boolean {
    return this.threads.has(thread)
  }

  require(thread: ThreadId): FakeThreadRecord {
    const found = this.threads.get(thread)
    if (found === undefined) {
      throw new RangeError(`FakeGateway: unknown thread ${thread}`)
    }
    return found
  }

  visible(): readonly FakeThreadRecord[] {
    return [...this.threads.values()].filter((thread) => thread.visible)
  }

  private newThreadId(): ThreadId {
    this.threadSeq += 1
    return toThreadId(`thread-${this.threadSeq}`)
  }
}

export function snapshot(thread: FakeThreadRecord): ThreadSnapshot {
  return {
    thread: thread.thread,
    name: thread.name,
    cwd: thread.cwd,
    state: thread.state,
    controls: [...thread.controls],
    sessionId: thread.sessionId,
    surface: thread.surface,
  }
}
