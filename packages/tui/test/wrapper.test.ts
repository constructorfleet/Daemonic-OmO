import { describe, expect, test } from "bun:test"

import { buildTmuxPlan, runTmuxPlan } from "../src/wrapper"

describe("tmux wrapper plan", () => {
  test("#given an OmO launch and project with spaces #when building a plan #then it opens OmO and viewer panes in that project", () => {
    const plan = buildTmuxPlan({
      projectDir: "/work/my project",
      sessionName: "omo-agents-42",
      omoArgs: ["--resume", "session id"],
      viewerCommand: ["bun", "/app/main.js", "--project", "/work/my project"],
      insideTmux: true,
    })

    expect(plan).toEqual([
      ["new-session", "-d", "-s", "omo-agents-42", "-n", "omo", "-c", "/work/my project", "exec 'omo' '--resume' 'session id'"],
      ["split-window", "-h", "-t", "omo-agents-42:omo", "-c", "/work/my project", "exec 'bun' '/app/main.js' '--project' '/work/my project'"],
      ["select-pane", "-l", "-t", "omo-agents-42:omo"],
      ["switch-client", "-t", "omo-agents-42"],
    ])
  })

  test("#given a shell argument with quotes #when building the pane command #then it is passed literally", () => {
    const plan = buildTmuxPlan({
      projectDir: "/tmp",
      sessionName: "omo-agents-42",
      omoArgs: ["say 'hello'"],
      viewerCommand: ["bun", "main.js"],
      insideTmux: false,
    })
    expect(plan[0]?.at(-1)).toBe(String.raw`exec 'omo' 'say '\''hello'\'''`)
    expect(plan.at(-1)).toEqual(["attach-session", "-t", "omo-agents-42"])
  })

  test("#given a tmux command runner #when executing the plan #then every pane and attach command is dispatched in order", () => {
    const plan = buildTmuxPlan({
      projectDir: "/tmp/project",
      sessionName: "omo-agents-7",
      omoArgs: [],
      viewerCommand: ["bun", "main.js"],
      insideTmux: false,
    })
    const calls: string[][] = []

    runTmuxPlan(plan, (args) => {
      calls.push([...args])
      return { status: 0 }
    })

    expect(calls).toEqual(plan)
  })
})
