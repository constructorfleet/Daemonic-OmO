import { afterEach, describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import type { DocFrame } from "../../src/api/services"
import { DocStream } from "../../src/observer/doc-stream"
import { TranscriptDoc } from "../../src/observer/transcript-doc"
import { appendJson, assistant, cleanTemps, fixtureTree, MIB, text, transcriptOptions } from "./support"

afterEach(cleanTemps)

const EPOCH = 7_000

function stream(path: string): DocStream {
  let epoch = EPOCH
  const doc = new TranscriptDoc({ files: () => [path] }, transcriptOptions(4 * MIB))
  return new DocStream("session:test:sess-basic", { poll: () => doc.poll(), snapshot: () => doc.snapshot(50) }, () => epoch++)
}

function collect(target: DocStream, epoch: number | null, rev: number | null): DocFrame[] {
  const frames: DocFrame[] = []
  target.subscribe((frame) => frames.push(frame), epoch, rev)
  return frames
}

function opNames(frame: DocFrame | undefined): unknown[] {
  return (frame?.ops ?? []).map((op) => typeof op === "object" && op !== null && "op" in op ? op.op : null)
}

describe("doc stream epoch and rev", () => {
  test("a resubscribe inside the ring replays exactly the missing deltas", () => {
    const tree = fixtureTree()
    const docs = stream(tree.rootSession)
    appendJson(tree.rootSession, assistant("a5", [{ type: "text", text: "five" }]))
    docs.refresh()
    appendJson(tree.rootSession, assistant("a6", [{ type: "text", text: "six" }]))
    docs.refresh()

    const frames = collect(docs, EPOCH, 1)

    expect(frames.map(({ epoch, fromRev, toRev }) => ({ epoch, fromRev, toRev }))).toEqual([{ epoch: EPOCH, fromRev: 1, toRev: 2 }])
    expect(opNames(frames[0])).toEqual(["turn.add"])
  })

  test("a resubscribe from another epoch gets a snapshot at the current rev", () => {
    const tree = fixtureTree()
    const docs = stream(tree.rootSession)
    appendJson(tree.rootSession, assistant("a5", [{ type: "text", text: "five" }]))
    docs.refresh()

    const frames = collect(docs, EPOCH - 1, 1)

    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({ epoch: EPOCH, fromRev: 1, toRev: 1 })
    expect(opNames(frames[0])).toEqual(["snapshot"])
  })

  test("a reset bumps the epoch, sends reset plus snapshot, and empties the ring", () => {
    const tree = fixtureTree()
    const docs = stream(tree.rootSession)
    appendJson(tree.rootSession, assistant("a5", [{ type: "text", text: "five" }]))
    docs.refresh()
    const live = collect(docs, EPOCH, 1)
    writeFileSync(tree.rootSession, `${text(tree.rootSession).split("\n").slice(0, 5).join("\n")}\n`)

    docs.refresh()
    const late = collect(docs, EPOCH, 1)

    expect(live.at(-1)).toMatchObject({ epoch: EPOCH + 1, fromRev: 0, toRev: 0 })
    expect(live.at(-1)?.ops[0]).toEqual({ op: "reset", reason: "truncated" })
    expect(opNames(live.at(-1))).toEqual(["reset", "snapshot"])
    expect(opNames(late[0])).toEqual(["snapshot"])
  })
})
