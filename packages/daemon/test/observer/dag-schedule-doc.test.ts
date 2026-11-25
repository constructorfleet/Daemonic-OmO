import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DagDoc } from "../../src/observer/dag-doc"
import { ScheduleDoc } from "../../src/observer/schedule-doc"
import { childSessionFiles, taskEventLog } from "../../src/observer/session-files"
import { TranscriptDoc } from "../../src/observer/transcript-doc"
import { appendJson, assistant, cleanTemps, fixtureTree, imageCache, MIB, transcriptOptions } from "./support"

afterEach(cleanTemps)

function dagDoc(stateDir: string): DagDoc {
  const images = imageCache()
  const doc = new DagDoc(stateDir, "dag_fixture", (taskId) => {
    const eventLog = taskEventLog(stateDir, taskId)
    return new TranscriptDoc(
      { files: () => childSessionFiles(stateDir, taskId), ...(eventLog === undefined ? {} : { eventLog }) },
      transcriptOptions(4 * MIB, images),
    )
  })
  doc.poll()
  return doc
}

describe("dag doc", () => {
  test("the snapshot carries the run, its journal and live activity of attached tasks", () => {
    const tree = fixtureTree()

    const snapshot = dagDoc(tree.stateDir).snapshot()

    expect(snapshot.run?.runId).toBe("dag_fixture")
    expect(snapshot.events.map((event) => event.seq)).toEqual([1, 2])
    expect(snapshot.activity).toEqual([{
      nodeId: "inspect",
      taskId: "task-multi",
      turns: 2,
      lastTool: "edit",
      lastAssistant: "Resumed turn with a reused id.",
    }])
  })

  test("journal appends and attached-task turns become event.add and node.activity", () => {
    const tree = fixtureTree()
    const doc = dagDoc(tree.stateDir)
    appendJson(join(tree.stateDir, "dag", "events", "dag_fixture.jsonl"), {
      type: "dag.run.paused", schemaVersion: 1, runId: "dag_fixture", seq: 3, at: "2026-11-25T08:05:00.000Z", lane: "boundary",
    })
    const [last] = childSessionFiles(tree.stateDir, "task-multi").toReversed()
    appendJson(last ?? "", assistant("m3", [{ type: "toolCall", id: "mc-3", name: "bash", arguments: { command: "bun test" } }]))

    const change = doc.poll()

    expect(change?.ops).toEqual([
      { op: "event.add", events: [expect.objectContaining({ seq: 3, type: "dag.run.paused" })] },
      { op: "node.activity", activity: { nodeId: "inspect", taskId: "task-multi", turns: 3, lastTool: "bash", lastAssistant: "Resumed turn with a reused id." } },
    ])
  })
})

describe("schedule doc", () => {
  test("lists the agent dir's omo schedules and reports a cancellation tombstone", () => {
    const tree = fixtureTree()
    const doc = new ScheduleDoc(tree.agentDir, () => 1_790_000_000_000)
    doc.poll()
    const before = doc.snapshot().jobs.map((job) => [job.id, job.state, job.cancelled])
    mkdirSync(join(tree.agentDir, "schedule", "cancelled"))
    writeFileSync(join(tree.agentDir, "schedule", "cancelled", "sch_abcdefgh1234"), "")

    const change = doc.poll()

    expect(before).toEqual([["sch_abcdefgh1234", "pending", false]])
    expect(change?.ops).toEqual([{ op: "schedule.set", schedules: expect.objectContaining({ jobs: [expect.objectContaining({ id: "sch_abcdefgh1234", cancelled: true })] }) }])
  })
})
