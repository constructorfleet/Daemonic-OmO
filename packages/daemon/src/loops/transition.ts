import type { Loop, Ms } from "../core/types"
import type { LoopDecision } from "./done"
import { nextLoopState } from "./state-machine"

export function stateForDecision(loop: Loop, decision: LoopDecision, now: Ms): Loop {
  const at = new Date(now).toISOString()
  const { activeRunId: _active, ...rest } = loop
  const common = { ...rest, evaluatedRunId: loop.activeRunId, revision: loop.revision + 1 }
  switch (decision.kind) {
    case "cancelled":
      return { ...common, state: nextLoopState(loop.state, { kind: "cancelled" }), stopReason: decision.stopReason, nextIterationAt: null, endedAt: at }
    case "exhausted":
      return { ...common, state: nextLoopState(loop.state, { kind: "exhaust" }), stopReason: decision.stopReason, nextIterationAt: null, endedAt: at }
    case "succeeded":
      return { ...common, state: nextLoopState(loop.state, { kind: "succeed" }), nextIterationAt: null, endedAt: at }
    case "blocked":
      return { ...common, state: nextLoopState(loop.state, { kind: "block" }), stopReason: decision.stopReason, nextIterationAt: null, endedAt: at }
    case "failed":
      return {
        ...common,
        state: nextLoopState(loop.state, { kind: "fail" }),
        stopReason: decision.stopReason,
        consecutiveFailures: decision.consecutiveFailures,
        ...(decision.errorDetail === undefined ? {} : { errorDetail: decision.errorDetail }),
        nextIterationAt: null,
        endedAt: at,
      }
    case "continue":
      return {
        ...common,
        state: loop.state === "running" ? nextLoopState(loop.state, { kind: "continue" }) : loop.state,
        consecutiveFailures: decision.consecutiveFailures,
        ...(decision.errorDetail === undefined ? {} : { errorDetail: decision.errorDetail }),
        nextIterationAt: now + decision.delayMs,
      }
    default:
      return assertNever(decision)
  }
}

function assertNever(value: never): never {
  throw new TypeError(`unexpected loop decision: ${JSON.stringify(value)}`)
}
