import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { isMissing } from "./jsonl-cursor"

interface Cached<T> {
  readonly size: number
  readonly mtimeMs: number
  readonly value: T | undefined
}

export interface RecordScan<T> {
  readonly values: readonly T[]
  readonly invalid: number
}

/**
 * The `*.json` records of one directory, decoded with the store's decoder.
 * A rescan stats every file but re-reads only those whose size or mtime
 * changed; records over `maxBytes` or failing to decode count as invalid.
 */
export class RecordDir<T> {
  #cache = new Map<string, Cached<T>>()

  constructor(readonly directory: string, readonly decode: (value: unknown) => T | undefined, readonly maxBytes: number) {}

  scan(): RecordScan<T> {
    let names: string[]
    try {
      names = readdirSync(this.directory).filter((name) => name.endsWith(".json")).sort()
    } catch (error) {
      if (!isMissing(error)) throw error
      this.#cache = new Map()
      return { values: [], invalid: 0 }
    }
    const next = new Map<string, Cached<T>>()
    for (const name of names) {
      const path = join(this.directory, name)
      let info: ReturnType<typeof statSync>
      try {
        info = statSync(path)
      } catch (error) {
        if (isMissing(error)) continue
        throw error
      }
      const cached = this.#cache.get(name)
      const fresh = cached !== undefined && cached.size === info.size && cached.mtimeMs === info.mtimeMs
      next.set(name, fresh ? cached : { size: info.size, mtimeMs: info.mtimeMs, value: this.#read(path, info.size) })
    }
    this.#cache = next
    const values = [...next.values()].flatMap((entry) => entry.value === undefined ? [] : [entry.value])
    return { values, invalid: next.size - values.length }
  }

  #read(path: string, size: number): T | undefined {
    if (size > this.maxBytes) return undefined
    try {
      return this.decode(JSON.parse(readFileSync(path, "utf8")))
    } catch (error) {
      if (error instanceof SyntaxError || isMissing(error)) return undefined
      throw error
    }
  }
}
