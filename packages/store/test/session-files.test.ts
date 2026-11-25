import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"

import { readRootDocument, readSessionHeader } from "../src/index"

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("readRootDocument", () => {
  test("#given duplicate project-scoped session files #when read #then the newest mtime supplies the document", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "omo-store-"))
    roots.push(agentDir)
    const older = join(agentDir, "sessions", "--Users-x-a-b--", "2026-11-25T00-00-00-000Z_session-1.jsonl")
    const newer = join(agentDir, "sessions", "--Users-x-a--b--", "2026-11-24T00-00-00-000Z_session-1.jsonl")
    mkdirSync(join(agentDir, "sessions", "--Users-x-a-b--"), { recursive: true })
    mkdirSync(join(agentDir, "sessions", "--Users-x-a--b--"), { recursive: true })
    writeFileSync(
      older,
      `${JSON.stringify({
        id: "turn-old",
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "older session" }] },
      })}\n`,
    )
    writeFileSync(
      newer,
      `${JSON.stringify({
        id: "turn-new",
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "newest session" }] },
      })}\n`,
    )
    utimesSync(older, new Date("2026-11-25T00:00:00Z"), new Date("2026-11-25T00:00:00Z"))
    utimesSync(newer, new Date("2026-11-26T00:00:00Z"), new Date("2026-11-26T00:00:00Z"))

    expect(readRootDocument(agentDir, "session-1").lines).toEqual(["assistant: newest session"])
  })

  test("#given no legacy or project-scoped session file #when read #then it returns an empty document", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "omo-store-"))
    roots.push(agentDir)
    mkdirSync(join(agentDir, "sessions"))

    expect(readRootDocument(agentDir, "missing")).toEqual({ lines: [], lineTurns: [], turns: [] })
  })

  test("#given a session header #when read #then it returns the session identity and location", () => {
    const agentDir = mkdtempSync(join(tmpdir(), "omo-store-"))
    roots.push(agentDir)
    const path = join(agentDir, "session.jsonl")
    writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id: "session-1", cwd: "/Users/x/a-b" })}\n`)

    expect(readSessionHeader(path)).toEqual({ id: "session-1", cwd: "/Users/x/a-b", version: 3 })
  })
})
