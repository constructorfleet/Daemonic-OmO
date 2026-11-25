import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { OmoCli } from "../../src/omo/host"
import { runCompatProbe, TESTED_OMO_VERSION, type CompatReport } from "../../src/omo/probe"
import { FakeClock, FakeGateway } from "../support/fakes"
import { PARENT_ENV, STUB_OMO, stubInstall, type StubInstall } from "./support"

let install: StubInstall
let clock: FakeClock

beforeEach(async () => {
  install = await stubInstall()
  clock = new FakeClock({ wallMs: Date.parse("2026-11-25T09:00:00.000Z") })
})

afterEach(async () => {
  await install.dispose()
})

function probe(gateway: FakeGateway): Promise<CompatReport> {
  const cli = new OmoCli({ bin: STUB_OMO, agentDir: install.agentDir, baseEnv: PARENT_ENV, clock })
  return runCompatProbe({ clock, fs: install.fs, targets: [{ agentDir: install.agentDir, gateway, cli }] })
}

const verdicts = (report: CompatReport) => Object.fromEntries(report.checks.map((check) => [check.name, check.ok]))

async function put(relative: string, content: string): Promise<void> {
  const path = join(install.agentDir, relative)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

describe("compatibility probe", () => {
  test("a healthy omo passes every check and records presets and the agent-dir-default mode", async () => {
    const report = await probe(new FakeGateway())
    expect(report).toMatchObject({ omoVersion: TESTED_OMO_VERSION, testedVersion: TESTED_OMO_VERSION, permissionMode: "agent-dir-default", checkedAt: "2026-11-25T09:00:00.000Z" })
    expect(report.presets).toEqual(["full-access", "workspace", "accept-edits", "auto", "read-only"])
    expect(verdicts(report)).toEqual({
      "omo.version": true,
      "sdk.load": true,
      "thread.list": true,
      "schedule.list": true,
      "task.records": true,
      "session.files": true,
      "dag.schemaVersion": true,
    })
    expect(report.checks.filter((check) => check.name !== "omo.version").every((check) => check.agentDir === install.agentDir)).toBe(true)
  })

  test("an SDK that cannot load fails sdk.load by name and skips the list round trip", async () => {
    const report = await probe(new FakeGateway({ sdkLoad: "fail" }))
    const named = (name: string) => report.checks.find((check) => check.name === name)
    expect(named("sdk.load")).toMatchObject({ ok: false, detail: "fake sdk failed to load" })
    expect(named("thread.list")).toMatchObject({ ok: false, detail: "skipped: sdk.load failed" })
    expect(report.presets).toEqual([])
  })

  test("an omo version other than the tested one fails omo.version", async () => {
    await install.touch("stub-omo-version", "omo 5.2.0 (engine: senpi 2026.12.01-1)\n")
    const report = await probe(new FakeGateway())
    expect(report.omoVersion).toBe("5.2.0")
    expect(report.checks.find((check) => check.name === "omo.version")).toMatchObject({ ok: false, detail: `omo 5.2.0; contract tested against ${TESTED_OMO_VERSION}` })
  })

  test("decoders count invalid task records, session files, DAG journals and schedules", async () => {
    await put("projects/p-0123/senpi-task/tasks/good.json", JSON.stringify({ task_id: "t1", status: "running" }))
    await put("projects/p-0123/senpi-task/tasks/bad.json", "{")
    await put("sessions/--project--/2026-11-25T08-00-00-000Z_abc.jsonl", `${JSON.stringify({ type: "session", id: "abc", cwd: "/p" })}\n{}\n`)
    await put("sessions/--project--/2026-11-25T08-00-01-000Z_def.jsonl", "garbage\n")
    await put("projects/p-0123/senpi-task/dag/events/run-1.jsonl", `${JSON.stringify({ schemaVersion: 1, runId: "run-1", seq: 1 })}\n`)
    await put("projects/p-0123/senpi-task/dag/events/run-2.jsonl", `${JSON.stringify({ schemaVersion: 2, runId: "run-2", seq: 1 })}\n`)
    await install.touch("stub-schedule.json", JSON.stringify({ jobs: [{ id: "s1" }], invalid: [{ path: "x.json" }], runners: [] }))

    const report = await probe(new FakeGateway())
    const details = Object.fromEntries(report.checks.map((check) => [check.name, `${check.ok} ${check.detail}`]))
    expect(details["task.records"]).toBe("false 1 of 2 task records invalid")
    expect(details["session.files"]).toBe("false 1 of 2 session files invalid")
    expect(details["dag.schemaVersion"]).toBe("false 1 of 2 DAG journals have an unknown schemaVersion (2)")
    expect(details["schedule.list"]).toBe("false 1 of 2 schedules invalid")
  })
})
