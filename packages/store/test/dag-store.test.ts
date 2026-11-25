import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"

import { loadDagRuns, readDagEvents } from "../src/dag-store.js"

const roots: string[] = []
const temp = (): string => {
  const root = mkdtempSync(join(tmpdir(), "omo-store-dag-"))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("loadDagRuns", () => {
  test("#given a partial v1 run record #when decoded #then known graph data and optional metadata survive", () => {
    const state = temp()
    mkdirSync(join(state, "dag", "runs"), { recursive: true })
    writeFileSync(join(state, "dag", "runs", "run.json"), readFileSync(join(import.meta.dir, "fixtures", "dag-run.json")))

    const snapshot = loadDagRuns(state)

    expect(snapshot.invalidRuns).toBe(0)
    expect(snapshot.runs).toMatchObject([{
      runId: "dag_fixture",
      runKey: "audit",
      parentSessionId: "session-fixture",
      rootSessionId: "session-fixture",
      nodes: [{ id: "inspect", prompt: "Inspect the project files.", attempt: 1 }],
    }])
  })

  test("#given a future schema version #when loaded #then its run is counted invalid", () => {
    const state = temp()
    mkdirSync(join(state, "dag", "runs"), { recursive: true })
    writeFileSync(join(state, "dag", "runs", "future.json"), JSON.stringify({
      schemaVersion: 2,
      runId: "future",
      parentSessionId: "session-a",
      rootSessionId: "session-a",
    }))

    expect(loadDagRuns(state)).toEqual({ runs: [], invalidRuns: 1 })
  })

  test("#given malformed and missing run stores #when loaded #then invalid data counts and absence is empty", () => {
    const state = temp()
    mkdirSync(join(state, "dag", "runs"), { recursive: true })
    writeFileSync(join(state, "dag", "runs", "bad.json"), "{")

    expect(loadDagRuns(state)).toEqual({ runs: [], invalidRuns: 1 })
    expect(loadDagRuns(temp())).toEqual({ runs: [], invalidRuns: 0 })
  })
})

describe("readDagEvents", () => {
  test("#given known and unknown event types #when tailed #then known events remain and unknown types count", () => {
    const state = temp()
    mkdirSync(join(state, "dag", "events"), { recursive: true })
    writeFileSync(join(state, "dag", "events", "dag_fixture.jsonl"), [
      JSON.stringify({ schemaVersion: 1, runId: "dag_fixture", seq: 1, at: "2026-11-25T08:00:00Z", lane: "boundary", type: "dag.run.started", generation: 1 }),
      JSON.stringify({ schemaVersion: 1, runId: "dag_fixture", seq: 2, at: "2026-11-25T08:00:01Z", lane: "boundary", type: "dag.future.event" }),
      "",
    ].join("\n"))

    expect(readDagEvents(state, "dag_fixture")).toEqual({
      events: [{ schemaVersion: 1, runId: "dag_fixture", seq: 1, at: "2026-11-25T08:00:00Z", lane: "boundary", type: "dag.run.started", generation: 1 }],
      invalidEvents: 0,
      unknownEvents: 1,
    })
  })

  test("#given an unknown event schema version #when tailed #then the event is rejected and counted invalid", () => {
    const state = temp()
    mkdirSync(join(state, "dag", "events"), { recursive: true })
    writeFileSync(join(state, "dag", "events", "dag_fixture.jsonl"), `${JSON.stringify({
      schemaVersion: 2, runId: "dag_fixture", seq: 1, at: "2026-11-25T08:00:00Z", lane: "boundary", type: "dag.run.started",
    })}\n`)

    expect(readDagEvents(state, "dag_fixture")).toEqual({ events: [], invalidEvents: 1, unknownEvents: 0 })
  })
})
