import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "bun:test"

import { listOmoSchedules } from "../src/omo-schedule-store.js"

const roots: string[] = []
const temp = (): string => {
  const root = mkdtempSync(join(tmpdir(), "omo-store-schedule-"))
  roots.push(root)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const job = readFileSync(join(import.meta.dir, "fixtures", "scheduled-job.json"), "utf8")
const jobId = "sch_abcdefgh1234"

describe("listOmoSchedules", () => {
  test("#given malformed schedule JSON #when listed #then its record is counted invalid", () => {
    const agent = temp()
    mkdirSync(join(agent, "schedule", "pending"), { recursive: true })
    writeFileSync(join(agent, "schedule", "pending", "broken.json"), "{")

    expect(listOmoSchedules(agent)).toMatchObject({ jobs: [], invalidRecords: 1 })
  })

  test("#given absent schedule state directories #when listed #then the result is empty", () => {
    expect(listOmoSchedules(temp())).toMatchObject({ jobs: [], invalidRecords: 0, liveRunners: [] })
  })

  test("#given a pending job and extensionless cancelled tombstone #when listed #then the job is cancelled", () => {
    const agent = temp()
    mkdirSync(join(agent, "schedule", "pending"), { recursive: true })
    mkdirSync(join(agent, "schedule", "cancelled"), { recursive: true })
    writeFileSync(join(agent, "schedule", "pending", `${jobId}.json`), job)
    writeFileSync(join(agent, "schedule", "cancelled", jobId), "")

    expect(listOmoSchedules(agent).jobs).toEqual([{
      id: jobId,
      sessionId: "session-fixture",
      sessionFile: null,
      cwd: "/tmp/project-fixture",
      prompt: "Inspect the project files.",
      createdAt: 1790000000000,
      dueAt: 1790000060000,
      everyMs: null,
      fireCount: 0,
      lastFiredAt: null,
      lastError: null,
      state: "pending",
      cancelled: true,
    }])
  })

  test("#given schedule records in pending firing and failed #when listed #then each state is preserved", () => {
    const agent = temp()
    for (const state of ["pending", "firing", "failed"] as const) {
      mkdirSync(join(agent, "schedule", state), { recursive: true })
      const filename = state === "pending" ? `${jobId}.json` : state === "firing" ? `${jobId}@1~9-1.json` : `${jobId}@1.json`
      writeFileSync(join(agent, "schedule", state, filename), job)
    }

    expect(listOmoSchedules(agent).jobs.map((entry) => entry.state)).toEqual(["pending", "firing", "failed"])
  })

  test("#given real runner process metadata #when liveness is checked #then dead reused and stale leases are excluded", () => {
    const agent = temp()
    const runners = join(agent, "schedule", "runners")
    mkdirSync(runners, { recursive: true })
    const now = Date.now()
    writeFileSync(join(runners, "2147483647.json"), JSON.stringify({
      pid: 2147483647, processStartedAtMs: 1, beatAt: now, watch: true,
    }))
    writeFileSync(join(runners, `${process.pid}.json`), JSON.stringify({
      pid: process.pid, processStartedAtMs: 1, beatAt: now, watch: true,
    }))
    writeFileSync(join(runners, "1.json"), JSON.stringify({
      pid: 1, processStartedAtMs: 1, beatAt: now - 6 * 60 * 1000, watch: true,
    }))
    writeFileSync(join(runners, "2.json"), readFileSync(join(import.meta.dir, "fixtures", "schedule-runner.json")))
    writeFileSync(join(runners, "3.json"), "{")

    expect(listOmoSchedules(agent, { now })).toMatchObject({ liveRunners: [], invalidRecords: 1 })
  })

  test("#given a live process with a matching ps start time #when listed #then its fresh runner lease is live", () => {
    const agent = temp()
    const runners = join(agent, "schedule", "runners")
    mkdirSync(runners, { recursive: true })
    const now = Date.now()
    const processInfo = spawnSync("ps", ["-p", String(process.pid), "-o", "lstart="], { encoding: "utf8" })
    const processStartedAtMs = Date.parse(processInfo.stdout.trim())
    writeFileSync(join(runners, `${process.pid}.json`), JSON.stringify({
      pid: process.pid, processStartedAtMs, beatAt: now, watch: true,
    }))

    expect(listOmoSchedules(agent, { now }).liveRunners).toMatchObject([
      { pid: process.pid, processStartedAtMs, beatAt: now, watch: true },
    ])
  })
})
