import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { copyFile, rm } from "node:fs/promises"
import { join } from "node:path"

import { threadId } from "../../src/core/ids"
import { OmoCli } from "../../src/omo/host"
import { FakeClock } from "../support/fakes"
import { OMO_FIXTURES, PARENT_ENV, STUB_OMO, stubInstall, value, type StubInstall } from "./support"

let install: StubInstall
let cli: OmoCli

beforeEach(async () => {
  install = await stubInstall()
  cli = new OmoCli({ bin: STUB_OMO, agentDir: install.agentDir, baseEnv: PARENT_ENV, clock: new FakeClock() })
})

afterEach(async () => {
  await install.dispose()
})

const THREAD = threadId("113daa4d-5213-86d1-96c7-dd79ecda491a")

describe("OmoCli host helpers against a stub omo binary", () => {
  test("ensureHost runs `omo daemon run --json --pinned` and reports start, then reuse", async () => {
    expect(value(await cli.ensureHost())).toEqual({ started: true, pid: 4242 })
    expect(value(await cli.ensureHost())).toEqual({ started: false, pid: 4242 })
    expect((await install.read("stub-omo-calls.log")).trim().split("\n")).toEqual(["daemon run --json --pinned", "daemon run --json --pinned"])
  })

  test("a failed host start is host_unavailable with the stderr tail", async () => {
    await install.touch("stub-daemon-fail")
    expect(await cli.ensureHost()).toEqual({ kind: "error", code: "host_unavailable", message: "omo daemon run exited 1: daemon: run failed" })
  })

  test("sessionState reads the unattended hold from `omo host session state <thread> --json`", async () => {
    await cli.ensureHost()
    await copyFile(join(OMO_FIXTURES, "host-session-state-held.json"), install.file("stub-session-state.json"))
    expect(value(await cli.sessionState(THREAD))).toEqual({ thread: THREAD, held: true, paused: true, holds: ["unattended"], lifecycle: "held" })
    expect((await install.read("stub-omo-calls.log")).trim().split("\n").at(-1)).toBe(`host session state ${THREAD} --json`)
  })

  test("releaseHold delivers engine input through `omo host session prompt <thread> <text>`", async () => {
    await cli.ensureHost()
    expect(value(await cli.releaseHold(THREAD, "Resume the interrupted task."))).toEqual({ disposition: "started" })
    expect((await install.read("stub-omo-calls.log")).trim().split("\n").at(-1)).toBe(`host session prompt ${THREAD} Resume the interrupted task.`)
  })

  test("exit 3 from a host session command is host_unavailable", async () => {
    await cli.ensureHost()
    await rm(install.file("host-up"))
    const answered = await cli.releaseHold(THREAD, "x")
    expect(answered.kind === "error" ? answered.code : answered.kind).toBe("host_unavailable")
  })

  test("omo runs with the allowlisted environment only", async () => {
    await cli.ensureHost()
    const env = Object.fromEntries((await install.read("stub-omo-env.txt")).trim().split("\n").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]))
    expect(env.BUN_INSTALL).toBeUndefined()
    expect(JSON.stringify(env)).not.toContain("leaked-")
    expect(env.OMO_CODING_AGENT_DIR).toBe(install.agentDir)
    expect(env.PATH).not.toContain("/.omo-daemonic/runtime/")
  })
})
