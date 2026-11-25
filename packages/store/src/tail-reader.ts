import { createHash } from "node:crypto"
import { closeSync, fstatSync, openSync, readSync, statSync, type Stats } from "node:fs"

const CHUNK_BYTES = 1024 * 1024
const DEFAULT_BOOTSTRAP_BYTES = 4 * 1024 * 1024
const DEFAULT_MAX_LINE_BYTES = 16 * 1024 * 1024

export type FileCursorReset = "rotated" | "truncated" | "missing"
export type FileCursorUpdate = {
  readonly lines: readonly string[]
  readonly reset?: FileCursorReset
  readonly oversizedLines: number
  readonly gone: boolean
}

type CursorOptions = {
  readonly bootstrapBytes?: number
  readonly maxLineBytes?: number
}

/** Incremental UTF-8 JSONL reader; offsets always end at the last scanned byte. */
export class FileCursor {
  private dev: number | undefined
  private ino: number | undefined
  private offset = 0
  private headSig: string | undefined
  private carry: Buffer = Buffer.alloc(0)
  private skippingOversizedLine = false
  private readonly bootstrapBytes: number
  private readonly maxLineBytes: number

  constructor(readonly path: string, options: CursorOptions = {}) {
    this.bootstrapBytes = options.bootstrapBytes ?? DEFAULT_BOOTSTRAP_BYTES
    this.maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES
  }

  read(): FileCursorUpdate {
    let info: Stats
    try {
      info = statSync(this.path)
    } catch (error) {
      if (!isMissing(error)) throw error
      const reset = this.dev === undefined ? undefined : "missing"
      this.clear()
      return { lines: [], ...(reset === undefined ? {} : { reset }), oversizedLines: 0, gone: true }
    }

    const headSig = readHeadSignature(this.path)
    const reset = this.dev === undefined
      ? undefined
      : info.dev !== this.dev || info.ino !== this.ino
        ? "rotated"
        : info.size < this.offset
          ? "truncated"
          : this.headSig !== undefined && headSig !== this.headSig
            ? "rotated"
            : undefined
    if (reset !== undefined) this.clear()

    const descriptor = openSync(this.path, "r")
    try {
      const opened = fstatSync(descriptor)
      if (opened.dev !== info.dev || opened.ino !== info.ino) {
        this.clear()
        const lines = this.bootstrap(descriptor, opened.size)
        this.remember(opened, readHeadSignature(this.path))
        return { lines, reset: "rotated", oversizedLines: this.drainOversizedCount, gone: false }
      }
      const lines = this.dev === undefined
        ? this.bootstrap(descriptor, opened.size)
        : this.readAppends(descriptor, opened.size)
      this.remember(opened, headSig)
      const oversizedLines = this.drainOversizedCount
      this.drainOversizedCount = 0
      return { lines, ...(reset === undefined ? {} : { reset }), oversizedLines, gone: false }
    } finally {
      closeSync(descriptor)
    }
  }

  private drainOversizedCount = 0

  private clear(): void {
    this.dev = undefined
    this.ino = undefined
    this.offset = 0
    this.headSig = undefined
    this.carry = Buffer.alloc(0)
    this.skippingOversizedLine = false
    this.drainOversizedCount = 0
  }

  private remember(info: Stats, headSig: string | undefined): void {
    this.dev = info.dev
    this.ino = info.ino
    this.headSig ??= headSig
    this.offset = info.size
  }

  private bootstrap(descriptor: number, size: number): readonly string[] {
    const start = Math.max(0, size - this.bootstrapBytes)
    const bytes = readRange(descriptor, start, size)
    const newline = start > 0 ? bytes.indexOf(0x0a) : -1
    const aligned = start > 0 && newline < 0 ? Buffer.alloc(0) : start > 0 ? bytes.subarray(newline + 1) : bytes
    const lines: string[] = []
    for (let position = 0; position < aligned.length; position += CHUNK_BYTES) {
      lines.push(...this.split(aligned.subarray(position, Math.min(aligned.length, position + CHUNK_BYTES))))
    }
    return lines
  }

  private readAppends(descriptor: number, size: number): readonly string[] {
    const lines: string[] = []
    for (let position = this.offset; position < size; position += CHUNK_BYTES) {
      lines.push(...this.split(readRange(descriptor, position, Math.min(size, position + CHUNK_BYTES))))
    }
    return lines
  }

  private split(bytes: Buffer): readonly string[] {
    const lines: string[] = []
    const input = Buffer.concat([this.carry, bytes])
    this.carry = Buffer.alloc(0)
    let start = 0
    for (let index = 0; index < input.length; index += 1) {
      if (input[index] !== 0x0a) {
        if (this.skippingOversizedLine) continue
        if (index - start > this.maxLineBytes) {
          this.skippingOversizedLine = true
        }
        continue
      }
      if (this.skippingOversizedLine) {
        this.skippingOversizedLine = false
        this.drainOversizedCount += 1
      } else if (index - start <= this.maxLineBytes) {
        const line = input.subarray(start, index).toString("utf8")
        if (line.length > 0) lines.push(line)
      } else {
        this.drainOversizedCount += 1
      }
      start = index + 1
    }
    if (!this.skippingOversizedLine) this.carry = input.subarray(start)
    if (this.carry.length > this.maxLineBytes) {
      this.carry = Buffer.alloc(0)
      this.skippingOversizedLine = true
    }
    return lines
  }
}

function readRange(descriptor: number, start: number, end: number): Buffer {
  const output = Buffer.alloc(end - start)
  let read = 0
  while (read < output.length) read += readSync(descriptor, output, read, Math.min(CHUNK_BYTES, output.length - read), start + read)
  return output
}

function readHeadSignature(path: string): string | undefined {
  const descriptor = openSync(path, "r")
  try {
    const bytes = Buffer.alloc(CHUNK_BYTES)
    const count = readSync(descriptor, bytes, 0, bytes.length, 0)
    const content = bytes.subarray(0, count)
    const newline = content.indexOf(0x0a)
    return newline < 0 ? undefined : createHash("sha256").update(content.subarray(0, newline + 1)).digest("hex")
  } finally {
    closeSync(descriptor)
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")
}

export function readTailWindow(path: string, maxBytes = DEFAULT_BOOTSTRAP_BYTES): string {
  const descriptor = openSync(path, "r")
  try {
    const size = fstatSync(descriptor).size
    const start = Math.max(0, size - maxBytes)
    const text = readRange(descriptor, start, size).toString("utf8")
    const firstNewline = start > 0 ? text.indexOf("\n") : -1
    const aligned = firstNewline < 0 && start > 0 ? "" : firstNewline >= 0 ? text.slice(firstNewline + 1) : text
    const lastNewline = aligned.lastIndexOf("\n")
    return lastNewline < 0 ? "" : aligned.slice(0, lastNewline + 1)
  } finally {
    closeSync(descriptor)
  }
}
