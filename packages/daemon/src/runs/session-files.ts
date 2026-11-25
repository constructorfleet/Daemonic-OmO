import { join } from "node:path"

import { FsError, type Fs } from "../core/ports"
import type { ThreadId } from "../core/types"

const TAIL_BYTES = 64 * 1024

/** The session file of a thread, found by globbing `<agentDir>/sessions/*\/*_<thread>.jsonl` (FINDINGS assertion 3). */
export async function findSessionFile(fs: Fs, agentDir: string, thread: ThreadId): Promise<string | null> {
  const sessions = join(agentDir, "sessions")
  const folders = await readdirOrEmpty(fs, sessions)
  for (const folder of folders) {
    if (folder.kind !== "directory") continue
    const entries = await readdirOrEmpty(fs, join(sessions, folder.name))
    const match = entries.find((entry) => entry.kind === "file" && entry.name.endsWith(`_${thread}.jsonl`))
    if (match !== undefined) return join(sessions, folder.name, match.name)
  }
  return null
}

/** Whether `text` was delivered into the session: its JSON-escaped form appears in the first `maxBytes`. */
export async function transcriptContains(fs: Fs, file: string, text: string, maxBytes: number): Promise<boolean> {
  const { size } = await fs.stat(file)
  const head = new TextDecoder().decode(await fs.readFileRange(file, 0, Math.min(size, maxBytes)))
  return head.includes(JSON.stringify(text).slice(1, -1))
}

/** Whether the newest `message` entry of the session is the assistant's: the idle-plus-tail completion fallback. */
export async function endsWithAssistant(fs: Fs, file: string): Promise<boolean> {
  const { size } = await fs.stat(file)
  const start = Math.max(0, size - TAIL_BYTES)
  const lines = new TextDecoder().decode(await fs.readFileRange(file, start, size - start)).split("\n")
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const role = messageRole(lines[index] ?? "")
    if (role !== null) return role === "assistant"
  }
  return false
}

function messageRole(line: string): string | null {
  let entry: unknown
  try {
    entry = JSON.parse(line)
  } catch (error) {
    if (error instanceof SyntaxError) return null
    throw error
  }
  if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) return null
  return typeof entry.message.role === "string" ? entry.message.role : null
}

async function readdirOrEmpty(fs: Fs, path: string) {
  try {
    return await fs.readdir(path)
  } catch (error) {
    if (error instanceof FsError && error.code === "not_found") return []
    throw error
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
