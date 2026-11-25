import type { Iso, Ms, Schedule, ScheduleTrigger } from "../core/types"
import { compileTrigger } from "./slots"

export type SchedulePlacement = Pick<Schedule, "state" | "nextFireAt" | "errorReason">

export interface PlacementInput {
  readonly trigger: ScheduleTrigger
  readonly after: Ms
  readonly now: Ms
  readonly endAt: Iso | undefined
  readonly horizonMs: Ms
}

export function placeSchedule({
  trigger,
  after,
  now,
  endAt,
  horizonMs,
}: PlacementInput): SchedulePlacement {
  const compiled = compileTrigger(trigger)
  if (compiled.kind === "error") return { state: "errored", nextFireAt: null, errorReason: `${compiled.reason}: ${compiled.detail}` }
  const next = compiled.source.next(after)
  if (next === null) return trigger.kind === "once" ? { state: "completed", nextFireAt: null } : { state: "errored", nextFireAt: null, errorReason: "no_next_slot" }
  if (endAt !== undefined && next.at > Date.parse(endAt)) return { state: "completed", nextFireAt: null }
  if (next.at > now && next.at - now > horizonMs) return { state: "errored", nextFireAt: null, errorReason: "no_next_slot" }
  return { state: "active", nextFireAt: next.at }
}

export function placementAfter(trigger: ScheduleTrigger, now: Ms, lastSlotAt: Ms | null): Ms {
  const decided = lastSlotAt ?? Number.NEGATIVE_INFINITY
  return trigger.kind === "once" ? decided : Math.max(now, decided)
}
