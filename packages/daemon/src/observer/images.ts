import { createHash } from "node:crypto"

export interface StoredImage {
  readonly mimeType: string
  readonly bytes: Uint8Array<ArrayBuffer>
}

/** Tool-result images decoded from session entries, keyed by the sha256 of their bytes; least recently used go first. */
export class ImageCache {
  readonly #entries = new Map<string, StoredImage>()
  #bytes = 0

  constructor(readonly maxBytes: number) {}

  put(mimeType: string, base64: string): string {
    const bytes = new Uint8Array(Buffer.from(base64, "base64"))
    const sha256 = createHash("sha256").update(bytes).digest("hex")
    const existing = this.#entries.get(sha256)
    if (existing !== undefined) {
      this.#entries.delete(sha256)
      this.#entries.set(sha256, existing)
      return sha256
    }
    this.#entries.set(sha256, { mimeType, bytes })
    this.#bytes += bytes.length
    for (const [key, entry] of this.#entries) {
      if (this.#bytes <= this.maxBytes || key === sha256) break
      this.#entries.delete(key)
      this.#bytes -= entry.bytes.length
    }
    return sha256
  }

  get(sha256: string): StoredImage | undefined {
    const entry = this.#entries.get(sha256)
    if (entry === undefined) return undefined
    this.#entries.delete(sha256)
    this.#entries.set(sha256, entry)
    return entry
  }
}
