import { createHash } from "node:crypto"
import { closeSync, fstatSync, openSync, readSync, statSync, type Stats } from "node:fs"

const CHUNK_BYTES = 1024 * 1024
const HEAD_PROBE_BYTES = 64 * 1024
const MAX_LINE_BYTES = 16 * 1024 * 1024

export interface JsonlLine {
  readonly text: string
  /** Byte offset of the line's first byte. */
  readonly start: number
  /** Byte offset just past the line's newline. */
  readonly end: number
}

export type CursorReset = "rotated" | "truncated" | "missing"

export interface CursorRead {
  readonly lines: readonly JsonlLine[]
  readonly reset?: CursorReset
  /** The lines are a fresh tail window starting at `windowStart`, not appends. */
  readonly bootstrap: boolean
  readonly windowStart: number
  readonly gone: boolean
  readonly oversizedLines: number
}

interface Identity {
  readonly dev: number
  readonly ino: number
  readonly size: number
  readonly mtimeMs: number
  readonly headSig: string | undefined
}

/**
 * The tail-reader contract of `@omo-daemonic/store`'s FileCursor (bootstrap the
 * last N bytes aligned to a newline, split on 0x0A before decoding, hold back a
 * trailing partial line, rotated/truncated/missing detection, skip lines over
 * 16 MiB) plus the byte range of every line, which turn range reads need and
 * FileCursor does not expose. An unchanged file costs one stat.
 */
export class JsonlCursor {
  #identity: Identity | undefined
  #offset = 0
  #skipping = false

  constructor(readonly path: string, readonly bootstrapBytes: number) {}

  read(): CursorRead {
    let info: Stats
    try {
      info = statSync(this.path)
    } catch (error) {
      if (!isMissing(error)) throw error
      const known = this.#identity !== undefined
      this.#clear()
      return { lines: [], ...(known ? { reset: "missing" as const } : {}), bootstrap: false, windowStart: 0, gone: true, oversizedLines: 0 }
    }
    const known = this.#identity
    if (known !== undefined && sameFile(known, info) && known.size === info.size && known.mtimeMs === info.mtimeMs) {
      return { lines: [], bootstrap: false, windowStart: 0, gone: false, oversizedLines: 0 }
    }
    const descriptor = openSync(this.path, "r")
    try {
      const opened = fstatSync(descriptor)
      const headSig = headSignature(descriptor, opened.size)
      const reset = known === undefined
        ? undefined
        : !sameFile(known, opened) || (known.headSig !== undefined && headSig !== known.headSig)
          ? "rotated"
          : opened.size < this.#offset ? "truncated" : undefined
      if (reset !== undefined) this.#clear()
      const bootstrap = this.#identity === undefined
      const windowStart = bootstrap ? Math.max(0, opened.size - this.bootstrapBytes) : this.#offset
      const scan = this.#scan(descriptor, windowStart, opened.size, bootstrap && windowStart > 0)
      this.#identity = {
        dev: opened.dev,
        ino: opened.ino,
        size: opened.size,
        mtimeMs: opened.mtimeMs,
        headSig: known?.headSig !== undefined && reset === undefined ? known.headSig : headSig,
      }
      return {
        lines: scan.lines,
        ...(reset === undefined ? {} : { reset }),
        bootstrap,
        windowStart: scan.firstLineStart,
        gone: false,
        oversizedLines: scan.oversized,
      }
    } finally {
      closeSync(descriptor)
    }
  }

  #clear(): void {
    this.#identity = undefined
    this.#offset = 0
    this.#skipping = false
  }

  #scan(descriptor: number, from: number, to: number, dropFirst: boolean) {
    const lines: JsonlLine[] = []
    let parts: Buffer[] = []
    let partBytes = 0
    let lineStart = from
    let dropping = dropFirst
    let oversized = 0
    let firstLineStart = dropFirst ? to : from
    for (let position = from; position < to; position += CHUNK_BYTES) {
      const chunk = readRange(descriptor, position, Math.min(to, position + CHUNK_BYTES))
      let index = 0
      for (let newline = chunk.indexOf(0x0a); newline >= 0; newline = chunk.indexOf(0x0a, index)) {
        const end = position + newline + 1
        const piece = chunk.subarray(index, newline)
        if (dropping) {
          dropping = false
          firstLineStart = end
        } else if (this.#skipping || partBytes + piece.length > MAX_LINE_BYTES) {
          this.#skipping = false
          oversized += 1
        } else if (partBytes + piece.length > 0) {
          lines.push({ text: Buffer.concat([...parts, piece]).toString("utf8"), start: lineStart, end })
        }
        parts = []
        partBytes = 0
        lineStart = end
        index = newline + 1
      }
      if (!dropping && !this.#skipping) {
        parts.push(chunk.subarray(index))
        partBytes += chunk.length - index
        if (partBytes > MAX_LINE_BYTES) {
          this.#skipping = true
          parts = []
          partBytes = 0
        }
      }
    }
    this.#offset = this.#skipping || dropping ? to : lineStart
    return { lines, oversized, firstLineStart }
  }
}

export function readRange(descriptor: number, start: number, end: number): Buffer {
  const output = Buffer.alloc(Math.max(0, end - start))
  let read = 0
  while (read < output.length) {
    const count = readSync(descriptor, output, read, Math.min(CHUNK_BYTES, output.length - read), start + read)
    if (count === 0) return output.subarray(0, read)
    read += count
  }
  return output
}

/** Complete lines inside `[start, end)` of a file, with their byte ranges; `align` drops the partial line `start` may fall inside. */
export function readLines(path: string, start: number, end: number, align: boolean): readonly JsonlLine[] {
  const descriptor = openSync(path, "r")
  try {
    const bytes = readRange(descriptor, start, end)
    const lines: JsonlLine[] = []
    let index = 0
    let dropping = align && start > 0
    for (let newline = bytes.indexOf(0x0a); newline >= 0; newline = bytes.indexOf(0x0a, index)) {
      if (!dropping && newline > index) {
        lines.push({ text: bytes.subarray(index, newline).toString("utf8"), start: start + index, end: start + newline + 1 })
      }
      dropping = false
      index = newline + 1
    }
    return lines
  } finally {
    closeSync(descriptor)
  }
}

function headSignature(descriptor: number, size: number): string | undefined {
  let head = readRange(descriptor, 0, Math.min(size, HEAD_PROBE_BYTES))
  if (head.indexOf(0x0a) < 0 && size > head.length) head = readRange(descriptor, 0, Math.min(size, CHUNK_BYTES))
  const newline = head.indexOf(0x0a)
  return newline < 0 ? undefined : createHash("sha256").update(head.subarray(0, newline + 1)).digest("hex")
}

function sameFile(identity: Identity, info: Stats): boolean {
  return identity.dev === info.dev && identity.ino === info.ino
}

export function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")
}
