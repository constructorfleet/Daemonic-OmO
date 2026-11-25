import { Cron } from "croner"

import type { Iso, Ms, ScheduleTrigger } from "../core/types"
import { assertTimeZone, localTime, offsetsAround, transitionInstant, utcOffset, wallTime } from "./zone"

export type DstNote = "gap_shifted" | "repeat_first" | "repeat_both"

export interface Slot {
  readonly at: Ms
  readonly dstNote?: DstNote
}

export interface PreviewSlot {
  readonly at: Iso
  readonly local: string
  readonly offset: string
  readonly dstNote?: DstNote
}

/** The slots of one trigger, in time order; `next` is strictly after `after`, null when none remain. */
export interface SlotSource {
  readonly zone: string
  next(after: Ms): Slot | null
}

export type TriggerError = "invalid_expression" | "invalid_timezone"

export type CompiledTrigger =
  | { readonly kind: "ok"; readonly source: SlotSource }
  | { readonly kind: "error"; readonly reason: TriggerError; readonly detail: string }

function intervalSource(anchorAt: Ms, everyMs: Ms): SlotSource {
  return {
    zone: "UTC",
    next: (after) => ({ at: after < anchorAt ? anchorAt : anchorAt + (Math.floor((after - anchorAt) / everyMs) + 1) * everyMs }),
  }
}

function onceSource(at: Ms): SlotSource {
  return { zone: "UTC", next: (after) => (after < at ? { at } : null) }
}

/**
 * Cron slots in an IANA zone. croner matches the expression against floating wall-clock times (in UTC, where no
 * DST exists); each match is then resolved to real instants with the plan's rules, keyed on the hour field:
 * a wall time inside a spring-forward gap fires once at the gap's end only for a fixed hour, and a wall time the
 * fall-back repeats fires in its first copy for a fixed hour and in both copies for a wildcard or stepped hour.
 */
function cronSource(expr: string, tz: string, matcher: Cron): SlotSource {
  const hourField = expr.trim().split(/\s+/)[1] ?? "*"
  const hourFixed = !/[*/?]/.test(hourField)

  const resolve = (wall: Ms): readonly Slot[] => {
    const { before, after } = offsetsAround(tz, wall)
    const instants = [...new Set([wall - before, wall - after])].filter((at) => wallTime(tz, at) === wall).sort((a, b) => a - b)
    const [first, second] = instants
    if (first === undefined) {
      return hourFixed
        ? [{ at: transitionInstant(tz, { from: wall - after, to: wall - before, target: after }), dstNote: "gap_shifted" }]
        : []
    }
    if (second === undefined) return [{ at: first }]
    if (hourFixed) return [{ at: first, dstNote: "repeat_first" }]
    return [{ at: first, dstNote: "repeat_both" }, { at: second, dstNote: "repeat_both" }]
  }

  const swing = (at: Ms): { readonly min: Ms; readonly max: Ms } => {
    const offsets = [offsetsAround(tz, at).before, utcOffset(tz, at), offsetsAround(tz, at).after]
    return { min: Math.min(...offsets), max: Math.max(...offsets) }
  }

  return {
    zone: tz,
    next(after) {
      // Around a fall-back the wall clock runs backwards, so the scan starts one offset swing early and stops
      // only once no later wall time can resolve to an instant before the best slot found.
      const range = swing(after)
      let wall = matcher.nextRun(new Date(wallTime(tz, after) - (range.max - range.min)))
      let best: Slot | null = null
      let limit = Number.POSITIVE_INFINITY
      while (wall !== null && wall.getTime() <= limit) {
        for (const slot of resolve(wall.getTime())) {
          if (slot.at > after && (best === null || slot.at < best.at)) {
            best = slot
            limit = slot.at + swing(slot.at).max
          }
        }
        wall = matcher.nextRun(wall)
      }
      return best
    },
  }
}

function compileCron(expr: string, tz: string): CompiledTrigger {
  try {
    assertTimeZone(tz)
  } catch (error) {
    if (error instanceof RangeError) return { kind: "error", reason: "invalid_timezone", detail: `unknown time zone: ${tz}` }
    throw error
  }
  try {
    return { kind: "ok", source: cronSource(expr, tz, new Cron(expr, { timezone: "Etc/UTC", mode: "5-part", paused: true })) }
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) return { kind: "error", reason: "invalid_expression", detail: error.message }
    throw error
  }
}

/** Interval and once triggers were validated when the API parsed them; only a cron's zone and expression can fail. */
export function compileTrigger(trigger: ScheduleTrigger): CompiledTrigger {
  switch (trigger.kind) {
    case "cron":
      return compileCron(trigger.expr, trigger.tz)
    case "interval":
      return { kind: "ok", source: intervalSource(Date.parse(trigger.anchorAt), trigger.everyMs) }
    case "once":
      return { kind: "ok", source: onceSource(Date.parse(trigger.at)) }
    default:
      return assertNever(trigger)
  }
}

export function previewSlots(source: SlotSource, after: Ms, count: number): readonly PreviewSlot[] {
  const slots: PreviewSlot[] = []
  let slot = source.next(after)
  while (slot !== null && slots.length < count) {
    slots.push({
      at: new Date(slot.at).toISOString(),
      ...localTime(source.zone, slot.at),
      ...(slot.dstNote === undefined ? {} : { dstNote: slot.dstNote }),
    })
    slot = source.next(slot.at)
  }
  return slots
}

function assertNever(value: never): never {
  throw new TypeError(`unexpected trigger: ${JSON.stringify(value)}`)
}
