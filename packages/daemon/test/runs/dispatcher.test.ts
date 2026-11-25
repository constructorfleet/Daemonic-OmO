import { describe, expect, test } from "bun:test"

import { threadId, ulid } from "../../src/core/ids"
import type { ThreadState } from "../../src/core/ports"
import type { RunState, ThreadId, Ulid } from "../../src/core/types"
import { planDispatch, slotHolders, type DispatchCaps, type QueuedRun } from "../../src/runs/dispatcher"
import { SeededRng } from "../support/fakes"

const rng = new SeededRng(11)
const named = new Map<string, Ulid>()
function idOf(name: string): Ulid {
  const existing = named.get(name)
  if (existing !== undefined) return existing
  const created = ulid(rng, 1_700_000_000_000)
  named.set(name, created)
  return created
}
const u = idOf
const p = idOf
const t = threadId

let seq = 0
function queued(user: string, project: string): QueuedRun {
  seq += 1
  return { id: idOf(`run-${seq}`), userId: u(user), projectId: p(project), createdAt: new Date(1_700_000_000_000 + seq * 1000).toISOString() }
}

function caps(overrides: Partial<{ machine: number; user: number; project: number }> = {}): DispatchCaps {
  return {
    machine: overrides.machine ?? 100,
    perUser: () => overrides.user ?? 100,
    perProject: () => overrides.project ?? 100,
  }
}

describe("dispatcher caps", () => {
  test("the machine cap bounds starts across users", () => {
    const runs = [queued("a", "pa"), queued("b", "pb"), queued("c", "pc")]
    expect(planDispatch({ queued: runs, holders: [], caps: caps({ machine: 2 }), cursor: null }).start).toHaveLength(2)
  })

  test("the machine cap counts runs already holding a slot", () => {
    const first = queued("a", "pa")
    const plan = planDispatch({ queued: [first, queued("b", "pb")], holders: [{ userId: u("z"), projectId: p("pz") }], caps: caps({ machine: 2 }), cursor: null })
    expect(plan.start).toEqual([first.id])
  })

  test("the per-user cap bounds one user's starts across their projects", () => {
    const other = queued("b", "p4")
    const runs = [queued("a", "p1"), queued("a", "p2"), queued("a", "p3"), other]
    const plan = planDispatch({ queued: runs, holders: [], caps: caps({ user: 2 }), cursor: null })
    expect(plan.start.filter((id) => id !== other.id)).toHaveLength(2)
    expect(plan.start).toContain(other.id)
  })

  test("the per-project cap counts holders of that project", () => {
    const free = queued("a", "p2")
    const runs = [queued("a", "p1"), queued("a", "p1"), free]
    const plan = planDispatch({ queued: runs, holders: [{ userId: u("a"), projectId: p("p1") }], caps: caps({ project: 1 }), cursor: null })
    expect(plan.start).toEqual([free.id])
  })
})

describe("dispatcher order", () => {
  test("round-robins projects, oldest run first inside each project", () => {
    const a1 = queued("a", "pa")
    const a2 = queued("a", "pa")
    const b1 = queued("b", "pb")
    const plan = planDispatch({ queued: [b1, a2, a1], holders: [], caps: caps({ machine: 2 }), cursor: null })
    expect(plan.start).toEqual([a1.id, b1.id])
    expect(plan.cursor).toBe(p("pb"))
  })

  test("starts after the project served last", () => {
    const a1 = queued("a", "pa")
    const b1 = queued("b", "pb")
    expect(planDispatch({ queued: [a1, b1], holders: [], caps: caps({ machine: 1 }), cursor: p("pa") }).start).toEqual([b1.id])
    expect(planDispatch({ queued: [a1, b1], holders: [], caps: caps({ machine: 1 }), cursor: p("pb") }).start).toEqual([a1.id])
  })
})

describe("slot holders", () => {
  const row = (state: RunState, thread: string | undefined) => ({
    userId: u("a"),
    projectId: p("pa"),
    state,
    ...(thread === undefined ? {} : { threadId: t(thread) }),
  })
  const states = new Map<ThreadId, ThreadState>([[t("busy"), "running"], [t("quiet"), "idle"]])

  test("creating runs and runs whose thread is running hold a slot; idle and finished threads do not", () => {
    const runs = [
      row("creating", undefined),
      row("active", "busy"),
      row("active", "quiet"),
      row("kept", "quiet"),
      row("kept", "busy"),
      row("closed", "busy"),
      row("queued", undefined),
    ]
    expect(slotHolders(runs, states)).toHaveLength(3)
  })
})
