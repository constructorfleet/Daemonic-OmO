import type { Database } from "bun:sqlite"

import { ServiceKey } from "../api/services"
import type { Repositories } from "../auth/types"
import { parseUlid, ulid } from "../core/ids"
import type { Clock, Fs, Git, Rng } from "../core/ports"
import type { Loop, LoopId, LoopTemplate, Ms, Project, Run, ScheduleId, User } from "../core/types"
import type { Config } from "../config"
import { createLoopCheckRunner, type LoopCheckRunner } from "./check"
import { createLoopRecord } from "./creation"
import { evaluateLoop } from "./done"
import { startLoopIteration } from "./iteration"
import { effectiveLoopLimits } from "./limits"
import { parseLoopTemplate } from "./request"
import { isTerminalLoop, nextLoopState } from "./state-machine"
import { stateForDecision } from "./transition"
import type { LoopLaunch, LoopLauncher } from "../scheduler/fire"
import type { RunEngine } from "../runs/engine"

export interface LoopEngineDeps {
  readonly db: Database
  readonly repos: Repositories
  readonly clock: Clock
  readonly rng: Rng
  readonly git: Git
  readonly fs: Fs
  readonly config: Pick<Config, "defaults" | "hardCaps" | "limits">
  readonly worktreeRoot: string
  readonly check?: LoopCheckRunner
  engine(): RunEngine
  readonly onError?: (error: unknown) => void
}

export interface LoopCreateInput {
  readonly actor: User
  readonly project: Project
  readonly template: LoopTemplate
}

export interface LoopEngine extends LoopLauncher {
  get(id: LoopId): Loop | null
  list(projectId?: Loop["projectId"], state?: Loop["state"]): readonly Loop[]
  create(input: LoopCreateInput): Promise<Loop>
  cancel(actor: User, id: LoopId): Promise<{ readonly loop: Loop; readonly alreadyTerminal: boolean }>
  recover(): Promise<void>
  idle(): Promise<void>
}

export const LOOP_ENGINE = new ServiceKey<LoopEngine>("loops")

function nowIso(now: Ms): string {
  return new Date(now).toISOString()
}

