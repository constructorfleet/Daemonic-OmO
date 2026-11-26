import { describe, expect, it } from "bun:test"
import { applyTranscriptFrame, parseTranscriptState } from "./model"

const image = { sha256: "a".repeat(64), mimeType: "image/png" }
const turn = {
  id: "turn-1",
  summary: "assistant: first",
  lines: ["assistant: first"],
  calls: [{ id: "call-1", name: "read" }],
  results: [],
}

function state() {
  return parseTranscriptState({
    docId: "session:agent:root",
    epoch: 5,
    rev: 2,
    snapshot: {
      mode: "session",
      turns: [turn],
      hasOlder: false,
      todo: null,
      errors: [],
      events: [],
      gone: false,
    },
  })
}

describe("transcript document reducer", () => {
  it("appends a turn.add operation to the current transcript", () => {
    const before = state()
    const updated = applyTranscriptFrame(before, {
      docId: before.docId,
      epoch: before.epoch,
      fromRev: before.rev,
      toRev: before.rev + 1,
      ops: [{ op: "turn.add", turn: { ...turn, id: "turn-2", summary: "assistant: second" } }],
    })

    expect(updated?.snapshot.turns.map((item) => item.id)).toEqual(["turn-1", "turn-2"])
    expect(updated?.rev).toBe(3)
  })

  it("patches a turn result and sets the latest todo state", () => {
    const before = state()
    const updated = applyTranscriptFrame(before, {
      docId: before.docId,
      epoch: before.epoch,
      fromRev: before.rev,
      toRev: before.rev + 1,
      ops: [
        {
          op: "turn.patch",
          turnId: "turn-1",
          lines: ["tool: read path=src", "result(read): image"],
          results: [{ callId: "call-1", name: "read", isError: false, preview: "result(read): image", images: [image] }],
        },
        {
          op: "todo.set",
          todo: {
            done: 1,
            total: 2,
            open: 1,
            now: "Build the tree",
            next: "Check the transcript",
            phases: [{ name: "Build", items: [{ text: "Build the tree", status: "in_progress" }] }],
            remaining: [],
          },
        },
      ],
    })

    expect(updated?.snapshot.turns[0]?.lines).toEqual(["tool: read path=src", "result(read): image"])
    expect(updated?.snapshot.turns[0]?.results[0]?.images).toEqual([image])
    expect(updated?.snapshot.todo).toMatchObject({ done: 1, total: 2, now: "Build the tree" })
  })

  it("adds child errors and event-log lines without losing session turns", () => {
    const before = state()
    const updated = applyTranscriptFrame(before, {
      docId: before.docId,
      epoch: before.epoch,
      fromRev: before.rev,
      toRev: before.rev + 1,
      ops: [
        { op: "error.add", text: "child process failed" },
        { op: "event.add", lines: ["error: child process failed"] },
      ],
    })

    expect(updated?.snapshot.errors).toEqual(["child process failed"])
    expect(updated?.snapshot.events).toEqual(["error: child process failed"])
    expect(updated?.snapshot.turns).toEqual([turn])
  })

  it("rejects a stale revision and replaces state with the reset snapshot", () => {
    const before = state()
    const gap = applyTranscriptFrame(before, {
      docId: before.docId,
      epoch: before.epoch,
      fromRev: before.rev + 1,
      toRev: before.rev + 2,
      ops: [],
    })
    const reset = applyTranscriptFrame(before, {
      docId: before.docId,
      epoch: before.epoch + 1,
      fromRev: 0,
      toRev: 0,
      ops: [
        { op: "reset", reason: "missing" },
        {
          op: "snapshot",
          mode: "session",
          turns: [],
          hasOlder: false,
          todo: null,
          errors: [],
          events: [],
          gone: true,
        },
      ],
    })

    expect(gap).toBeNull()
    expect(reset).toMatchObject({ epoch: 6, rev: 0, snapshot: { gone: true, turns: [] } })
  })
})
