import type { UserScope } from "../auth"
import type { Clock, TimerHandle } from "../core/ports"
import type { DaemonEvent, JsonObject } from "../core/types"
import type { EventLedger } from "../db/ledger"
import type { EventFeed } from "./feed"
import type { DocFrame } from "./services"

export const HEARTBEAT_MS = 15_000
const CATCH_UP_PAGE = 500
const encoder = new TextEncoder()

export interface SubscriberDeps {
  readonly feed: EventFeed
  readonly ledger: EventLedger
  readonly clock: Clock
  readonly maxFrames: number
  readonly maxBytes: number
  readonly incarnation: string
}

export interface SubscriberInit {
  readonly streamId: string
  readonly scope: UserScope
  /** Last cursor the client holds; null starts live at the current head. */
  readonly since: number | null
  readonly onRelease: () => void
}

interface QueuedFrame {
  readonly text: string
  readonly bytes: number
  readonly cursor: number | null
}

type Phase = "catch_up" | "live" | "closing"
type ResetReason = "cursor_expired" | "incarnation_changed"

function frame(event: string, data: JsonObject, id: number | null = null): string {
  const idLine = id === null ? "" : `id: ${id}\n`
  return `${idLine}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function queued(text: string, cursor: number | null): QueuedFrame {
  return { text, bytes: Buffer.byteLength(text), cursor }
}

/**
 * One SSE connection. Gap-free resume: the ledger listener is attached before
 * the head is read, the backlog `since < cursor <= highWater` is paged from
 * the database one page per pull (so it honors backpressure and new commits
 * land in the queue meanwhile), then the queue is drained without anything at
 * or below highWater and the stream goes live. The queue is bounded by
 * maxFrames/maxBytes; overflow drops it and closes after the frames already
 * handed to the stream, and the client resumes from its last entity id.
 */
export class StreamSubscriber {
  readonly stream: ReadableStream<Uint8Array>
  readonly #deps: SubscriberDeps
  readonly #init: SubscriberInit
  readonly #detach: () => void
  readonly #highWater: number
  readonly #docs = new Map<string, () => void>()
  #queue: QueuedFrame[] = []
  #queuedBytes = 0
  #phase: Phase
  #cursor: number
  #wake: (() => void) | null = null
  #heartbeat: TimerHandle | null = null
  #released = false
  #cancelled = false

  constructor(deps: SubscriberDeps, init: SubscriberInit) {
    this.#deps = deps
    this.#init = init
    this.#detach = deps.ledger.subscribe((event) => this.#onEvent(event))
    this.#highWater = deps.feed.head(init.scope)
    this.#cursor = init.since ?? this.#highWater
    const reset = this.#resetReason()
    this.#phase = this.#cursor < this.#highWater ? "catch_up" : "live"
    const hello = frame("hello", { streamId: init.streamId, headSeq: this.#highWater, incarnation: deps.incarnation })
    this.stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        if (reset === null) {
          controller.enqueue(encoder.encode(hello))
          return
        }
        controller.enqueue(encoder.encode(hello + frame("reset", { reason: reset, headSeq: this.#highWater })))
        controller.close()
        this.#release()
      },
      pull: (controller) => this.#pull(controller),
      cancel: () => {
        this.#cancelled = true
        this.#release()
      },
    }, { highWaterMark: 0 })
    if (reset === null) this.#armHeartbeat()
  }

  get released(): boolean {
    return this.#released
  }

  addDoc(docId: string, unsubscribe: () => void): void {
    if (this.#released) {
      unsubscribe()
      return
    }
    this.#docs.get(docId)?.()
    this.#docs.set(docId, unsubscribe)
  }

  removeDoc(docId: string): boolean {
    const unsubscribe = this.#docs.get(docId)
    if (unsubscribe === undefined) return false
    this.#docs.delete(docId)
    unsubscribe()
    return true
  }

  pushDoc(doc: DocFrame): void {
    this.#push(queued(frame("doc", { ...doc }), null))
  }

  close(): void {
    this.#closeSoon()
  }

  #resetReason(): ResetReason | null {
    if (this.#cursor > this.#highWater) return "incarnation_changed"
    if (this.#cursor === this.#highWater) return null
    const oldest = this.#deps.feed.oldest(this.#init.scope)
    return oldest === null || oldest > this.#cursor + 1 ? "cursor_expired" : null
  }

  #onEvent(event: DaemonEvent): void {
    const { feed } = this.#deps
    if (!feed.includes(this.#init.scope, event)) return
    const cursor = feed.cursorOf(this.#init.scope, event)
    this.#push(queued(frame("entity", feed.payload(this.#init.scope, event), cursor), cursor))
  }

  #push(entry: QueuedFrame): void {
    if (this.#phase === "closing") return
    this.#queue.push(entry)
    this.#queuedBytes += entry.bytes
    if (this.#queue.length > this.#deps.maxFrames || this.#queuedBytes > this.#deps.maxBytes) {
      this.#closeSoon()
      return
    }
    this.#wakeReader()
  }

  #closeSoon(): void {
    this.#phase = "closing"
    this.#queue = []
    this.#queuedBytes = 0
    this.#release()
    this.#wakeReader()
  }

  #wakeReader(): void {
    const wake = this.#wake
    this.#wake = null
    wake?.()
  }

  async #pull(controller: ReadableStreamDefaultController<Uint8Array>): Promise<void> {
    for (;;) {
      if (this.#cancelled) return
      if (this.#phase === "closing") {
        controller.close()
        return
      }
      if (this.#phase === "catch_up") {
        const text = this.#catchUpPage()
        if (text === null) {
          controller.enqueue(encoder.encode(frame("reset", { reason: "cursor_expired", headSeq: this.#highWater })))
          this.#closeSoon()
          continue
        }
        if (text.length > 0) {
          controller.enqueue(encoder.encode(text))
          return
        }
        continue
      }
      if (this.#queue.length > 0) {
        const chunk = this.#queue.map((entry) => entry.text).join("")
        this.#queue = []
        this.#queuedBytes = 0
        controller.enqueue(encoder.encode(chunk))
        return
      }
      await new Promise<void>((resolve) => {
        this.#wake = resolve
      })
    }
  }

  /** The next backlog page as frames; null when the backlog has a hole (pruned meanwhile). */
  #catchUpPage(): string | null {
    const { feed } = this.#deps
    const scope = this.#init.scope
    const page = feed.page(scope, this.#cursor, this.#highWater, CATCH_UP_PAGE)
    if (page.length === 0) return null
    let text = ""
    for (const event of page) {
      const cursor = feed.cursorOf(scope, event)
      if (cursor !== this.#cursor + 1) return null
      text += frame("entity", feed.payload(scope, event), cursor)
      this.#cursor = cursor
    }
    if (this.#cursor >= this.#highWater) this.#goLive()
    return text
  }

  #goLive(): void {
    this.#phase = "live"
    this.#queue = this.#queue.filter((entry) => entry.cursor === null || entry.cursor > this.#highWater)
    this.#queuedBytes = this.#queue.reduce((total, entry) => total + entry.bytes, 0)
  }

  #armHeartbeat(): void {
    const { clock, feed } = this.#deps
    this.#heartbeat = clock.setTimer(clock.now() + HEARTBEAT_MS, () => {
      this.#push(queued(frame("heartbeat", { headSeq: feed.head(this.#init.scope) }), null))
      if (!this.#released) this.#armHeartbeat()
    })
  }

  #release(): void {
    if (this.#released) return
    this.#released = true
    this.#detach()
    if (this.#heartbeat !== null) this.#deps.clock.clearTimer(this.#heartbeat)
    for (const unsubscribe of this.#docs.values()) unsubscribe()
    this.#docs.clear()
    this.#init.onRelease()
  }
}
