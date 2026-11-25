import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

const STATES = ["pending", "firing", "failed"] as const
const MAX_JOB_BYTES = 64 * 1024
const MAX_RUNNER_AGE_MS = 5 * 60 * 1000
const RECORD_NAME = /^(sch_[a-z0-9]{12})(?:@(\d+)(?:~(\d+)-(\d+))?)?\.json$/

export type OmoScheduleState = (typeof STATES)[number]
export type OmoScheduleJob = {
  readonly id: string
  readonly sessionId: string
  readonly sessionFile: string | null
  readonly cwd: string
  readonly prompt: string
  readonly createdAt: number
  readonly dueAt: number
  readonly everyMs: number | null
  readonly fireCount: number
  readonly lastFiredAt: number | null
  readonly lastError: string | null
}
export type OmoScheduleRecord = OmoScheduleJob & {
  readonly state: OmoScheduleState
  readonly cancelled: boolean
  readonly occurrence?: number
}
export type OmoScheduleSnapshot = {
  readonly jobs: readonly OmoScheduleRecord[]
  readonly invalidRecords: number
  readonly liveRunners: readonly OmoScheduleRunner[]
}
export type OmoScheduleRunner = {
  readonly pid: number
  readonly processStartedAtMs: number
  readonly beatAt: number
  readonly watch: boolean
}

export function listOmoSchedules(agentDir: string, options: { readonly now?: number } = {}): OmoScheduleSnapshot {
  const scheduleDir = join(agentDir, "schedule")
  const cancelled = new Set(readNames(join(scheduleDir, "cancelled")))
  const jobs: OmoScheduleRecord[] = []
  let invalidRecords = 0
  for (const state of STATES) {
    const directory = join(scheduleDir, state)
    for (const name of readNames(directory).sort()) {
      const match = RECORD_NAME.exec(name)
      if (match === null) {
        if (name.endsWith(".json")) invalidRecords += 1
        continue
      }
      const [, id, occurrence, pid, startedAt] = match
      let shapeValid: boolean
      switch (state) {
        case "pending":
          shapeValid = occurrence === undefined
          break
        case "firing":
          shapeValid = occurrence !== undefined && pid !== undefined && startedAt !== undefined
          break
        case "failed":
          shapeValid = occurrence !== undefined && pid === undefined
          break
        default: {
          const unreachable: never = state
          throw new TypeError(`Unexpected schedule state: ${unreachable}`)
        }
      }
      if (!shapeValid || id === undefined) {
        invalidRecords += 1
        continue
      }
      try {
        const path = join(directory, name)
        if (statSync(path).size > MAX_JOB_BYTES) throw new TypeError("schedule record is too large")
        const job = decodeJob(JSON.parse(readFileSync(path, "utf8")))
        if (job === undefined || job.id !== id) throw new TypeError("schedule record is malformed")
        jobs.push({
          ...job,
          state,
          cancelled: cancelled.has(id),
          ...(occurrence === undefined ? {} : { occurrence: Number(occurrence) }),
        })
      } catch {
        invalidRecords += 1
      }
    }
  }
  jobs.sort((a, b) => a.dueAt - b.dueAt || a.id.localeCompare(b.id) || STATES.indexOf(a.state) - STATES.indexOf(b.state))
  const now = options.now ?? Date.now()
  const liveRunners: OmoScheduleRunner[] = []
  for (const name of readNames(join(scheduleDir, "runners")).filter((entry) => /^\d+\.json$/.test(entry))) {
    const result = readRunner(join(scheduleDir, "runners", name), now)
    if (result.runner !== undefined) liveRunners.push(result.runner)
    if (result.invalid) invalidRecords += 1
  }
  return { jobs, invalidRecords, liveRunners }
}

function decodeJob(value: unknown): OmoScheduleJob | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined
  const { id, sessionId, sessionFile, cwd, prompt, createdAt, dueAt, everyMs, fireCount, lastFiredAt, lastError } = value
  if (typeof id !== "string" || typeof sessionId !== "string" || !nullableString(sessionFile) ||
    typeof cwd !== "string" || typeof prompt !== "string" || !count(createdAt) || !count(dueAt) ||
    !(everyMs === null || count(everyMs)) || !count(fireCount) ||
    !(lastFiredAt === null || count(lastFiredAt)) || !nullableString(lastError)) return undefined
  return {
    id, sessionId, sessionFile, cwd, prompt, createdAt, dueAt, everyMs, fireCount, lastFiredAt, lastError,
  }
}
function readRunner(path: string, now: number): { readonly runner?: OmoScheduleRunner; readonly invalid: boolean } {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return { invalid: true }
  }
  if (!isRecord(value)) return { invalid: true }
  const { pid, processStartedAtMs, beatAt, watch } = value
  if (!count(pid) || pid === 0 || !count(processStartedAtMs) || !count(beatAt) || typeof watch !== "boolean") {
    return { invalid: true }
  }
  if (now - beatAt > MAX_RUNNER_AGE_MS || beatAt > now + 2_000) return { invalid: false }
  const probe = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 2_000 })
  if (probe.error !== undefined || probe.status !== 0) return { invalid: false }
  const psStartedAt = Date.parse(probe.stdout.trim())
  if (!Number.isFinite(psStartedAt) || Math.abs(psStartedAt - processStartedAtMs) > 2_000) {
    return { invalid: false }
  }
  return { runner: { pid, processStartedAtMs, beatAt, watch }, invalid: false }
}
function readNames(path: string): string[] {
  try {
    return readdirSync(path)
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}
function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string"
}
function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")
}
