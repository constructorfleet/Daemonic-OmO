import { afterEach, describe, expect, test } from "bun:test"
import { renameSync, rmSync, writeFileSync } from "node:fs"
import {
  formatSessionTranscript,
  formatTurnBody,
  lastTodoReport,
  parseSessionTurns,
  parseTodoReport,
  readRootDocument,
  readTaskDocument,
  safeText,
} from "@omo-daemonic/store"
import { childSessionFiles, taskEventLog } from "../../src/observer/session-files"
import { TranscriptDoc, type TranscriptSnapshot } from "../../src/observer/transcript-doc"
import { join } from "node:path"
import { appendJson, assistant, cleanTemps, fixtureTree, MIB, tempDir, text, toolResult, transcriptOptions } from "./support"

afterEach(cleanTemps)

function rootDoc(path: string): TranscriptDoc {
  const doc = new TranscriptDoc({ files: () => [path] }, transcriptOptions(4 * MIB))
  doc.poll()
  return doc
}

function taskDoc(stateDir: string, taskId: string): TranscriptDoc {
  const eventLog = taskEventLog(stateDir, taskId)
  const doc = new TranscriptDoc(
    { files: () => childSessionFiles(stateDir, taskId), ...(eventLog === undefined ? {} : { eventLog }) },
    transcriptOptions(4 * MIB),
  )
  doc.poll()
  return doc
}

function lines(snapshot: TranscriptSnapshot): readonly string[] {
  return snapshot.turns.flatMap((turn) => turn.lines)
}

/** The lines a client renders from a snapshot, the way the viewer lays out its transcript document. */
function viewLines(snapshot: TranscriptSnapshot): readonly string[] {
  if (snapshot.mode === "events") return snapshot.events
  return [...lines(snapshot), ...snapshot.errors.map((error) => `error: ${safeText(error)}`)]
}

describe("root session transcript doc", () => {
  test("bootstrap lines equal the viewer's formatSessionTranscript output", () => {
    const tree = fixtureTree()

    const snapshot = rootDoc(tree.rootSession).snapshot(500)

    const viewerTurns = parseSessionTurns(text(tree.rootSession))
    expect(lines(snapshot)).toEqual(formatSessionTranscript(viewerTurns, { toolDetail: true, thinkingPreview: true }))
    expect(lines(snapshot)).toEqual(readRootDocument(tree.agentDir, "sess-basic").lines)
  })

  test("an appended assistant entry produces exactly one turn.add", () => {
    const tree = fixtureTree()
    const doc = rootDoc(tree.rootSession)
    appendJson(tree.rootSession, assistant("a5", [{ type: "text", text: "One more thing." }]))

    const change = doc.poll()

    expect(change?.ops).toEqual([{ op: "turn.add", turn: expect.objectContaining({ id: "a5", lines: ["assistant: One more thing."] }) }])
  })

  test("a tool result for a known call patches the calling turn", () => {
    const tree = fixtureTree()
    const doc = rootDoc(tree.rootSession)
    appendJson(tree.rootSession, assistant("a5", [{ type: "toolCall", id: "call-9", name: "bash", arguments: { command: "pwd" } }]))
    appendJson(tree.rootSession, assistant("a6", [{ type: "text", text: "Waiting." }]))
    doc.poll()
    appendJson(tree.rootSession, toolResult("call-9", "bash", "/tmp/project-fixture"))

    const change = doc.poll()

    expect(change?.ops).toEqual([{
      op: "turn.patch",
      turnId: "a5",
      results: [{ callId: "call-9", name: "bash", isError: false, preview: "result(bash): /tmp/project-fixture", images: [] }],
      lines: ['tool: bash command="pwd"', "result(bash): /tmp/project-fixture"],
      byteEnd: Bun.file(tree.rootSession).size,
    }])
  })

  test("a tool result whose call is unknown attaches to the newest turn", () => {
    const tree = fixtureTree()
    const doc = rootDoc(tree.rootSession)
    appendJson(tree.rootSession, toolResult("call-unknown", "bash", "stray output"))

    const change = doc.poll()

    expect(change?.ops).toEqual([expect.objectContaining({ op: "turn.patch", turnId: "a4" })])
    expect(doc.snapshot(1).turns[0]?.lines.at(-1)).toBe("result(bash): stray output")
  })

  test("todo state is the last parseable todo result and a newer one emits todo.set", () => {
    const tree = fixtureTree()
    const doc = rootDoc(tree.rootSession)
    const report = "Overall: 3/3 done, 0 open.\n  Ship:\n    - [X] Ship it"
    appendJson(tree.rootSession, assistant("a5", [{ type: "toolCall", id: "call-10", name: "todo", arguments: { op: "done" } }]))
    appendJson(tree.rootSession, toolResult("call-10", "todo", report))

    const before = doc.snapshot(50).todo
    const change = doc.poll()

    expect(before).toEqual(lastTodoReport(parseSessionTurns(text(tree.rootSession).split("\n").slice(0, 16).join("\n"))) ?? null)
    expect(before?.done).toBe(2)
    expect(change?.ops.at(-1)).toEqual({ op: "todo.set", todo: parseTodoReport(report) ?? null })
  })

  test("a turn without id or timestamp keeps its offset id across polls", () => {
    const tree = fixtureTree()
    const doc = rootDoc(tree.rootSession)
    const firstId = doc.snapshot(50).turns[2]?.id ?? ""
    appendJson(tree.rootSession, assistant("a5", [{ type: "text", text: "later" }]))
    doc.poll()
    doc.poll()

    expect(firstId).toMatch(/^off:2026-11-25T08-00-00-000Z_sess-basic\.jsonl:\d+$/)
    expect(doc.snapshot(50).turns.map((turn) => turn.id)).toEqual(["a1", "a2", firstId, "a4", "a5"])
  })

  test("a range-read turn body equals the body of the same turn in a full parse", () => {
    const tree = fixtureTree()
    const doc = rootDoc(tree.rootSession)
    const full = parseSessionTurns(text(tree.rootSession))

    const bodies = doc.snapshot(50).turns.map((turn) => doc.turnBody(turn.id)?.lines)

    expect(bodies).toEqual(full.map((turn) => formatTurnBody(turn)))
  })

  test("turns before the tail window are paged by reading backwards from the oldest byteStart", () => {
    const path = join(tempDir("paging"), "session.jsonl")
    const ids = Array.from({ length: 12 }, (_, index) => `turn-${String(index).padStart(2, "0")}`)
    writeFileSync(path, "")
    for (const id of ids) appendJson(path, assistant(id, [{ type: "text", text: `body of ${id} padded to a steady size` }]))
    const doc = new TranscriptDoc({ files: () => [path] }, transcriptOptions(400))
    doc.poll()
    const window = doc.snapshot(50).turns

    const pages: string[][] = []
    let oldest = window[0]?.id ?? ""
    for (let more = true; more;) {
      const page = doc.olderTurns(oldest, 2)
      pages.unshift(page?.turns.map((turn) => turn.id) ?? [])
      oldest = page?.turns[0]?.id ?? ""
      more = page?.hasOlder === true && page.turns.length > 0
    }

    expect(window.length).toBeLessThan(ids.length)
    expect([...pages.flat(), ...window.map((turn) => turn.id)]).toEqual(ids)
    expect(doc.turnBody("turn-00")?.lines).toEqual(["ASSISTANT", "  body of turn-00 padded to a steady size", ""])
  })
})

