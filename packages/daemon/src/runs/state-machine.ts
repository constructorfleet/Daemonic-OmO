import type { RunOutcome, RunState } from "../core/types"

/**
 * One lifecycle step of "Run lifecycle (thread model)":
 * `queued -> creating -> active -> settled -> evaluating -> {closed | kept}`, plus `end`, which closes a run
 * early with a terminal outcome (skipped, failed, cancelled, timed_out, lost).
 */
export type RunStep =
  | { readonly kind: "start" }
  | { readonly kind: "activate" }
  | { readonly kind: "settle"; readonly outcome: SettleOutcome }
  | { readonly kind: "evaluate" }
  | { readonly kind: "keep" }
  | { readonly kind: "close" }
  | { readonly kind: "end"; readonly outcome: EndOutcome }

export type SettleOutcome = Extract<RunOutcome, { readonly kind: "succeeded" }> | { readonly kind: "failed"; readonly reason: "turn_error" }

export type EndOutcome = Exclude<RunOutcome, { readonly kind: "succeeded" }>

export interface RunPosition {
  readonly state: RunState
  readonly outcome: RunOutcome | null
}

export class IllegalRunTransitionError extends Error {
  readonly name = "IllegalRunTransitionError"

  constructor(readonly from: RunState, readonly step: RunStep["kind"], readonly outcome: RunOutcome["kind"] | null) {
    super(`illegal run transition: ${from} --${step}${outcome === null ? "" : `(${outcome})`}`)
  }
}

const END_FROM: { readonly [K in EndOutcome["kind"]]: readonly RunState[] } = {
  skipped: ["queued", "creating"],
  failed: ["queued", "creating"],
  cancelled: ["queued", "creating", "active", "settled", "evaluating"],
  timed_out: ["active"],
  lost: ["creating", "active", "settled", "evaluating"],
}

/** The position after `step`, or IllegalRunTransitionError. A `close` keeps the outcome the run settled with. */
export function nextState(run: RunPosition, step: RunStep): RunPosition {
  const illegal = (): never => {
    throw new IllegalRunTransitionError(run.state, step.kind, step.kind === "end" || step.kind === "settle" ? step.outcome.kind : null)
  }
  switch (step.kind) {
    case "start":
      return run.state === "queued" ? { state: "creating", outcome: null } : illegal()
    case "activate":
      return run.state === "creating" ? { state: "active", outcome: null } : illegal()
    case "settle":
      return run.state === "active" ? { state: "settled", outcome: step.outcome } : illegal()
    case "evaluate":
      return run.state === "settled" ? { state: "evaluating", outcome: run.outcome } : illegal()
    case "keep":
      return run.state === "evaluating" ? { state: "kept", outcome: run.outcome } : illegal()
    case "close":
      return run.state === "evaluating" || run.state === "kept" ? { state: "closed", outcome: run.outcome } : illegal()
    case "end":
      return END_FROM[step.outcome.kind].includes(run.state) ? { state: "closed", outcome: step.outcome } : illegal()
    default:
      return assertNever(step)
  }
}

/** A run whose lifecycle is over: `closed`, or `kept` (an ad-hoc thread the user closes later). */
export function isFinished(state: RunState): boolean {
  return state === "closed" || state === "kept"
}

function assertNever(value: never): never {
  throw new TypeError(`unexpected run step: ${JSON.stringify(value)}`)
}
