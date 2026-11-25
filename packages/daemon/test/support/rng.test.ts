import { describe, expect, test } from "bun:test"
import { SeededRng } from "./fakes"

describe("SeededRng", () => {
  test("the same seed produces the same float sequence", () => {
    const left = new SeededRng(7)
    const right = new SeededRng(7)

    const leftValues = Array.from({ length: 8 }, () => left.next())
    const rightValues = Array.from({ length: 8 }, () => right.next())

    expect(leftValues).toEqual(rightValues)
    for (const value of leftValues) {
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })

  test("nextInt stays inside the requested bound", () => {
    const rng = new SeededRng(11)

    const values = Array.from({ length: 200 }, () => rng.nextInt(10))

    for (const value of values) {
      expect(Number.isInteger(value)).toBe(true)
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(10)
    }
  })

  test("nextBytes returns the requested length deterministically", () => {
    const first = new SeededRng(99).nextBytes(16)
    const second = new SeededRng(99).nextBytes(16)

    expect(first).toHaveLength(16)
    expect([...first]).toEqual([...second])
  })

  test("rejects a negative byte count", () => {
    expect(() => new SeededRng(1).nextBytes(-1)).toThrow(RangeError)
  })
})
