import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, truncateSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"

import { discoverProjects } from "../src/project-discovery.js"
import { FileCursor } from "../src/tail-reader.js"

const roots: string[] = []
const temp = (): string => {
  const root = mkdtempSync(join(tmpdir(), "omo-store-tail-"))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("discoverProjects", () => {
  test("#given sessions with a hyphenated cwd #when discovered #then the newest header path is resolved directly", () => {
    const agent = temp()
    const cwd = "/tmp/a-b/c--d"
    const sessions = join(agent, "sessions", "unrelated-folder-name")
    mkdirSync(sessions, { recursive: true })
    const older = join(sessions, "123_session-old.jsonl")
    const newer = join(sessions, "456_session-new.jsonl")
    writeFileSync(older, `${JSON.stringify({ type: "session", id: "session-old", cwd, version: 3 })}\n`)
    writeFileSync(newer, `${JSON.stringify({ type: "session", id: "session-new", cwd, version: 3 })}\n`)
    utimesSync(older, new Date("2026-11-25T08:00:00Z"), new Date("2026-11-25T08:00:00Z"))
    utimesSync(newer, new Date("2026-11-25T09:00:00Z"), new Date("2026-11-25T09:00:00Z"))

    expect(discoverProjects(agent)).toMatchObject([{ cwd, latestSessionId: "session-new", stateDir: expect.any(String) }])
  })
})

describe("FileCursor", () => {
  test("#given a line split across appends #when polled #then it emits only after newline", () => {
    const path = join(temp(), "events.jsonl")
    writeFileSync(path, "")
    const cursor = new FileCursor(path)

    expect(cursor.read().lines).toEqual([])
    appendFileSync(path, '{"type":"one"')
    expect(cursor.read().lines).toEqual([])
    appendFileSync(path, '}\n')
    expect(cursor.read().lines).toEqual(['{"type":"one"}'])
  })

  test("#given a multibyte character split by the one mebibyte read boundary #when polled #then UTF-8 stays intact", () => {
    const path = join(temp(), "multibyte.jsonl")
    const prefix = "x".repeat(1024 * 1024 - 1)
    writeFileSync(path, `${prefix}é\n`)
    const cursor = new FileCursor(path)

    expect(cursor.read().lines).toEqual([`${prefix}é`])
  })

  test("#given a partial trailing line #when polled #then it remains held until newline arrives", () => {
    const path = join(temp(), "partial.jsonl")
    writeFileSync(path, '{"complete":true}\n{"pending":')
    const cursor = new FileCursor(path)

    expect(cursor.read().lines).toEqual(['{"complete":true}'])
    appendFileSync(path, "false}\n")
    expect(cursor.read().lines).toEqual(['{"pending":false}'])
  })

  test("#given a copied event fixture is truncated #when polled #then it resets and rebuilds before rotation and removal", () => {
    const root = temp()
    const path = join(root, "rotating.jsonl")
    copyFileSync(join(import.meta.dir, "fixtures", "dag-events.jsonl"), path)
    const cursor = new FileCursor(path)
    expect(cursor.read().lines).toHaveLength(1)

    truncateSync(path, 0)
    expect(cursor.read()).toMatchObject({ reset: "truncated", lines: [] })
    appendFileSync(path, '{"type":"rebuilt"}\n')
    expect(cursor.read().lines).toEqual(['{"type":"rebuilt"}'])

    const replacement = join(root, "replacement")
    writeFileSync(replacement, "second\n")
    renameSync(replacement, path)
    expect(cursor.read().reset).toBe("rotated")

    rmSync(path)
    expect(cursor.read().reset).toBe("missing")
  })

  test("#given an overlong record #when polled #then it is skipped and counted", () => {
    const path = join(temp(), "large.jsonl")
    writeFileSync(path, "")
    const cursor = new FileCursor(path)
    cursor.read()
    appendFileSync(path, `${"x".repeat(16 * 1024 * 1024 + 1)}\n{"ok":true}\n`)

    expect(cursor.read()).toMatchObject({ lines: ['{"ok":true}'], oversizedLines: 1 })
  })

  test("#given a file larger than the bootstrap window #when bootstrapped #then it begins on a complete line", () => {
    const path = join(temp(), "aligned.jsonl")
    const row = `${"a".repeat(1024 * 1024 - 2)}\n`
    writeFileSync(path, row.repeat(5))
    const cursor = new FileCursor(path, { bootstrapBytes: 4 * 1024 * 1024 })

    expect(cursor.read().lines).toEqual([row.slice(0, -1), row.slice(0, -1), row.slice(0, -1), row.slice(0, -1)])
  })
})
