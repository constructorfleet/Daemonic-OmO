import type { Ms, Schedule } from "../core/types"
import type { SlotSource } from "./slots"

export type SkipReason = "misfire" | "paused" | "cap"

/** The payload of one `schedule.slots_skipped` event: skipped slots are never stored as run rows. */
export interface SkippedSlots {
  readonly count: number
  readonly firstSlot: Ms
  readonly lastSlot: Ms
  readonly reason: SkipReason
}

export interface DuePlan {
  readonly fire: readonly Ms[]
  readonly skipped: SkippedSlots | null
  /** The newest slot considered, fired or skipped; unchanged when no slot was due before `endAt`. */
  readonly lastSlotAt: Ms | null
  /** The first slot after `now`, or null once the trigger (or `endAt`) has no slot left. */
  readonly nextFireAt: Ms | null
}

export interface DueInput {
  readonly schedule: Pick<Schedule, "nextFireAt" | "lastSlotAt" | "misfire" | "misfireGraceMs" | "maxCatchup" | "endAt" | "maxFires" | "fireCount">
  readonly now: Ms
  readonly source: SlotSource
  /** The project is archived or its owner's kill-switch hold is set: every due slot is skipped as `paused`. */
  readonly blocked: boolean
}

interface MissedSlots {
  readonly count: number
  readonly first: Ms
  readonly newest: Ms
  readonly previous: Ms | null
  readonly oldest: readonly Ms[]
  /** The first slot past the `oldest` window. */
  readonly beyond: Ms | null
  readonly next: Ms | null
}

function collect(input: DueInput, start: Ms, keepOldest: number): MissedSlots | { readonly next: Ms | null } {
  const endAt = input.schedule.endAt === undefined ? Number.POSITIVE_INFINITY : Date.parse(input.schedule.endAt)
  const until = Math.min(input.now, endAt)
  const oldest: Ms[] = []
  let count = 0
  let first: Ms | null = null
  let previous: Ms | null = null
  let newest: Ms | null = null
  let beyond: Ms | null = null
  let slot: Ms | null = start
  while (slot !== null && slot <= until) {
    count += 1
    first ??= slot
    if (oldest.length < keepOldest) oldest.push(slot)
    else beyond ??= slot
    previous = newest
    newest = slot
    slot = input.source.next(slot)?.at ?? null
  }
  const next = slot !== null && slot <= endAt ? slot : null
  if (first === null || newest === null) return { next }
  return { count, first, newest, previous, oldest, beyond, next }
}

/**
 * Decides every slot from `nextFireAt` through `now` (design section 2, "Missed slots"): `skip` and `fire_once`
 * fire only the newest slot and only within the grace, `fire_all` fires the oldest slots up to `maxCatchup`.
 * `maxFires` bounds the fires of this pass too.
 */
export function planDue(input: DueInput, start: Ms): DuePlan {
  const { schedule, now, blocked } = input
  const remaining = schedule.maxFires === undefined ? Number.POSITIVE_INFINITY : Math.max(0, schedule.maxFires - schedule.fireCount)
  const keepOldest = schedule.misfire === "fire_all" && !blocked ? Math.min(schedule.maxCatchup, remaining) : 0
  const missed = collect(input, start, keepOldest)
  if (!("count" in missed)) return { fire: [], skipped: null, lastSlotAt: schedule.lastSlotAt, nextFireAt: missed.next }
  const base = { lastSlotAt: missed.newest, nextFireAt: missed.next }
  if (blocked) {
    return { ...base, fire: [], skipped: { count: missed.count, firstSlot: missed.first, lastSlot: missed.newest, reason: "paused" } }
  }
  switch (schedule.misfire) {
    case "fire_all": {
      const rest = missed.count - missed.oldest.length
      const skipped = rest === 0 || missed.beyond === null
        ? null
        : { count: rest, firstSlot: missed.beyond, lastSlot: missed.newest, reason: "cap" as const }
      return { ...base, fire: missed.oldest, skipped }
    }
    case "skip":
    case "fire_once": {
      const fires = remaining > 0 && now - missed.newest <= schedule.misfireGraceMs
      const lastSkipped = fires ? missed.previous : missed.newest
      const skipped = lastSkipped === null
        ? null
        : { count: missed.count - (fires ? 1 : 0), firstSlot: missed.first, lastSlot: lastSkipped, reason: "misfire" as const }
      return { ...base, fire: fires ? [missed.newest] : [], skipped }
    }
    default:
      return assertNever(schedule.misfire)
  }
}

function assertNever(value: never): never {
  throw new TypeError(`unexpected misfire policy: ${JSON.stringify(value)}`)
}
