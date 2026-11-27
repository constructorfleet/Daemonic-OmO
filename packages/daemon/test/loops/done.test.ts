import { describe, expect, test } from "bun:test"

import { backoffDelay, markerResult } from "../../src/loops/done"
import { loopCheckEnvironment } from "../../src/loops/check"

const turn = (text: string) => ({
  id: "turn",
  thinking: [],
  parts: [{ kind: "text" as const, text }],
  results: [],
})

describe("loop done signals", () => {
  test("a marker from an earlier assistant turn does not finish the iteration", () => {
    expect(markerResult([turn("LOOP_DONE nonce"), turn("Still working")], "nonce")).toBe("continue")
  })

  test("a nonce mismatch does not finish the iteration", () => {
    expect(markerResult([turn("LOOP_DONE other")], "nonce")).toBe("continue")
  })

  test("only a whole final-turn marker is recognized", () => {
    expect(markerResult([turn("quoted: LOOP_DONE nonce")], "nonce")).toBe("continue")
    expect(markerResult([turn("LOOP_DONE nonce")], "nonce")).toBe("done")
  })

  test("blocked marker returns its reason only for the loop nonce", () => {
    expect(markerResult([turn("LOOP_BLOCKED nonce: missing credential")], "nonce"))
      .toEqual({ kind: "blocked", reason: "missing credential" })
  })

  test("failure backoff applies exponential cap and full jitter", () => {
    expect(backoffDelay({ initialMs: 100, factor: 2, maxMs: 250 }, 3, 0.5)).toBe(125)
    expect(backoffDelay({ initialMs: 100, factor: 2, maxMs: 250 }, 5, 0.5)).toBe(125)
  })

  test("check command environment contains only the permitted inherited values", () => {
    expect(loopCheckEnvironment({
      PATH: "/bin",
      HOME: "/home/test",
      LANG: "en_US.UTF-8",
      TMPDIR: "/tmp",
      USER: "test",
      OMO_CODING_AGENT_DIR: "/private/agent",
      BUN_INSTALL: "/private/bun",
      DAEMON_SECRET: "never-forward",
    })).toEqual({ PATH: "/bin", HOME: "/home/test", LANG: "en_US.UTF-8", TMPDIR: "/tmp" })
  })
})
