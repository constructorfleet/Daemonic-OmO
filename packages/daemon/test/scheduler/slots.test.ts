import { describe, expect, test } from "bun:test"

import type { ScheduleTrigger } from "../../src/core/types"
import { compileTrigger, previewSlots, type PreviewSlot } from "../../src/scheduler/slots"

function preview(trigger: ScheduleTrigger, from: string, count: number): readonly PreviewSlot[] {
  const compiled = compileTrigger(trigger)
  if (compiled.kind !== "ok") throw new Error(`trigger did not compile: ${compiled.detail}`)
  return previewSlots(compiled.source, Date.parse(from), count)
}

const cron = (expr: string, tz: string): ScheduleTrigger => ({ kind: "cron", expr, tz })
const instants = (slots: readonly PreviewSlot[]): readonly string[] => slots.map((slot) => slot.at)

describe("spring-forward gap", () => {
  test("America/Los_Angeles 02:30 fires once at 03:00 on 2027-03-14 and never skips the day", () => {
    expect(preview(cron("30 2 * * *", "America/Los_Angeles"), "2027-03-13T00:00:00Z", 3)).toEqual([
      { at: "2027-03-13T10:30:00.000Z", local: "2027-03-13T02:30:00", offset: "-08:00" },
      { at: "2027-03-14T10:00:00.000Z", local: "2027-03-14T03:00:00", offset: "-07:00", dstNote: "gap_shifted" },
      { at: "2027-03-15T09:30:00.000Z", local: "2027-03-15T02:30:00", offset: "-07:00" },
    ])
  })

  test("Europe/London 01:30 fires once at 02:00 BST on 2027-03-28", () => {
    expect(preview(cron("30 1 * * *", "Europe/London"), "2027-03-27T00:00:00Z", 3)).toEqual([
      { at: "2027-03-27T01:30:00.000Z", local: "2027-03-27T01:30:00", offset: "+00:00" },
      { at: "2027-03-28T01:00:00.000Z", local: "2027-03-28T02:00:00", offset: "+01:00", dstNote: "gap_shifted" },
      { at: "2027-03-29T00:30:00.000Z", local: "2027-03-29T01:30:00", offset: "+01:00" },
    ])
  })

  test("a fixed hour with stepped minutes inside the gap still fires exactly once at the first valid instant", () => {
    const slots = preview(cron("*/15 2 * * *", "America/Los_Angeles"), "2027-03-13T11:00:00Z", 2)
    expect(slots.map(({ at, dstNote }) => ({ at, dstNote }))).toEqual([
      { at: "2027-03-14T10:00:00.000Z", dstNote: "gap_shifted" },
      { at: "2027-03-15T09:00:00.000Z", dstNote: undefined },
    ])
  })

  test("a wildcard hour fires only on real instants: the missing 02:00 hour has no slot", () => {
    expect(instants(preview(cron("0 * * * *", "America/Los_Angeles"), "2027-03-14T08:30:00Z", 3))).toEqual([
      "2027-03-14T09:00:00.000Z",
      "2027-03-14T10:00:00.000Z",
      "2027-03-14T11:00:00.000Z",
    ])
  })
})

