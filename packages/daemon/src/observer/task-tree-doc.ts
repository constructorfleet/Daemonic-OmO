import { join } from "node:path"
import {
  decodeDagRunRecord,
  decodeTaskRecord,
  projectTaskTree,
  type DagRunRecordV1,
  type TaskRecord,
  type TaskTreeItem,
} from "@omo-daemonic/store"
import { RecordDir } from "./record-dir"
import type { DocChange } from "./transcript-doc"

const MAX_TASK_BYTES = 256 * 1024
const MAX_RUN_BYTES = 512 * 1024

export type TaskTreeOp =
  | { readonly op: "task.upsert"; readonly index: number; readonly item: TaskTreeItem }
  | { readonly op: "task.remove"; readonly id: string }

export interface TaskTreeSnapshot {
  readonly items: readonly TaskTreeItem[]
  readonly invalidRecords: number
}

interface StoreDirs {
  readonly tasks: RecordDir<TaskRecord>
  readonly runs: RecordDir<DagRunRecordV1>
}

/**
 * `project:<id>:tasks`: `projectTaskTree` over the records of every store in the
 * project's set (first store wins a duplicate task id) with their DAG runs.
 * Ops turn the previous item list into the next one when applied in order: a
 * remove drops an id, an upsert drops the item's id wherever it is and inserts
 * the item at `index`.
 */
export class TaskTreeDoc {
  readonly #stores = new Map<string, StoreDirs>()
  #items: readonly TaskTreeItem[] = []
  #invalid = 0

  constructor(readonly stateDirs: () => readonly string[]) {}

  poll(): DocChange<TaskTreeOp> | null {
    const previous = this.#items
    this.#items = this.#project()
    const ops = diffItems(previous, this.#items)
    return ops.length === 0 ? null : { ops }
  }

  snapshot(): TaskTreeSnapshot {
    return { items: this.#items, invalidRecords: this.#invalid }
  }

  #project(): readonly TaskTreeItem[] {
    const records = new Map<string, TaskRecord>()
    const runs = new Map<string, DagRunRecordV1>()
    let invalid = 0
    const dirs = this.stateDirs()
    for (const stale of [...this.#stores.keys()].filter((dir) => !dirs.includes(dir))) this.#stores.delete(stale)
    for (const dir of dirs) {
      const store = this.#store(dir)
      const tasks = store.tasks.scan()
      const dag = store.runs.scan()
      invalid += tasks.invalid
      for (const record of tasks.values) if (!records.has(record.task_id)) records.set(record.task_id, record)
      for (const run of dag.values) if (!runs.has(run.runId)) runs.set(run.runId, run)
    }
    this.#invalid = invalid
    return projectTaskTree([...records.values()], { runs: [...runs.values()] })
  }

  #store(dir: string): StoreDirs {
    const existing = this.#stores.get(dir)
    if (existing !== undefined) return existing
    const created: StoreDirs = {
      tasks: new RecordDir(join(dir, "tasks"), decodeTaskRecord, MAX_TASK_BYTES),
      runs: new RecordDir(join(dir, "dag", "runs"), decodeDagRunRecord, MAX_RUN_BYTES),
    }
    this.#stores.set(dir, created)
    return created
  }
}

function diffItems(previous: readonly TaskTreeItem[], next: readonly TaskTreeItem[]): readonly TaskTreeOp[] {
  const nextIds = new Set(next.map((item) => item.id))
  const ops: TaskTreeOp[] = previous.filter((item) => !nextIds.has(item.id)).map((item) => ({ op: "task.remove", id: item.id }))
  const current = previous.filter((item) => nextIds.has(item.id))
  next.forEach((item, index) => {
    const there = current[index]
    if (there !== undefined && there.id === item.id && JSON.stringify(there) === JSON.stringify(item)) return
    const from = current.findIndex((candidate) => candidate.id === item.id)
    if (from >= 0) current.splice(from, 1)
    current.splice(index, 0, item)
    ops.push({ op: "task.upsert", index, item })
  })
  return ops
}
