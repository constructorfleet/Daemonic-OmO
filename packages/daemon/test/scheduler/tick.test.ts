import { afterEach, describe, expect, test } from "bun:test"

import type { Schedule } from "../../src/core/types"
import { closeSchedulerRigs, HOUR, schedulerRig, type SchedulerRig } from "./harness"

afterEach(closeSchedulerRigs)

const T0 = Date.parse("2027-01-10T00:00:00Z")
const FIRST_SLOT = T0 + HOUR / 2

function skippedData(rig: SchedulerRig): readonly unknown[] {
  return rig.events("schedule.slots_skipped").map((event) => event.data)
}

function slotsOf(rig: SchedulerRig, schedule: Schedule): readonly (number | undefined)[] {
  return rig.runsOf(schedule).map((run) => run.slotAt)
}

describe("missed slots after an 8 h jump", () => {
  test("fire_once: a sleep jump logs daemon.clock_jump and makes exactly one run keyed to the newest slot", async () => {
    const rig = await schedulerRig({ wallMs: T0 })
    const schedule = rig.create({ misfire: "fire_once" })
    rig.scheduler.start()
    await rig.settle()
    rig.clock.jumpWall(8 * HOUR)
    rig.clock.advance(0)
    await rig.settle()

    const newest = FIRST_SLOT + 7 * HOUR
    expect(rig.runsOf(schedule).map((run) => run.fireKey)).toEqual([`sched:${schedule.id}:${newest}`])
    expect(skippedData(rig)).toEqual([{ count: 7, firstSlot: FIRST_SLOT, lastSlot: newest - HOUR, reason: "misfire" }])
    expect(rig.schedule(schedule.id)).toMatchObject({ lastSlotAt: newest, nextFireAt: newest + HOUR, fireCount: 1 })
    expect(rig.logs.map((line) => line.event)).toEqual(["daemon.clock_jump"])
    expect(rig.logs[0]?.fields).toMatchObject({ wallDeltaMs: 8 * HOUR, monotonicDeltaMs: 0 })
  })

  test("skip: the newest slot is past its grace, so zero runs and one slots_skipped event counting every slot", async () => {
    const rig = await schedulerRig({ wallMs: T0 })
    const schedule = rig.create({ misfire: "skip", misfireGraceMs: 60_000 })
    rig.scheduler.start()
    await rig.settle()
    rig.clock.advance(8 * HOUR)
    await rig.settle()

    expect(rig.runsOf(schedule)).toEqual([])
    expect(skippedData(rig)).toEqual([{ count: 8, firstSlot: FIRST_SLOT, lastSlot: FIRST_SLOT + 7 * HOUR, reason: "misfire" }])
    expect(rig.logs).toEqual([])
  })

  test("fire_all: the oldest maxCatchup slots fire and the rest are skipped as cap", async () => {
    const rig = await schedulerRig({ wallMs: T0, project: { maxRunning: 5 } })
    const schedule = rig.create({ misfire: "fire_all", maxCatchup: 3, overlap: "parallel" })
    rig.scheduler.start()
    await rig.settle()
    rig.clock.advance(8 * HOUR)
    await rig.settle()

    expect(slotsOf(rig, schedule)).toEqual([FIRST_SLOT, FIRST_SLOT + HOUR, FIRST_SLOT + 2 * HOUR])
    expect(skippedData(rig)).toEqual([{ count: 5, firstSlot: FIRST_SLOT + 3 * HOUR, lastSlot: FIRST_SLOT + 7 * HOUR, reason: "cap" }])
  })

  test("fire_all defaults maxCatchup from config.defaults.maxCatchup", async () => {
    const rig = await schedulerRig({ wallMs: T0 })
    expect(rig.create({ misfire: "fire_all" }).maxCatchup).toBe(50)
  })

  test("skip grace, queue size, and once grace defaults can be configured", async () => {
    const rig = await schedulerRig({
      wallMs: T0,
      defaults: { skipMisfireGraceMs: 25_000, queueMax: 4, onceMisfireGraceMs: 72 * HOUR },
    })
    expect(rig.create({ misfire: "skip" })).toMatchObject({ misfireGraceMs: 25_000 })
    expect(rig.create({ overlap: "queue" }).queueMax).toBe(4)
    expect(rig.create({
      trigger: { kind: "once", at: new Date(T0 + HOUR).toISOString() },
      misfire: "skip",
    }).misfireGraceMs).toBe(25_000)
    expect(rig.create({ trigger: { kind: "once", at: new Date(T0 + HOUR).toISOString() } }).misfireGraceMs).toBe(72 * HOUR)
  })
})

