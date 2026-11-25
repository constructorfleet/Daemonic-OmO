import { describe, expect, test } from "bun:test"

import { RUN_FAILURE_REASONS, type RunOutcome, type RunState } from "../../src/core/types"
import { IllegalRunTransitionError, nextState, type RunStep, type SettleOutcome } from "../../src/runs/state-machine"

const succeeded: RunOutcome = { kind: "succeeded" }
const cancelled: RunStep = { kind: "end", outcome: { kind: "cancelled" } }
const timedOut: RunStep = { kind: "end", outcome: { kind: "timed_out" } }
const lost: RunStep = { kind: "end", outcome: { kind: "lost", reason: "thread_missing" } }
const worktreeCap: RunStep = { kind: "end", outcome: { kind: "skipped", reason: "worktree_cap" } }
const refused: RunStep = { kind: "end", outcome: { kind: "failed", reason: "create_refused" } }
const settle: RunStep = { kind: "settle", outcome: succeeded }

type Row = readonly [from: RunState, step: RunStep, to: RunState | "illegal"]

const ROWS: readonly Row[] = [
  ["queued", { kind: "start" }, "creating"],
  ["queued", cancelled, "closed"],
  ["queued", { kind: "end", outcome: { kind: "skipped", reason: "overlap" } }, "closed"],
  ["queued", { kind: "activate" }, "illegal"],
  ["queued", settle, "illegal"],
  ["queued", timedOut, "illegal"],
  ["creating", { kind: "activate" }, "active"],
  ["creating", cancelled, "closed"],
  ["creating", worktreeCap, "closed"],
  ["creating", refused, "closed"],
  ["creating", { kind: "start" }, "illegal"],
  ["creating", settle, "illegal"],
  ["active", settle, "settled"],
  ["active", timedOut, "closed"],
  ["active", cancelled, "closed"],
  ["active", lost, "closed"],
  ["active", refused, "illegal"],
  ["active", worktreeCap, "illegal"],
  ["active", { kind: "keep" }, "illegal"],
  ["settled", { kind: "evaluate" }, "evaluating"],
  ["settled", { kind: "close" }, "illegal"],
  ["evaluating", { kind: "close" }, "closed"],
  ["evaluating", { kind: "keep" }, "kept"],
  ["evaluating", settle, "illegal"],
  ["kept", { kind: "close" }, "closed"],
  ["kept", { kind: "start" }, "illegal"],
  ["closed", { kind: "start" }, "illegal"],
  ["closed", cancelled, "illegal"],
  ["closed", { kind: "close" }, "illegal"],
]

function outcomeBefore(from: RunState): RunOutcome | null {
  return from === "queued" || from === "creating" || from === "active" ? null : succeeded
}

describe("run state machine", () => {
  for (const [from, step, to] of ROWS) {
    test(`${from} --${step.kind}${step.kind === "end" ? `(${step.outcome.kind})` : ""}--> ${to}`, () => {
      const run = { state: from, outcome: outcomeBefore(from) }
      if (to === "illegal") {
        expect(() => nextState(run, step)).toThrow(IllegalRunTransitionError)
      } else {
        expect(nextState(run, step).state).toBe(to)
      }
    })
  }

  test("an end step records its terminal outcome and a close keeps the settled one", () => {
    expect(nextState({ state: "active", outcome: null }, timedOut).outcome).toEqual({ kind: "timed_out" })
    const failedTurn: SettleOutcome = { kind: "failed", reason: "turn_error" }
    const settled = nextState({ state: "active", outcome: null }, { kind: "settle", outcome: failedTurn })
    const evaluating = nextState(settled, { kind: "evaluate" })
    expect(nextState(evaluating, { kind: "close" }).outcome).toEqual(failedTurn)
  })

  test("preset_unconfirmed is no longer a failure reason: runs use the agent-dir default permission mode", () => {
    expect(RUN_FAILURE_REASONS).not.toContain("preset_unconfirmed")
  })
})
