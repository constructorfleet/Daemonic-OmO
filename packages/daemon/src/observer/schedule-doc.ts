import { statSync } from "node:fs"
import { join } from "node:path"
import { listOmoSchedules, type OmoScheduleSnapshot } from "@omo-daemonic/store"
import { isMissing } from "./jsonl-cursor"
import type { DocChange } from "./transcript-doc"

const SCHEDULE_DIRS = ["pending", "firing", "failed", "cancelled", "runners"] as const
/** Runner liveness (pid, start time, heartbeat age) drifts without file changes, so the list is refreshed at least this often. */
const LIVENESS_REFRESH_MS = 10_000

export type ScheduleOp = { readonly op: "schedule.set"; readonly schedules: OmoScheduleSnapshot }

/** `schedules:<userId>`: the omo-native schedules of the user's agent dir, re-listed when a schedule directory changes. */
export class ScheduleDoc {
  #snapshot: OmoScheduleSnapshot = { jobs: [], invalidRecords: 0, liveRunners: [] }
  #json = ""
  #signature = ""
  #listedAt = Number.NEGATIVE_INFINITY
  #started = false

  constructor(readonly agentDir: string, readonly now: () => number) {}

  poll(): DocChange<ScheduleOp> | null {
    const now = this.now()
    const signature = SCHEDULE_DIRS.map((name) => this.#mtime(name)).join(":")
    if (this.#started && signature === this.#signature && now - this.#listedAt < LIVENESS_REFRESH_MS) return null
    this.#signature = signature
    this.#listedAt = now
    const next = listOmoSchedules(this.agentDir, { now })
    const json = JSON.stringify(next)
    const changed = json !== this.#json
    this.#snapshot = next
    this.#json = json
    if (!this.#started) {
      this.#started = true
      return null
    }
    return changed ? { ops: [{ op: "schedule.set", schedules: next }] } : null
  }

  snapshot(): OmoScheduleSnapshot {
    return this.#snapshot
  }

  #mtime(name: string): string {
    try {
      return String(statSync(join(this.agentDir, "schedule", name)).mtimeMs)
    } catch (error) {
      if (isMissing(error)) return "-"
      throw error
    }
  }
}
