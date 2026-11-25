import type { Ms } from "../core/types"

const DAY_MS = 86_400_000

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(tz: string): Intl.DateTimeFormat {
  const cached = formatters.get(tz)
  if (cached !== undefined) return cached
  const created = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
  formatters.set(tz, created)
  return created
}

export function assertTimeZone(tz: string): void {
  formatter(tz)
}

/**
 * The wall-clock reading of `at` in `tz`, as the epoch ms that has the same calendar fields in UTC
 * (a "floating" time). Seconds precision: slots never carry milliseconds.
 */
export function wallTime(tz: string, at: Ms): Ms {
  const fields = new Map(formatter(tz).formatToParts(at).map((part) => [part.type, Number(part.value)]))
  const field = (name: Intl.DateTimeFormatPartTypes): number => fields.get(name) ?? 0
  return Date.UTC(field("year"), field("month") - 1, field("day"), field("hour"), field("minute"), field("second"))
}

export function utcOffset(tz: string, at: Ms): Ms {
  return wallTime(tz, at) - Math.floor(at / 1000) * 1000
}

export function offsetsAround(tz: string, at: Ms): { readonly before: Ms; readonly after: Ms } {
  return { before: utcOffset(tz, at - DAY_MS), after: utcOffset(tz, at + DAY_MS) }
}

/** The first instant on or after `from` at which `tz` uses offset `target`, searched to the second up to `to`. */
export function transitionInstant(tz: string, transition: { readonly from: Ms; readonly to: Ms; readonly target: Ms }): Ms {
  let low = transition.from
  let high = transition.to
  while (high - low > 1000) {
    const mid = low + Math.floor((high - low) / 2000) * 1000
    if (utcOffset(tz, mid) === transition.target) high = mid
    else low = mid
  }
  return high
}

function formatOffset(offset: Ms): string {
  const sign = offset < 0 ? "-" : "+"
  const minutes = Math.abs(offset) / 60_000
  return `${sign}${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`
}

export function localTime(tz: string, at: Ms): { readonly local: string; readonly offset: string } {
  const wall = wallTime(tz, at)
  return { local: new Date(wall).toISOString().slice(0, 19), offset: formatOffset(utcOffset(tz, at)) }
}
