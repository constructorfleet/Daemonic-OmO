import type { Clock, TimerHandle } from "../../../src/core/ports"
import type { Ms } from "../../../src/core/types"

interface ScheduledTimer {
  readonly at: Ms
  readonly fn: () => void
}

export interface FakeClockOptions {
  readonly wallMs?: Ms
  readonly monotonicMs?: Ms
}

export class FakeClock implements Clock {
  private wall: Ms
  private monotonic: Ms
  private readonly timers = new Map<number, ScheduledTimer>()
  private nextId = 1

  constructor(options: FakeClockOptions = {}) {
    this.wall = options.wallMs ?? 1_700_000_000_000
    this.monotonic = options.monotonicMs ?? 0
  }

  now(): Ms {
    return this.wall
  }

  monotonicNow(): Ms {
    return this.monotonic
  }

  setTimer(at: Ms, fn: () => void): TimerHandle {
    const id = this.nextId
    this.nextId += 1
    this.timers.set(id, { at, fn })
    return { id }
  }

  setTimerIn(delayMs: Ms, fn: () => void): TimerHandle {
    return this.setTimer(this.wall + delayMs, fn)
  }

  clearTimer(handle: TimerHandle): void {
    this.timers.delete(handle.id)
  }

  get pendingTimerCount(): number {
    return this.timers.size
  }

  advance(ms: Ms): void {
    assertNonNegative(ms, "advance")
    this.wall += ms
    this.monotonic += ms
    this.fireDue()
  }

  /**
   * Moves only the wall clock, modelling a system-sleep jump: due timers stay
   * pending until the next `advance`, so scheduler misfire handling is testable.
   */
  jumpWall(ms: Ms): void {
    assertNonNegative(ms, "jumpWall")
    this.wall += ms
  }

  private fireDue(): void {
    let iterations = 0
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= this.wall)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])
      if (due.length === 0) return
      iterations += 1
      if (iterations > 10_000) {
        throw new Error("FakeClock: timer storm; a timer keeps rescheduling at the current time")
      }
      for (const [id, timer] of due) {
        if (this.timers.delete(id)) timer.fn()
      }
    }
  }
}

function assertNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`FakeClock.${label}: expected a non-negative finite number, got ${value}`)
  }
}
