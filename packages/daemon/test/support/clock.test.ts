import { describe, expect, test } from "bun:test"
import { FakeClock } from "./fakes"

describe("FakeClock", () => {
  test("advance(25) fires exactly the timers due at 10ms and 20ms, not the one at 30ms", () => {
    const clock = new FakeClock()
    const fired: number[] = []
    clock.setTimerIn(10, () => fired.push(10))
    clock.setTimerIn(20, () => fired.push(20))
    clock.setTimerIn(30, () => fired.push(30))

    clock.advance(25)

    console.log(`FakeClock deadlines: [10, 20, 30] ms; advance(25) fired ${fired.length}: [${fired.join(", ")}]`)
    expect(fired).toEqual([10, 20])
    expect(clock.pendingTimerCount).toBe(1)
  })

  test("advance fires every due timer in deadline order and moves both clocks", () => {
    const clock = new FakeClock({ wallMs: 1_000, monotonicMs: 50 })
    const fired: string[] = []
    clock.setTimer(1_030, () => fired.push("c"))
    clock.setTimer(1_010, () => fired.push("a"))
    clock.setTimer(1_020, () => fired.push("b"))

    clock.advance(40)

    expect(fired).toEqual(["a", "b", "c"])
    expect(clock.now()).toBe(1_040)
    expect(clock.monotonicNow()).toBe(90)
    expect(clock.pendingTimerCount).toBe(0)
  })

  test("jumpWall moves only the wall clock and leaves due timers pending until the next advance", () => {
    const clock = new FakeClock({ wallMs: 1_000, monotonicMs: 0 })
    const fired: number[] = []
    clock.setTimer(1_010, () => fired.push(clock.now()))

    clock.jumpWall(3_600_000)

    expect(clock.now()).toBe(3_601_000)
    expect(clock.monotonicNow()).toBe(0)
    expect(fired).toEqual([])

    clock.advance(0)

    expect(fired).toEqual([3_601_000])
  })

  test("a timer scheduled by a firing callback runs in the same advance when already due", () => {
    const clock = new FakeClock({ wallMs: 0 })
    const fired: string[] = []
    clock.setTimer(10, () => {
      fired.push("outer")
      clock.setTimer(10, () => fired.push("inner"))
    })

    clock.advance(10)

    expect(fired).toEqual(["outer", "inner"])
  })

  test("clearTimer prevents a pending timer from firing", () => {
    const clock = new FakeClock({ wallMs: 0 })
    let fired = false
    const handle = clock.setTimer(10, () => {
      fired = true
    })

    clock.clearTimer(handle)
    clock.advance(20)

    expect(fired).toBe(false)
    expect(clock.pendingTimerCount).toBe(0)
  })
})
