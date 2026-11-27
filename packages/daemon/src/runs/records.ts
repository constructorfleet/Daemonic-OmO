import type { Database } from "bun:sqlite"

import type { Repositories } from "../auth/types"
import { parseUlid } from "../core/ids"
import type { Clock } from "../core/ports"
import type { ProjectId, Run, RunId, RunState, ThreadId, UserId } from "../core/types"
import { nextState, type RunStep } from "./state-machine"

export type RunPatch = Omit<Partial<Pick<Run,
  "threadId" | "sessionId" | "sessionFile" | "transcriptBaselineBytes" | "completionBindingId" |
  "loopEvaluationDone" | "loopKeepThreadOpen" | "closePending" |
  "cancelRequested" | "cancelReason" | "orphanChildren" | "errorDetail">>, "sessionFile"> & {
    readonly sessionFile?: string | null
  }

export interface RunListFilter {
  readonly userId: UserId | null
  readonly projectId: ProjectId | null
  readonly state: RunState | null
  readonly limit: number
}

export class RunNotFoundError extends Error {
  readonly name = "RunNotFoundError"

  constructor(readonly runId: string) {
    super(`run ${runId} not found`)
  }
}

const UNFINISHED = "('queued', 'creating', 'active', 'settled', 'evaluating')"

/** Run rows through the runs repository: every write advances the revision and emits `run.state_changed`. */
export function createRunRecords(db: Database, repos: Repositories, clock: Clock) {
  const ids = (sql: string, ...params: (string | number)[]): readonly Run[] =>
    db.query<{ readonly id: string }, (string | number)[]>(sql).all(...params).flatMap(({ id }) => {
      const parsed = parseUlid(id)
      const run = parsed === null ? null : repos.runs.get(parsed)
      return run === null ? [] : [run]
    })

  const write = (run: Run, next: Run): Run => {
    repos.runs.update(next, run.revision)
    return next
  }

  function applyPatch(run: Run, patch: RunPatch): Run {
    const { sessionFile, ...fields } = patch
    const { sessionFile: previousFile, ...withoutFile } = run
    const base = sessionFile === null ? withoutFile : run
    return {
      ...base,
      ...fields,
      ...(sessionFile === null ? {} : sessionFile === undefined
        ? previousFile === undefined ? {} : { sessionFile: previousFile }
        : { sessionFile }),
    }
  }

  return {
    get: (id: RunId): Run | null => repos.runs.get(id),

    require(id: RunId): Run {
      const run = repos.runs.get(id)
      if (run === null) throw new RunNotFoundError(id)
      return run
    },

    byFireKey: (fireKey: string, attempt: number): Run | null => repos.runs.getByFireKey(fireKey, attempt),

    insert: (run: Run): void => repos.runs.put(run),

    step(run: Run, step: RunStep, patch: RunPatch = {}): Run {
      const position = nextState(run, step)
      const at = new Date(clock.now()).toISOString()
      return write(run, {
        ...applyPatch(run, patch),
        ...position,
        ...(step.kind === "activate" ? { activeAt: at } : {}),
        ...(step.kind === "settle" ? { settledAt: at } : {}),
        ...(position.state === "closed" || position.state === "kept" ? { endedAt: at } : {}),
        revision: run.revision + 1,
        updatedAt: at,
      })
    },

    patch(run: Run, patch: RunPatch): Run {
      return write(run, { ...applyPatch(run, patch), revision: run.revision + 1, updatedAt: new Date(clock.now()).toISOString() })
    },

    queued: (): readonly Run[] => ids("SELECT id FROM runs WHERE state = 'queued' ORDER BY created_at, id"),

    waitsForPreviousLoopClose(run: Run): boolean {
      if (run.loopId === undefined || run.iteration === undefined) return false
      const row = db.query<{ readonly pending: number }, [string, number]>(
        `SELECT EXISTS(
           SELECT 1 FROM runs WHERE loop_id = ? AND json_extract(json, '$.iteration') < ?
             AND (state = 'evaluating' OR json_extract(json, '$.closePending') = 1)
         ) AS pending`,
      ).get(run.loopId, run.iteration)
      return row !== null && row.pending === 1
    },

    unfinished: (): readonly Run[] => ids(`SELECT id FROM runs WHERE state IN ${UNFINISHED} ORDER BY created_at, id`),

    /** Runs that may hold a slot: everything past `queued` that is not closed. */
    live: (): readonly Run[] => ids("SELECT id FROM runs WHERE state NOT IN ('queued', 'closed') ORDER BY created_at, id"),

    unfinishedOf: (userId: UserId): readonly Run[] =>
      ids(`SELECT id FROM runs WHERE user_id = ? AND state IN ${UNFINISHED} ORDER BY created_at, id`, userId),

    unfinishedInProject: (projectId: ProjectId): readonly Run[] =>
      ids(`SELECT id FROM runs WHERE project_id = ? AND state IN ${UNFINISHED} ORDER BY created_at, id`, projectId),

    activeByThread: (thread: ThreadId): Run | null =>
      ids("SELECT id FROM runs WHERE state = 'active' AND json_extract(json, '$.threadId') = ? LIMIT 1", thread)[0] ?? null,

    closedOnThreads: (threads: readonly ThreadId[]): readonly Run[] =>
      ids(
        "SELECT id FROM runs WHERE state = 'closed' AND json_extract(json, '$.threadId') IN (SELECT value FROM json_each(?)) ORDER BY created_at, id",
        JSON.stringify(threads),
      ),

    closedWithPendingClose: (): readonly Run[] =>
      ids("SELECT id FROM runs WHERE state = 'closed' AND json_extract(json, '$.closePending') = 1 ORDER BY created_at, id"),

    withOrphans: (): readonly Run[] =>
      ids("SELECT id FROM runs WHERE state = 'closed' AND json_array_length(json, '$.orphanChildren') > 0 ORDER BY created_at, id"),

    list(filter: RunListFilter): readonly Run[] {
      const conditions = [
        { column: "user_id", value: filter.userId },
        { column: "project_id", value: filter.projectId },
        { column: "state", value: filter.state },
      ].flatMap(({ column, value }) => (value === null ? [] : [{ column, value }]))
      const where = conditions.length === 0 ? "" : `WHERE ${conditions.map(({ column }) => `${column} = ?`).join(" AND ")}`
      const params = conditions.map(({ value }) => value)
      return ids(`SELECT id FROM runs ${where} ORDER BY created_at DESC, id DESC LIMIT ?`, ...params, filter.limit)
    },
  }
}

export type RunRecords = ReturnType<typeof createRunRecords>
