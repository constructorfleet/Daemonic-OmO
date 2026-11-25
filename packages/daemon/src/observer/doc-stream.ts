import type { DocFrame } from "../api/services"
import type { JsonValue } from "../core/types"
import type { DocChange } from "./transcript-doc"

export const DELTA_RING = 256

/** A projection a DocStream drives: `poll` reports what changed since the last call (the first call bootstraps). */
export interface StreamDoc {
  poll(): DocChange<unknown> | null
  snapshot(): unknown
}

export type FrameSink = (frame: DocFrame) => void

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true
  if (Array.isArray(value)) return value.every(isJsonValue)
  return typeof value === "object" && Object.values(value).every(isJsonValue)
}

/** Ops and snapshots are plain data; the round trip freezes them at emit time and drops undefined fields. */
export function toJson(value: unknown): JsonValue {
  const copy: unknown = JSON.parse(JSON.stringify(value) ?? "null")
  if (!isJsonValue(copy)) throw new TypeError("document value is not JSON")
  return copy
}

/**
 * Versioning for one document: every batch of ops is one frame `{fromRev, toRev}`
 * kept in a ring of the last 256; a reset starts a new epoch at rev 0. A
 * subscriber holding `{epoch, rev}` inside the ring gets the missing frames,
 * anyone else a snapshot. Epochs come from `nextEpoch` so a recreated document
 * never repeats one.
 */
export class DocStream {
  readonly #sinks = new Set<FrameSink>()
  #ring: DocFrame[] = []
  #epoch: number
  #rev = 0

  constructor(readonly docId: string, readonly doc: StreamDoc, readonly nextEpoch: () => number) {
    doc.poll()
    this.#epoch = nextEpoch()
  }

  get subscribers(): number {
    return this.#sinks.size
  }

  get epoch(): number {
    return this.#epoch
  }

  get rev(): number {
    return this.#rev
  }

  refresh(): boolean {
    const change = this.doc.poll()
    if (change === null) return false
    if (change.reset !== undefined) {
      this.#epoch = this.nextEpoch()
      this.#rev = 0
      this.#ring = []
      this.#send({ ...this.#snapshotFrame(), ops: [toJson({ op: "reset", reason: change.reset }), this.#snapshotOp()] })
      return true
    }
    if (change.ops.length === 0) return false
    const frame: DocFrame = { docId: this.docId, epoch: this.#epoch, fromRev: this.#rev, toRev: this.#rev + 1, ops: change.ops.map(toJson) }
    this.#rev += 1
    this.#ring = [...this.#ring, frame].slice(-DELTA_RING)
    this.#send(frame)
    return true
  }

  subscribe(sink: FrameSink, epoch: number | null, rev: number | null): () => void {
    const oldest = this.#ring[0]?.fromRev ?? this.#rev
    if (epoch === this.#epoch && rev !== null && rev >= oldest && rev <= this.#rev) {
      for (const frame of this.#ring) if (frame.fromRev >= rev) sink(frame)
    } else {
      sink(this.#snapshotFrame())
    }
    this.#sinks.add(sink)
    return () => {
      this.#sinks.delete(sink)
    }
  }

  #snapshotOp(): JsonValue {
    const snapshot = toJson(this.doc.snapshot())
    return typeof snapshot === "object" && snapshot !== null && !Array.isArray(snapshot)
      ? { op: "snapshot", ...snapshot }
      : { op: "snapshot", value: snapshot }
  }

  #snapshotFrame(): DocFrame {
    return { docId: this.docId, epoch: this.#epoch, fromRev: this.#rev, toRev: this.#rev, ops: [this.#snapshotOp()] }
  }

  #send(frame: DocFrame): void {
    for (const sink of [...this.#sinks]) sink(frame)
  }
}