describe("grace boundary", () => {
  test("lateness == grace fires; grace + 1 skips", async () => {
    const onTime = await schedulerRig({ wallMs: T0 })
    const fired = onTime.create({ misfireGraceMs: 600_000 })
    await onTime.scheduler.tick(FIRST_SLOT + 600_000)
    await onTime.settle()
    expect(slotsOf(onTime, fired)).toEqual([FIRST_SLOT])

    const late = await schedulerRig({ wallMs: T0 })
    const skipped = late.create({ misfireGraceMs: 600_000 })
    await late.scheduler.tick(FIRST_SLOT + 600_001)
    await late.settle()
    expect(late.runsOf(skipped)).toEqual([])
    expect(skippedData(late)).toEqual([{ count: 1, firstSlot: FIRST_SLOT, lastSlot: FIRST_SLOT, reason: "misfire" }])
  })
})

describe("once", () => {
  test("a once schedule already in the past at creation fires within its 24 h default grace, then completes", async () => {
    const rig = await schedulerRig({ wallMs: T0 })
    const schedule = rig.create({ trigger: { kind: "once", at: new Date(T0 - HOUR).toISOString() } })
    expect(schedule).toMatchObject({ misfireGraceMs: 86_400_000, nextFireAt: T0 - HOUR, state: "active" })
    await rig.scheduler.tick(T0)
    await rig.settle()
    expect(slotsOf(rig, schedule)).toEqual([T0 - HOUR])
    expect(rig.schedule(schedule.id)).toMatchObject({ state: "completed", nextFireAt: null, fireCount: 1 })
  })

  test("a once slot missed asleep beyond 24 h is skipped and the schedule completes", async () => {
    const rig = await schedulerRig({ wallMs: T0 })
    const schedule = rig.create({ trigger: { kind: "once", at: new Date(T0 + HOUR).toISOString() } })
    await rig.scheduler.tick(T0 + HOUR + 86_400_001)
    await rig.settle()
    expect(rig.runsOf(schedule)).toEqual([])
    expect(skippedData(rig)).toEqual([{ count: 1, firstSlot: T0 + HOUR, lastSlot: T0 + HOUR, reason: "misfire" }])
    expect(rig.schedule(schedule.id)).toMatchObject({ state: "completed", nextFireAt: null, fireCount: 0 })
  })
})