export function createLoopEngine(deps: LoopEngineDeps): LoopEngine {
  const check = deps.check ?? createLoopCheckRunner(deps.clock)
  const report = deps.onError ?? ((error: unknown) => console.error("omo-daemonic: loop engine step failed", error))
  const pending = new Set<Promise<void>>()
  let ticking: Promise<void> = Promise.resolve()

  const save = (loop: Loop, next: Loop): Loop => {
    const at = nowIso(deps.clock.now())
    deps.repos.loops.update(next, loop.revision, at)
    return next
  }
  const iterationDeps = {
    db: deps.db,
    repos: deps.repos,
    clock: deps.clock,
    git: deps.git,
    fs: deps.fs,
    config: deps.config,
    worktreeRoot: deps.worktreeRoot,
    engine: deps.engine,
    save,
  }

  function rows(): readonly Loop[] {
    return deps.db.query<{ readonly id: string }, []>(
      "SELECT id FROM loops ORDER BY rowid",
    ).all().flatMap(({ id }) => {
      const parsed = parseUlid(id)
      const loop = parsed === null ? null : deps.repos.loops.get(parsed)
      return loop === null ? [] : [loop]
    })
  }

  async function createRecord(
    project: Project,
    template: LoopTemplate,
    fireKey: string,
    scheduleId?: ScheduleId,
  ): Promise<Loop> {
    const loop = await createLoopRecord(
      {
        db: deps.db,
        repos: deps.repos,
        clock: deps.clock,
        rng: deps.rng,
        git: deps.git,
        config: deps.config,
        worktreeRoot: deps.worktreeRoot,
      },
      { project, template, fireKey, ...(scheduleId === undefined ? {} : { scheduleId }) },
    )
    if (!isTerminalLoop(loop.state)) track(tick(deps.clock.now()))
    return loop
  }

  async function processLoop(loop: Loop, now: Ms): Promise<void> {
    if (loop.state === "cancelling") {
      const active = loop.activeRunId === undefined ? null : deps.repos.runs.get(loop.activeRunId)
      if (active !== null && active.state !== "closed" && active.state !== "kept") {
        const owner = deps.repos.users.get(loop.userId)
        if (owner !== null) await deps.engine().cancel(owner, active.id, "loop_cancel")
        return
      }
      if (active === null || active.state === "closed" || active.state === "kept") {
        const { activeRunId: _active, ...rest } = loop
        save(loop, { ...rest, state: nextLoopState(loop.state, { kind: "cancelled" }), nextIterationAt: null, endedAt: nowIso(now), revision: loop.revision + 1 })
      }
      return
    }
    if (loop.state === "running") {
      const run = loop.activeRunId === undefined ? null : deps.repos.runs.get(loop.activeRunId)
      if (loop.activeRunId === undefined) await startLoopIteration(iterationDeps, loop)
      else if (run !== null && (run.state === "closed" || run.state === "kept") && loop.evaluatedRunId !== run.id) {
        await engine.settled(run)
      }
      return
    }
    if ((loop.state === "pending" || loop.state === "waiting") && loop.nextIterationAt !== null && loop.nextIterationAt <= now) {
      if (loop.iteration >= Math.min(loop.maxIterations, deps.config.hardCaps.loopMaxIterations)) {
        const exhausted = { ...loop, state: nextLoopState(loop.state, { kind: "exhaust" }), stopReason: "max_iterations", nextIterationAt: null, endedAt: nowIso(now), revision: loop.revision + 1 }
        save(loop, exhausted)
        return
      }
      const started = loop.startedAt === undefined ? now : Date.parse(loop.startedAt)
      const defaultWallMs = effectiveLoopLimits(deps.config, deps.repos.users.get(loop.userId)?.settings ?? {}).maxWallMs
      if (now - started >= Math.min(loop.maxWallMs ?? defaultWallMs, deps.config.hardCaps.loopMaxWallMs)) {
        save(loop, { ...loop, state: nextLoopState(loop.state, { kind: "exhaust" }), stopReason: "max_wall_time", nextIterationAt: null, endedAt: nowIso(now), revision: loop.revision + 1 })
        return
      }
      await startLoopIteration(iterationDeps, loop)
    }
  }

  function tick(now: Ms): Promise<void> {
    const next = ticking.then(async () => {
      for (const loop of rows()) await processLoop(loop, now)
    })
    ticking = next.then(() => undefined, report)
    return next
  }

  function track(work: Promise<unknown>): void {
    const task = work.then(() => undefined, report).finally(() => pending.delete(task))
    pending.add(task)
  }

  const engine: LoopEngine = {
    parseTemplate(value, actor, project) {
      const owner = deps.repos.users.get(project.userId)
      return parseLoopTemplate(value, {
        actor,
        project,
        config: deps.config,
        ownerSettings: owner?.settings ?? {},
      })
    },
    launch(input: LoopLaunch) {
      track(createRecord(input.project, input.template, input.fireKey, input.scheduleId))
    },
    tick,
    get: (id) => deps.repos.loops.get(id),
    list(projectId, state) {
      return rows().filter((loop) =>
        (projectId === undefined || loop.projectId === projectId) && (state === undefined || loop.state === state))
    },
    create({ actor, project, template }) {
      if (actor.id !== project.userId && actor.role !== "admin") throw new RangeError("project is outside the actor's scope")
      return createRecord(project, template, `loop:${ulid(deps.rng, deps.clock.now())}`)
    },
    async cancel(actor, id) {
      const loop = deps.repos.loops.get(id)
      if (loop === null || (loop.userId !== actor.id && actor.role !== "admin")) {
        throw new RangeError(`loop ${id} not found`)
      }
      if (isTerminalLoop(loop.state)) return { loop, alreadyTerminal: true }
      const cancelling = loop.state === "cancelling" ? loop : save(loop, {
        ...loop,
        state: nextLoopState(loop.state, { kind: "cancel" }),
        stopReason: "user",
        nextIterationAt: null,
        revision: loop.revision + 1,
      })
      const run = cancelling.activeRunId === undefined ? null : deps.repos.runs.get(cancelling.activeRunId)
      if (run === null || run.state === "closed" || run.state === "kept") {
        const { activeRunId: _active, ...rest } = cancelling
        const ended = { ...rest, state: nextLoopState(cancelling.state, { kind: "cancelled" }), endedAt: nowIso(deps.clock.now()), revision: cancelling.revision + 1 }
        return { loop: save(cancelling, ended), alreadyTerminal: false }
      }
      const stopped = await deps.engine().cancel(actor, run.id, "loop_cancel")
      if (stopped.uninterruptible) return { loop: deps.repos.loops.get(id) ?? cancelling, alreadyTerminal: false }
      const latest = deps.repos.loops.get(id) ?? cancelling
      const { activeRunId: _active, ...rest } = latest
      return {
        loop: save(latest, { ...rest, state: nextLoopState(latest.state, { kind: "cancelled" }), nextIterationAt: null, endedAt: nowIso(deps.clock.now()), revision: latest.revision + 1 }),
        alreadyTerminal: false,
      }
    },
    async settled(run) {
      if (run.loopId === undefined) return false
      const loop = deps.repos.loops.get(run.loopId)
      if (loop === null) return false
      if (loop.evaluatedRunId === run.id) return loop.sessionMode === "continue" && loop.state === "waiting"
      if (loop.activeRunId !== run.id) return false
      const owner = deps.repos.users.get(loop.userId)
      const limits = effectiveLoopLimits(deps.config, owner?.settings ?? {})
      const decision = await evaluateLoop({
        fs: deps.fs,
        clock: deps.clock,
        rng: deps.rng,
        check,
        readBytes: limits.readBytes,
        errorTailChars: deps.config.limits.omoCommandStderrTailChars,
        defaultMaxWallMs: limits.maxWallMs,
        hardMaxIterations: deps.config.hardCaps.loopMaxIterations,
        hardMaxWallMs: deps.config.hardCaps.loopMaxWallMs,
        hardMaxConsecutiveFailures: deps.config.hardCaps.loopMaxConsecutiveFailures,
        hardMaxCheckTimeoutMs: deps.config.hardCaps.loopCheckTimeoutMs,
        hardMaxCadenceMs: deps.config.hardCaps.loopCadenceMs,
        hardMaxBackoffMs: deps.config.hardCaps.loopBackoffMs,
        hardMaxBackoffFactor: deps.config.hardCaps.loopBackoffFactor,
      }, { loop, run })
      const transition = stateForDecision(loop, decision, deps.clock.now())
      const { activeRunId: _active, ...withoutActive } = transition
      const next = {
        ...withoutActive,
        ...(run.threadId === undefined ? {} : { threadId: run.threadId }),
        ...(run.sessionId === undefined ? {} : { sessionId: run.sessionId }),
        ...(run.sessionFile === undefined ? {} : { sessionFile: run.sessionFile }),
      }
      save(loop, next)
      return loop.sessionMode === "continue" && decision.kind === "continue"
    },
    async recover() {
      for (const loop of rows()) {
        if (loop.state !== "running" || loop.activeRunId === undefined) continue
        const run = deps.repos.runs.get(loop.activeRunId)
        if (run !== null && (run.state === "closed" || run.state === "kept") && loop.evaluatedRunId !== run.id) {
          await engine.settled(run)
        }
      }
    },
    async idle() {
      while (pending.size > 0) await Promise.all([...pending])
    },
  }

  return engine
}

function assertNever(value: never): never {
  throw new TypeError(`unexpected loop decision: ${JSON.stringify(value)}`)
}
