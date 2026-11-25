import type { Rng } from "../../../src/core/ports"

export class SeededRng implements Rng {
  private state: number

  constructor(seed: number) {
    if (!Number.isInteger(seed)) {
      throw new RangeError(`SeededRng: seed must be an integer, got ${seed}`)
    }
    this.state = seed >>> 0
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) | 0
    let value = this.state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }

  nextInt(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
      throw new RangeError(`SeededRng.nextInt: maxExclusive must be a positive integer, got ${maxExclusive}`)
    }
    return Math.floor(this.next() * maxExclusive)
  }

  nextBytes(count: number): Uint8Array {
    if (!Number.isInteger(count) || count < 0) {
      throw new RangeError(`SeededRng.nextBytes: count must be a non-negative integer, got ${count}`)
    }
    const bytes = new Uint8Array(count)
    for (let index = 0; index < count; index++) {
      bytes[index] = this.nextInt(256)
    }
    return bytes
  }
}