describe("fall-back repeat", () => {
  test("a fixed hour fires once, on the first occurrence (America/Los_Angeles and Europe/London)", () => {
    expect(preview(cron("30 1 * * *", "America/Los_Angeles"), "2027-11-06T12:00:00Z", 2)).toEqual([
      { at: "2027-11-07T08:30:00.000Z", local: "2027-11-07T01:30:00", offset: "-07:00", dstNote: "repeat_first" },
      { at: "2027-11-08T09:30:00.000Z", local: "2027-11-08T01:30:00", offset: "-08:00" },
    ])
    expect(preview(cron("30 1 * * *", "Europe/London"), "2027-10-30T12:00:00Z", 2)).toEqual([
      { at: "2027-10-31T00:30:00.000Z", local: "2027-10-31T01:30:00", offset: "+01:00", dstNote: "repeat_first" },
      { at: "2027-11-01T01:30:00.000Z", local: "2027-11-01T01:30:00", offset: "+00:00" },
    ])
  })

  test("a fixed hour with stepped minutes fires only in the first copy of the repeated hour", () => {
    expect(instants(preview(cron("*/15 1 * * *", "America/Los_Angeles"), "2027-11-07T07:59:00Z", 5))).toEqual([
      "2027-11-07T08:00:00.000Z",
      "2027-11-07T08:15:00.000Z",
      "2027-11-07T08:30:00.000Z",
      "2027-11-07T08:45:00.000Z",
      "2027-11-08T09:00:00.000Z",
    ])
  })

  test("*/15 * * * * fires in both copies of the repeated hour, in time order", () => {
    const slots = preview(cron("*/15 * * * *", "America/Los_Angeles"), "2027-11-07T07:50:00Z", 9)
    expect(slots.map(({ at, local, dstNote }) => [at.slice(11, 16), local.slice(11, 16), dstNote ?? null])).toEqual([
      ["08:00", "01:00", "repeat_both"],
      ["08:15", "01:15", "repeat_both"],
      ["08:30", "01:30", "repeat_both"],
      ["08:45", "01:45", "repeat_both"],
      ["09:00", "01:00", "repeat_both"],
      ["09:15", "01:15", "repeat_both"],
      ["09:30", "01:30", "repeat_both"],
      ["09:45", "01:45", "repeat_both"],
      ["10:00", "02:00", null],
    ])
  })

  test("the next slot after an instant inside the second copy stays in that copy", () => {
    expect(instants(preview(cron("*/15 * * * *", "America/Los_Angeles"), "2027-11-07T09:10:00Z", 2))).toEqual([
      "2027-11-07T09:15:00.000Z",
      "2027-11-07T09:30:00.000Z",
    ])
  })
})

describe("interval and once", () => {
  test("an interval is anchorAt + k * everyMs in UTC and ignores DST", () => {
    const trigger: ScheduleTrigger = { kind: "interval", everyMs: 3_600_000, anchorAt: "2027-03-14T08:00:00Z" }
    expect(preview(trigger, "2027-03-14T08:00:00Z", 3)).toEqual([
      { at: "2027-03-14T09:00:00.000Z", local: "2027-03-14T09:00:00", offset: "+00:00" },
      { at: "2027-03-14T10:00:00.000Z", local: "2027-03-14T10:00:00", offset: "+00:00" },
      { at: "2027-03-14T11:00:00.000Z", local: "2027-03-14T11:00:00", offset: "+00:00" },
    ])
    expect(instants(preview(trigger, "2027-03-14T07:00:00Z", 1))).toEqual(["2027-03-14T08:00:00.000Z"])
  })

  test("once has exactly one slot", () => {
    const trigger: ScheduleTrigger = { kind: "once", at: "2027-01-01T00:00:00Z" }
    expect(instants(preview(trigger, "2026-12-31T00:00:00Z", 3))).toEqual(["2027-01-01T00:00:00.000Z"])
    expect(preview(trigger, "2027-01-01T00:00:00Z", 3)).toEqual([])
  })
})

describe("invalid triggers", () => {
  test("an unknown time zone, a malformed expression and a six-field expression do not compile", () => {
    expect(compileTrigger(cron("30 2 * * *", "Mars/Base"))).toMatchObject({ kind: "error", reason: "invalid_timezone" })
    expect(compileTrigger(cron("61 2 * * *", "UTC"))).toMatchObject({ kind: "error", reason: "invalid_expression" })
    expect(compileTrigger(cron("0 30 2 * * *", "UTC"))).toMatchObject({ kind: "error", reason: "invalid_expression" })
  })

  test("an expression with no real date compiles but has no next slot", () => {
    expect(preview(cron("0 0 30 2 *", "UTC"), "2027-01-01T00:00:00Z", 1)).toEqual([])
  })
})
