import { describe, expect, test } from "bun:test"
import { FsError } from "../../src/core/ports"
import { FakeFs } from "./fakes"

describe("FakeFs", () => {
  test("readFileRange returns exactly the requested byte slice", async () => {
    const fs = await FakeFs.create()
    try {
      await fs.write("a.txt", "0123456789")

      const bytes = await fs.readFileRange("a.txt", 2, 4)

      expect(new TextDecoder().decode(bytes)).toBe("2345")
      const stat = await fs.stat("a.txt")
      expect(stat.size).toBe(10)
      expect(stat.kind).toBe("file")
    } finally {
      await fs.dispose()
    }
  })

  test("a missing path rejects stat with not_found and reports a null watch hint", async () => {
    const fs = await FakeFs.create()
    try {
      let caught: unknown = null
      try {
        await fs.stat("missing.txt")
      } catch (error) {
        caught = error
      }

      expect(caught).toBeInstanceOf(FsError)
      if (!(caught instanceof FsError)) throw new Error("expected FsError")
      expect(caught.code).toBe("not_found")
      expect(await fs.watchHint("missing.txt")).toBeNull()
    } finally {
      await fs.dispose()
    }
  })

  test("readdir reports names with file and directory kinds", async () => {
    const fs = await FakeFs.create()
    try {
      await fs.write("a.txt", "a")
      await fs.mkdir("sub")

      const entries = await fs.readdir(".")

      expect([...entries].sort((left, right) => left.name.localeCompare(right.name))).toEqual([
        { name: "a.txt", kind: "file" },
        { name: "sub", kind: "directory" },
      ])
    } finally {
      await fs.dispose()
    }
  })

  test("watchHint changes when a file's content changes", async () => {
    const fs = await FakeFs.create()
    try {
      await fs.write("a.txt", "one")
      const first = await fs.watchHint("a.txt")
      await fs.write("a.txt", "two")

      const second = await fs.watchHint("a.txt")

      expect(first).not.toBeNull()
      expect(second?.size).toBe(3)
      expect(second?.ino).toBe(first?.ino)
      expect(second?.mtimeMs).toBeGreaterThanOrEqual(first?.mtimeMs ?? 0)
      expect(second?.size).not.toBeUndefined()
    } finally {
      await fs.dispose()
    }
  })
})
