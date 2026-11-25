import { join } from "node:path"

import { FsError, type DirEntry, type Fs } from "../core/ports"
import { isRecord } from "./decode"

/**
 * Read-only structural checks of the omo stores under one agent dir, for the compatibility probe: they count
 * records the daemon's readers could not decode, so an omo format change shows up as a failing probe instead
 * of silently missing data. Layouts are FINDINGS assertions 3 and 5 and omo's DAG store (`<stateDir>/dag/events`).
 */

/** Same bound as the viewer's task reader: a record past it is counted invalid without reading it. */
const MAX_RECORD_BYTES = 1_048_576
const SESSION_HEAD_BYTES = 65_536
export const SUPPORTED_DAG_SCHEMA_VERSIONS: readonly number[] = [1]

export interface DecodeCount {
  readonly total: number
  readonly invalid: number
}

export interface DagJournalCount extends DecodeCount {
  readonly unknownVersions: readonly number[]
}

export async function countTaskRecords(fs: Fs, agentDir: string): Promise<DecodeCount> {
  const files = await filesUnder(fs, await taskStateDirs(fs, agentDir), "tasks", ".json")
  let invalid = 0
  for (const file of files) {
    const size = (await fs.stat(file)).size
    const record = size > MAX_RECORD_BYTES ? null : parseJson(await readText(fs, file, size))
    if (!isRecord(record) || typeof record.task_id !== "string" || typeof record.status !== "string") invalid += 1
  }
  return { total: files.length, invalid }
}

export async function countSessionFiles(fs: Fs, agentDir: string): Promise<DecodeCount> {
  const sessions = join(agentDir, "sessions")
  const folders = (await entries(fs, sessions)).filter((entry) => entry.kind === "directory").map((entry) => join(sessions, entry.name))
  const files = await filesUnder(fs, folders, "", ".jsonl")
  let invalid = 0
  for (const file of files) {
    const header = parseJson(firstLine(await readText(fs, file, SESSION_HEAD_BYTES)))
    if (!isRecord(header) || header.type !== "session" || typeof header.id !== "string") invalid += 1
  }
  return { total: files.length, invalid }
}

export async function countDagJournals(fs: Fs, agentDir: string): Promise<DagJournalCount> {
  const files = await filesUnder(fs, await taskStateDirs(fs, agentDir), join("dag", "events"), ".jsonl")
  const unknown: number[] = []
  let invalid = 0
  for (const file of files) {
    const envelope = parseJson(firstLine(await readText(fs, file, SESSION_HEAD_BYTES)))
    const version = isRecord(envelope) && typeof envelope.schemaVersion === "number" ? envelope.schemaVersion : null
    if (version !== null && SUPPORTED_DAG_SCHEMA_VERSIONS.includes(version)) continue
    invalid += 1
    if (version !== null && !unknown.includes(version)) unknown.push(version)
  }
  return { total: files.length, invalid, unknownVersions: unknown }
}

async function taskStateDirs(fs: Fs, agentDir: string): Promise<readonly string[]> {
  const projects = join(agentDir, "projects")
  return (await entries(fs, projects)).filter((entry) => entry.kind === "directory").map((entry) => join(projects, entry.name, "senpi-task"))
}

async function filesUnder(fs: Fs, roots: readonly string[], relative: string, suffix: string): Promise<readonly string[]> {
  const found: string[] = []
  for (const root of roots) {
    const directory = join(root, relative)
    for (const entry of await entries(fs, directory)) {
      if (entry.kind === "file" && entry.name.endsWith(suffix)) found.push(join(directory, entry.name))
    }
  }
  return found
}

/** A missing directory is an empty store; any other read failure is a real error for the probe to report. */
async function entries(fs: Fs, path: string): Promise<readonly DirEntry[]> {
  try {
    return await fs.readdir(path)
  } catch (error) {
    if (error instanceof FsError && error.code === "not_found") return []
    throw error
  }
}

async function readText(fs: Fs, path: string, length: number): Promise<string> {
  return new TextDecoder().decode(await fs.readFileRange(path, 0, length))
}

function firstLine(text: string): string {
  const newline = text.indexOf("\n")
  return newline < 0 ? text : text.slice(0, newline)
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
