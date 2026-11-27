import type { LoopState } from "../core/types"

export type LoopStep =
  | { readonly kind: "start" }
  | { readonly kind: "continue" }
  | { readonly kind: "iteration_due" }
  | { readonly kind: "cancel" }
  | { readonly kind: "succeed" }
  | { readonly kind: "block" }
  | { readonly kind: "exhaust" }
  | { readonly kind: "fail" }
  | { readonly kind: "cancelled" }

export class IllegalLoopTransitionError extends Error {
  readonly name = "IllegalLoopTransitionError"

  constructor(readonly from: LoopState, readonly step: LoopStep["kind"]) {
    super(`illegal loop transition: ${from} --${step}`)
  }
}

const TERMINAL_STATES: readonly LoopState[] = ["succeeded", "blocked", "exhausted", "failed", "cancelled"]
const LIVE_STATES: readonly LoopState[] = ["pending", "running", "waiting", "cancelling"]

export function nextLoopState(state: LoopState, step: LoopStep): LoopState {
  const illegal = (): never => {
    throw new IllegalLoopTransitionError(state, step.kind)
  }
  switch (step.kind) {
    case "start":
      return state === "pending" ? "running" : illegal()
    case "continue":
      return state === "running" ? "waiting" : illegal()
    case "iteration_due":
      return state === "waiting" ? "running" : illegal()
    case "cancel":
      return state === "pending" || state === "running" || state === "waiting" ? "cancelling" : illegal()
    case "succeed":
      return LIVE_STATES.includes(state) && state !== "cancelling" ? "succeeded" : illegal()
    case "block":
      return LIVE_STATES.includes(state) && state !== "cancelling" ? "blocked" : illegal()
    case "exhaust":
      return LIVE_STATES.includes(state) && state !== "cancelling" ? "exhausted" : illegal()
    case "fail":
      return LIVE_STATES.includes(state) && state !== "cancelling" ? "failed" : illegal()
    case "cancelled":
      return state === "cancelling" ? "cancelled" : illegal()
    default:
      return assertNever(step)
  }
}

export function isTerminalLoop(state: LoopState): boolean {
  return TERMINAL_STATES.includes(state)
}

function assertNever(value: never): never {
  throw new TypeError(`unexpected loop step: ${JSON.stringify(value)}`)
}
