import { describe, expect, test } from "bun:test"
import {
  isUuidv7,
  parseUlid,
  sessionId,
  threadId,
  ulid,
  ulidTime,
  uuidv7,
  uuidv7Time,
} from "../../src/core/ids"
import { SeededRng } from "./fakes"

const AT = 1_700_000_000_000

describe("ids", () => {
  test("ulid produces a 26-char Crockford id that carries its timestamp", () => {
    const id = ulid(new SeededRng(42), AT)

    expect(id).toHaveLength(26)
    expect(parseUlid(id)).toBe(id)
    expect(ulidTime(id)).toBe(AT)
  })

  test("uuidv7 carries the timestamp and RFC 4122 version and variant bits", () => {
    const id = uuidv7(new SeededRng(42), AT)

    expect(isUuidv7(id)).toBe(true)
    expect(uuidv7Time(id)).toBe(AT)
  })

  test("isUuidv7 rejects non-hexadecimal digits", () => {
    expect(isUuidv7("gggggggg-gggg-7ggg-8ggg-gggggggggggg")).toBe(false)
  })

  test("both id shapes are deterministic for a seeded rng", () => {
    const firstUlid = ulid(new SeededRng(5), AT)
    const secondUlid = ulid(new SeededRng(5), AT)
    const firstUuid = uuidv7(new SeededRng(5), AT)
    const secondUuid = uuidv7(new SeededRng(5), AT)

    expect(firstUlid).toBe(secondUlid)
    expect(firstUuid).toBe(secondUuid)
  })

  test("parseUlid rejects a malformed id", () => {
    expect(parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FAI")).toBeNull()
    expect(parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FA")).toBeNull()
    expect(parseUlid("")).toBeNull()
  })

  test("parseUlid rejects 26-character values that exceed the 48-bit timestamp", () => {
    const maximum = `7${"0".repeat(25)}`
    const overflow = `8${"0".repeat(25)}`

    expect(parseUlid(maximum)?.toString()).toBe(maximum)
    expect(parseUlid(overflow)).toBeNull()
  })

  test("threadId and sessionId reject empty values", () => {
    expect(() => threadId("")).toThrow(RangeError)
    expect(() => sessionId("")).toThrow(RangeError)
    expect(String(threadId("odm-run-1"))).toBe("odm-run-1")
  })
})