describe("child task transcript doc", () => {
  test.each(["task-multi", "task-events"])("%s lines equal the viewer's task document", (taskId) => {
    const tree = fixtureTree()

    const snapshot = taskDoc(tree.stateDir, taskId).snapshot(500)

    expect(viewLines(snapshot)).toEqual(readTaskDocument(tree.stateDir, taskId).lines)
  })

  test("only the first and last session files are read and a reused id is keyed by file", () => {
    const tree = fixtureTree()

    const ids = taskDoc(tree.stateDir, "task-multi").snapshot(50).turns.map((turn) => turn.id)

    expect(ids).toEqual(["same-id", "2026-11-25T08-03-00-000Z_c.jsonl#same-id"])
  })

  test("a new child_error in the event log produces error.add once", () => {
    const tree = fixtureTree()
    const doc = taskDoc(tree.stateDir, "task-multi")
    const log = taskEventLog(tree.stateDir, "task-multi") ?? ""
    appendJson(log, { type: "child_error", payload: { message: "quota exceeded" } })
    appendJson(log, { type: "child_error", payload: { message: "provider overloaded" } })

    const change = doc.poll()

    expect(change?.ops).toEqual([{ op: "error.add", text: "quota exceeded" }])
  })
})

describe("transcript doc resets", () => {
  test("a file shorter than the read offset resets as truncated and rebuilds", () => {
    const tree = fixtureTree()
    const doc = rootDoc(tree.rootSession)
    const head = text(tree.rootSession).split("\n").slice(0, 5).join("\n")
    writeFileSync(tree.rootSession, `${head}\n`)

    const change = doc.poll()

    expect(change).toEqual({ reset: "truncated", ops: [] })
    expect(doc.snapshot(50).turns.map((turn) => turn.id)).toEqual(["a1"])
  })

  test("a replaced file resets as rotated and rebuilds from the new content", () => {
    const tree = fixtureTree()
    const doc = rootDoc(tree.rootSession)
    const replacement = `${tree.rootSession}.next`
    writeFileSync(replacement, `${JSON.stringify({ type: "session", version: 3, id: "sess-basic", cwd: "/tmp" })}\n`)
    appendJson(replacement, assistant("fresh", [{ type: "text", text: "new file" }]))
    renameSync(replacement, tree.rootSession)

    const change = doc.poll()

    expect(change).toEqual({ reset: "rotated", ops: [] })
    expect(doc.snapshot(50).turns.map((turn) => turn.id)).toEqual(["fresh"])
  })

  test("a deleted file resets as missing, keeps the last model and marks it gone", () => {
    const tree = fixtureTree()
    const doc = rootDoc(tree.rootSession)
    rmSync(tree.rootSession)

    const change = doc.poll()

    expect(change).toEqual({ reset: "missing", ops: [] })
    expect(doc.snapshot(50)).toMatchObject({ gone: true, turns: { length: 4 } })
  })
})
