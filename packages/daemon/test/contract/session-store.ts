import { createHash } from "node:crypto"
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, watch } from "node:fs"
import { basename, join } from "node:path"

import { ContractError, isRecord, parseJson } from "./harness"

export type SessionEntry = Readonly<Record<string, unknown>>

export interface Delivery {
  readonly deliveryId: unknown
  readonly content: unknown
  readonly sender: unknown
}

export interface ConditionWatch<T> {
  until(timeoutMs: number): Promise<T>
  close(): void
}

export function sessionFolderName(cwd: string): string {
  return `--${cwd.replace(/^\//, "").replaceAll("/", "-")}--`
}

export function findSessionFile(agentDir: string, thread: string): string | undefined {
  const sessions = join(agentDir, "sessions")
  if (!existsSync(sessions)) return undefined
  const matches = readdirSync(sessions)
    .map((folder) => join(sessions, folder))
    .filter((dir) => statSync(dir).isDirectory())
    .flatMap((dir) => readdirSync(dir).filter((file) => file.endsWith(`_${thread}.jsonl`)).map((file) => join(dir, file)))
  if (matches.length > 1) throw new ContractError(`thread ${thread} has several session files`, matches)
  return matches[0]
}

export function sessionFileOf(agentDir: string, thread: string): string {
  const file = findSessionFile(agentDir, thread)
  if (file === undefined) throw new ContractError(`no session file for thread ${thread}`)
  return file
}

/** Reads complete JSONL entries; a trailing line still being appended is skipped, not an error. */
export function readSessionEntries(path: string): readonly SessionEntry[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => parseJson(line))
    .filter((entry): entry is SessionEntry => isRecord(entry))
}

export function deliveryMessages(entries: readonly SessionEntry[]): readonly Delivery[] {
  return entries
    .filter((entry) => entry.type === "custom_message" && entry.customType === "session_control_delivery")
    .map((entry) => {
      const details = isRecord(entry.details) ? entry.details : {}
      return { deliveryId: details.delivery_id, content: entry.content, sender: details.sender }
    })
}

export function assistantTexts(entries: readonly SessionEntry[]): readonly string[] {
  return entries.flatMap((entry) => {
    const message = isRecord(entry.message) ? entry.message : null
    if (entry.type !== "message" || message?.role !== "assistant" || !Array.isArray(message.content)) return []
    return [message.content.map((part: unknown) => (isRecord(part) && typeof part.text === "string" ? part.text : "")).join("")]
  })
}

export function permissionMode(entries: readonly SessionEntry[]): unknown {
  return entries.find((entry) => entry.type === "custom" && entry.customType === "permission_mode")?.data
}

/** senpi-task's store path: `<agentDir>/projects/<basename>-<sha256(realpath)[:12]>/senpi-task`. */
export function expectedTaskStateDir(agentDir: string, cwd: string): string {
  const project = realpathSync.native(cwd)
  const name = basename(project).replace(/[^\p{L}\p{N}._-]/gu, "_") || "root"
  const hash = createHash("sha256").update(project).digest("hex").slice(0, 12)
  return join(agentDir, "projects", `${name}-${hash}`, "senpi-task")
}

export function findTaskRecord(stateDir: string, parentSessionId: string): Readonly<Record<string, unknown>> | undefined {
  const tasks = join(stateDir, "tasks")
  if (!existsSync(tasks)) return undefined
  return readdirSync(tasks)
    .filter((file) => file.endsWith(".json"))
    .map((file) => parseJson(readFileSync(join(tasks, file), "utf8")))
    .find((record): record is Record<string, unknown> => isRecord(record) && record.parent_session_id === parentSessionId)
}

export function readOutboxMarker(agentDir: string): Readonly<Record<string, unknown>> | undefined {
  const path = join(agentDir, "gateway", "outbox.marker")
  if (!existsSync(path)) return undefined
  const marker = parseJson(readFileSync(path, "utf8"))
  return isRecord(marker) ? marker : undefined
}

export function readPidFile(path: string): number | undefined {
  if (!existsSync(path)) return undefined
  const text = readFileSync(path, "utf8").trim()
  return /^\d+$/.test(text) ? Number(text) : undefined
}

/** Registers a recursive fs.watch now; `until` re-checks on every event and rejects at the deadline. */
export function watchUntil<T>(dir: string, check: () => T | undefined): ConditionWatch<T> {
  let resolveHit: (value: T) => void = () => undefined
  const hit = new Promise<T>((resolve) => {
    resolveHit = resolve
  })
  const watcher = watch(dir, { recursive: true }, () => {
    const value = check()
    if (value !== undefined) resolveHit(value)
  })
  return {
    async until(timeoutMs) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ContractError(`nothing under ${dir} satisfied the condition within ${timeoutMs} ms`)), timeoutMs)
      })
      try {
        const now = check()
        return now !== undefined ? now : await Promise.race([hit, deadline])
      } finally {
        clearTimeout(timer)
        watcher.close()
      }
    },
    close: () => watcher.close(),
  }
}
