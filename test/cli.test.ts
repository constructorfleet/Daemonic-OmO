import { describe, expect, test } from "bun:test"

import { parseArgs } from "../src/main"

describe("CLI arguments", () => {
  test("#given project and state overrides #when parsed #then both paths are normalized", () => {
    const options = parseArgs(
      ["--project", "./repo", "--agent-dir", "./agent", "--state-dir", "./state", "--refresh-ms", "250"],
      "/tmp",
    )
    expect(options.projectDir).toBe("/tmp/repo")
    expect(options.agentDir).toBe("/tmp/agent")
    expect(options.stateDir).toBe("/tmp/state")
    expect(options.refreshMs).toBe(250)
  })

  test("#given an invalid refresh rate #when parsed #then a helpful error is returned", () => {
    expect(() => parseArgs(["--refresh-ms", "10"])).toThrow("--refresh-ms must be an integer")
  })

  test("#given an unknown option #when parsed #then it is rejected", () => {
    expect(() => parseArgs(["--someday"])).toThrow("unknown option")
  })

  test("#given wrap mode and arguments after -- #when parsed #then it forwards those arguments to omo", () => {
    const options = parseArgs(["--wrap", "--", "-c", "--resume"], "/tmp/project")
    expect(options.wrap).toBe(true)
    expect(options.omoArgs).toEqual(["-c", "--resume"])
  })
})
