import { afterEach, describe, expect, test } from "bun:test"

import { ApiError } from "../../src/api/errors"
import { parseLoopTemplate } from "../../src/loops/request"
import { createLoopEngine } from "../../src/loops/engine"
import { closeRigs, engineRig } from "../runs/harness"

afterEach(closeRigs)

const body = {
  prompt: "Repair the project",
  doneWhen: [{ kind: "check", command: ["bun", "test"] }],
}

describe("loop request boundary", () => {
  test("a member cannot configure a check on a project without full-access opt-in", async () => {
    const rig = await engineRig()
    try {
      parseLoopTemplate(body, {
        actor: rig.user,
        project: rig.project,
        config: rig.config,
        ownerSettings: rig.user.settings,
      })
      throw new Error("expected check authorization to fail")
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError)
      expect(error).toMatchObject({ code: "forbidden" })
    }
  })

  test("check timeout and iteration default are parsed from daemon configuration", async () => {
    const rig = await engineRig({ project: { fullAccessOptIn: true } })
    const ownerSettings = { ...rig.user.settings, loopMaxIterations: 4 }
    rig.repos.users.put({ ...rig.user, settings: ownerSettings })
    const parsed = parseLoopTemplate(body, {
      actor: rig.user,
      project: rig.project,
      config: rig.config,
      ownerSettings,
    })
    expect(parsed).toMatchObject({
      maxIterations: 4,
      maxWallMs: rig.config.defaults.loopMaxWallMs,
      doneWhen: [{ kind: "check", command: ["bun", "test"], timeoutMs: rig.config.limits.loopCheckTimeoutMs }],
    })
  })

  test("user defaults and per-loop values cover each configurable loop budget", async () => {
    const rig = await engineRig({ project: { fullAccessOptIn: true } })
    const userSettings = {
      loopMaxIterations: 7,
      loopMaxWallMs: 9_000,
      loopMaxConsecutiveFailures: 4,
      loopCheckTimeoutMs: 901,
      loopCadenceMs: 123,
      loopBackoffInitialMs: 200,
      loopBackoffFactor: 3,
      loopBackoffMaxMs: 700,
      loopCarryForwardBytes: 2_048,
    }
    rig.repos.users.put({ ...rig.user, settings: userSettings })
    expect(rig.repos.users.get(rig.user.id)?.settings).toMatchObject(userSettings)
    const project = { ...rig.project, settings: { ...rig.project.settings, fullAccessOptIn: true } }
    const loops = createLoopEngine({
      db: rig.db,
      repos: rig.repos,
      clock: rig.clock,
      rng: rig.rng,
      git: rig.git,
      fs: rig.fs,
      config: rig.config,
      worktreeRoot: "/tmp/loop-parser",
      engine: () => rig.engine,
    })

    expect(loops.parseTemplate(body, rig.user, project)).toMatchObject({
      maxIterations: 7,
      maxWallMs: 9_000,
      maxConsecutiveFailures: 4,
      cadenceMs: 123,
      backoff: { initialMs: 200, factor: 3, maxMs: 700 },
      carryForwardBytes: 2_048,
      doneWhen: [{ kind: "check", command: ["bun", "test"], timeoutMs: 901 }],
    })
    expect(loops.parseTemplate({
      ...body,
      maxIterations: 6,
      maxWallMs: 8_000,
      maxConsecutiveFailures: 5,
      cadenceMs: 222,
      backoff: { initialMs: 300, factor: 2.5, maxMs: 900 },
      carryForwardBytes: 4_096,
      doneWhen: [{ kind: "check", command: ["bun", "test"], timeoutMs: 321 }],
    }, rig.user, project)).toMatchObject({
      maxIterations: 6,
      maxWallMs: 8_000,
      maxConsecutiveFailures: 5,
      cadenceMs: 222,
      backoff: { initialMs: 300, factor: 2.5, maxMs: 900 },
      carryForwardBytes: 4_096,
      doneWhen: [{ kind: "check", command: ["bun", "test"], timeoutMs: 321 }],
    })
  })

  test("user defaults are constrained by each administrator hard cap", async () => {
    const rig = await engineRig({ project: { fullAccessOptIn: true } })
    const caps = rig.config.hardCaps
    const ownerSettings = {
      loopMaxIterations: caps.loopMaxIterations + 1,
      loopMaxWallMs: caps.loopMaxWallMs + 1,
      loopMaxConsecutiveFailures: caps.loopMaxConsecutiveFailures + 1,
      loopCheckTimeoutMs: caps.loopCheckTimeoutMs + 1,
      loopCadenceMs: caps.loopCadenceMs + 1,
      loopBackoffInitialMs: caps.loopBackoffMs + 1,
      loopBackoffFactor: caps.loopBackoffFactor + 1,
      loopBackoffMaxMs: caps.loopBackoffMs + 1,
      loopCarryForwardBytes: caps.loopCarryForwardBytes + 1,
    }
    rig.repos.users.put({ ...rig.user, settings: ownerSettings })
    const project = { ...rig.project, settings: { ...rig.project.settings, fullAccessOptIn: true } }
    const loops = createLoopEngine({
      db: rig.db,
      repos: rig.repos,
      clock: rig.clock,
      rng: rig.rng,
      git: rig.git,
      fs: rig.fs,
      config: rig.config,
      worktreeRoot: "/tmp/loop-parser",
      engine: () => rig.engine,
    })

    expect(loops.parseTemplate(body, rig.user, project)).toMatchObject({
      maxIterations: caps.loopMaxIterations,
      maxWallMs: caps.loopMaxWallMs,
      maxConsecutiveFailures: caps.loopMaxConsecutiveFailures,
      cadenceMs: caps.loopCadenceMs,
      backoff: { initialMs: caps.loopBackoffMs, factor: caps.loopBackoffFactor, maxMs: caps.loopBackoffMs },
      carryForwardBytes: caps.loopCarryForwardBytes,
      doneWhen: [{ kind: "check", timeoutMs: caps.loopCheckTimeoutMs }],
    })
  })
})