describe("pause, patch and repeated ticks", () => {
  test("pause and resume do not backfill: the paused slots are reported once and the next slot fires on time", async () => {
    const rig = await schedulerRig({ wallMs: T0 })
    const schedule = rig.create({})
    const paused = rig.service.pause(schedule)
    expect(paused.state).toBe("paused")
    rig.clock.advance(5 * HOUR)
    await rig.scheduler.tick(rig.clock.now())

    const resumed = rig.service.resume(rig.schedule(schedule.id))
    expect(resumed).toMatchObject({ state: "active", nextFireAt: FIRST_SLOT + 5 * HOUR })
    expect(skippedData(rig)).toEqual([{ count: 5, firstSlot: FIRST_SLOT, lastSlot: FIRST_SLOT + 4 * HOUR, reason: "paused" }])
    await rig.scheduler.tick(rig.clock.now())
    expect(rig.runsOf(schedule)).toEqual([])
    await rig.scheduler.tick(FIRST_SLOT + 5 * HOUR)
    await rig.settle()
    expect(slotsOf(rig, schedule)).toEqual([FIRST_SLOT + 5 * HOUR])
  })

  test("a PATCH right after a slot fired recomputes from max(now, lastSlotAt) and never fires that slot again", async () => {
    const rig = await schedulerRig({ wallMs: T0 })
    const schedule = rig.create({})
    await rig.scheduler.tick(FIRST_SLOT)
    await rig.settle()
    const fired = rig.schedule(schedule.id)
    expect(fired.lastSlotAt).toBe(FIRST_SLOT)

    const patched = rig.service.patch(fired, {
      revision: fired.revision,
      trigger: { kind: "interval", everyMs: 2 * HOUR, anchorAt: new Date(FIRST_SLOT).toISOString() },
    })
    expect(patched.nextFireAt).toBe(FIRST_SLOT + 2 * HOUR)
    await rig.scheduler.tick(FIRST_SLOT)
    await rig.scheduler.tick(FIRST_SLOT + HOUR)
    await rig.settle()
    expect(slotsOf(rig, schedule)).toEqual([FIRST_SLOT])
  })

  test("two ticks at the same instant, concurrent or sequential, make one run", async () => {
    const rig = await schedulerRig({ wallMs: T0 })
    const schedule = rig.create({})
    await Promise.all([rig.scheduler.tick(FIRST_SLOT), rig.scheduler.tick(FIRST_SLOT)])
    await rig.scheduler.tick(FIRST_SLOT)
    await rig.settle()
    expect(rig.runsOf(schedule).map((run) => run.fireKey)).toEqual([`sched:${schedule.id}:${FIRST_SLOT}`])
  })
})

describe("errored and completed schedules", () => {
  test("an invalid time zone is errored at creation and a PATCH that fixes it makes the schedule active", async () => {
    const rig = await schedulerRig({ wallMs: T0 })
    const schedule = rig.create({ trigger: { kind: "cron", expr: "30 2 * * *", tz: "Mars/Base" } })
    expect(schedule).toMatchObject({ state: "errored", nextFireAt: null })
    expect(schedule.errorReason).toStartWith("invalid_timezone")

    const fixed = rig.service.patch(schedule, { revision: schedule.revision, trigger: { kind: "cron", expr: "30 2 * * *", tz: "UTC" } })
    expect(fixed).toMatchObject({ state: "active", nextFireAt: Date.parse("2027-01-10T02:30:00Z") })
    expect(fixed.errorReason).toBeUndefined()
  })

  test("a cron with no real date is errored with no_next_slot", async () => {
    const rig = await schedulerRig({ wallMs: T0 })
    expect(rig.create({ trigger: { kind: "cron", expr: "0 0 30 2 *", tz: "UTC" } })).toMatchObject({ state: "errored", errorReason: "no_next_slot" })
  })

  test("a valid cron whose next slot exceeds the configured horizon is errored", async () => {
    const rig = await schedulerRig({ wallMs: T0, limits: { scheduleHorizonMs: HOUR } })
    expect(rig.create({ trigger: { kind: "cron", expr: "0 0 1 1 *", tz: "UTC" } })).toMatchObject({
      state: "errored",
      errorReason: "no_next_slot",
      nextFireAt: null,
    })
  })

  test("maxFires and endAt complete the schedule", async () => {
    const rig = await schedulerRig({ wallMs: T0 })
    const capped = rig.create({ maxFires: 1 })
    await rig.scheduler.tick(FIRST_SLOT)
    await rig.settle()
    expect(rig.schedule(capped.id)).toMatchObject({ state: "completed", nextFireAt: null, fireCount: 1 })

    const ending = rig.create({ endAt: new Date(FIRST_SLOT + HOUR + 1).toISOString() }, await rig.addProject())
    await rig.scheduler.tick(FIRST_SLOT + HOUR)
    await rig.settle()
    expect(rig.schedule(ending.id)).toMatchObject({ state: "completed", nextFireAt: null, lastSlotAt: FIRST_SLOT + HOUR })
  })
})
