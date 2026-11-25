import type { QueryClient } from "@tanstack/react-query"
import { isRecord } from "./api-model-primitives"
import { parseProjectTaskDocument, parseProjectTaskItem } from "./project-activity-model"
import type { ProjectTaskDocument } from "./project-activity-model"

export type ProjectTaskDocumentFrame = {
  readonly docId: string
  readonly epoch: number
  readonly fromRev: number
  readonly toRev: number
  readonly ops: readonly Record<string, unknown>[]
}

export function projectTaskDocumentQueryKey(docId: string): readonly ["docs", string] {
  return ["docs", docId]
}

export function parseProjectTaskDocumentFrame(value: unknown): ProjectTaskDocumentFrame | null {
  if (!isRecord(value) || typeof value["docId"] !== "string" || !Array.isArray(value["ops"])) return null
  const { epoch, fromRev, toRev } = value
  if (
    typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 0
    || typeof fromRev !== "number" || !Number.isSafeInteger(fromRev) || fromRev < 0
    || typeof toRev !== "number" || !Number.isSafeInteger(toRev) || toRev < fromRev
    || !value["ops"].every(isRecord)
  ) return null
  return { docId: value["docId"], epoch, fromRev, toRev, ops: value["ops"] }
}

export function applyProjectTaskDocumentFrame(queryClient: QueryClient, frame: ProjectTaskDocumentFrame): boolean {
  if (!frame.docId.startsWith("project:") || !frame.docId.endsWith(":tasks")) return true
  const key = projectTaskDocumentQueryKey(frame.docId)
  const snapshotOp = frame.ops.find((op) => op["op"] === "snapshot")
  if (snapshotOp !== undefined) {
    const { op: _op, ...snapshot } = snapshotOp
    let document: ProjectTaskDocument
    try {
      document = parseProjectTaskDocument({
        docId: frame.docId,
        epoch: frame.epoch,
        rev: frame.toRev,
        snapshot,
      })
    } catch (error) {
      if (!(error instanceof TypeError)) throw error
      queryClient.invalidateQueries({ queryKey: key })
      return false
    }
    queryClient.setQueryData<ProjectTaskDocument>(key, document)
    return true
  }

  const current = queryClient.getQueryData<ProjectTaskDocument>(key)
  if (current === undefined || current.epoch !== frame.epoch || current.rev !== frame.fromRev) {
    queryClient.invalidateQueries({ queryKey: key })
    return false
  }

  const next = [...current.snapshot.items]
  const positions = new Map(next.map((item, index) => [item.id, index]))
  const reindex = (start: number): void => {
    for (let index = start; index < next.length; index += 1) {
      const item = next[index]
      if (item !== undefined) positions.set(item.id, index)
    }
  }

  for (const op of frame.ops) {
    if (op["op"] === "task.upsert") {
      let item: ReturnType<typeof parseProjectTaskItem>
      try {
        item = parseProjectTaskItem(op["item"])
      } catch (error) {
        if (error instanceof TypeError) {
          queryClient.invalidateQueries({ queryKey: key })
          return false
        }
        throw error
      }
      const index = op["index"]
      if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index > next.length) {
        queryClient.invalidateQueries({ queryKey: key })
        return false
      }
      const existing = positions.get(item.id)
      const reindexFrom = existing === undefined ? index : Math.min(index, existing)
      if (existing !== undefined) {
        next.splice(existing, 1)
        positions.delete(item.id)
      }
      next.splice(index, 0, item)
      reindex(reindexFrom)
    } else if (op["op"] === "task.remove" && typeof op["id"] === "string") {
      const index = positions.get(op["id"])
      if (index !== undefined) {
        next.splice(index, 1)
        positions.delete(op["id"])
        reindex(index)
      }
    } else {
      queryClient.invalidateQueries({ queryKey: key })
      return false
    }
  }

  queryClient.setQueryData<ProjectTaskDocument>(key, {
    ...current,
    rev: frame.toRev,
    snapshot: { ...current.snapshot, items: next },
  })
  return true
}
