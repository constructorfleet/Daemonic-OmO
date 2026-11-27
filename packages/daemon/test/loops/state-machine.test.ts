import { describe, expect, test } from "bun:test"

import { nextLoopState } from "../../src/loops/state-machine"

describe("loop state transitions", () => {
  test("a due waiting loop starts its next iteration", () => {
    expect(nextLoopState("waiting", { kind: "iteration_due" })).toBe("running")
  })

  test("a running loop waits between iterations", () => {
    expect(nextLoopState("running", { kind: "continue" })).toBe("waiting")
  })

  test("cancellation is accepted only from a live loop state", () => {
    expect(nextLoopState("running", { kind: "cancel" })).toBe("cancelling")
    expect(() => nextLoopState("succeeded", { kind: "cancel" })).toThrow()
  })

  test("a cancelling loop records cancellation after its run settles", () => {
    expect(nextLoopState("cancelling", { kind: "cancelled" })).toBe("cancelled")
  })

  test("a terminal loop cannot start another iteration", () => {
    expect(() => nextLoopState("failed", { kind: "iteration_due" })).toThrow()
  })
})
