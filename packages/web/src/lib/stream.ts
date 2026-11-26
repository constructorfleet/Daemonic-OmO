import type { QueryClient } from "@tanstack/react-query"
import { isRecord, parseProject } from "./api-model"
import type { DocSubscription, Project, ProjectListItem } from "./api-model"
import { applyProjectTaskDocumentFrame, parseProjectTaskDocumentFrame } from "./project-task-stream"

export const PROJECTS_QUERY_KEY = ["projects"] as const

export interface StreamEventSource {
  addEventListener(type: string, handler: (event: MessageEvent<string>) => void): void
  close(): void
}

export interface StreamApi {
  subscribeDoc(streamId: string, subscription: DocSubscription): Promise<void>
  unsubscribeDoc(streamId: string, docId: string): Promise<void>
}

export interface StreamStoreOptions {
  readonly queryClient: QueryClient
  readonly api: StreamApi
  readonly eventSourceFactory?: (url: string) => StreamEventSource
  readonly documentPaused?: () => boolean
}

export type DocumentFrameListener = (frame: unknown) => void

type ProjectListResponse = {
  readonly items: readonly ProjectListItem[]
  readonly headSeq: number
}

type EntityFrame = {
  readonly seq: number
  readonly type: string
  readonly projectId?: string
  readonly entity: {
    readonly kind: string
    readonly id: string
  }
  readonly data: Record<string, unknown>
}

type HelloFrame = {
  readonly streamId: string
}

type ResetFrame = {
  readonly headSeq: number
}

function parseEventData(event: MessageEvent<string>): unknown {
  try {
    const data: unknown = JSON.parse(event.data)
    return data
  } catch (error) {
    if (error instanceof SyntaxError) return null
    throw error
  }
}

function parseEntity(event: MessageEvent<string>): EntityFrame | null {
  const data = parseEventData(event)
  if (!isRecord(data) || data["schemaVersion"] !== 1 || !isRecord(data["entity"]) || !isRecord(data["data"])) {
    return null
  }
  const seq = data["seq"]
  const kind = data["entity"]["kind"]
  const id = data["entity"]["id"]
  const type = data["type"]
  const projectId = typeof data["projectId"] === "string" ? data["projectId"] : undefined
  if (
    typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0
    || typeof kind !== "string" || typeof id !== "string" || typeof type !== "string"
  ) {
    return null
  }
  return { seq, type, ...(projectId === undefined ? {} : { projectId }), entity: { kind, id }, data: data["data"] }
}

function parseHello(event: MessageEvent<string>): HelloFrame | null {
  const data = parseEventData(event)
  if (!isRecord(data) || typeof data["streamId"] !== "string") return null
  return { streamId: data["streamId"] }
}

function parseReset(event: MessageEvent<string>): ResetFrame | null {
  const data = parseEventData(event)
  if (!isRecord(data)) return null
  const headSeq = data["headSeq"]
  if (typeof headSeq !== "number" || !Number.isSafeInteger(headSeq) || headSeq < 0) return null
  return { headSeq }
}

function upsertProject(queryClient: QueryClient, project: Project, cursor: number): void {
  queryClient.setQueryData<Project>(["project", project.id], project)
  queryClient.setQueryData<ProjectListResponse>(PROJECTS_QUERY_KEY, (current) => {
    if (current === undefined) return current
    const items = current.items.filter((item) =>
      "registered" in item ? item.cwd !== project.cwd : item.id !== project.id)
    return { items: [project, ...items], headSeq: cursor }
  })
}

function applyEntity(queryClient: QueryClient, frame: EntityFrame): void {
  queryClient.setQueryData(["entities", frame.entity.kind, frame.entity.id], frame.data)
  if (frame.entity.kind === "run" && frame.projectId !== undefined) {
    queryClient.invalidateQueries({ queryKey: ["project-runs", frame.projectId] })
  }
  if (frame.entity.kind !== "project") return
  if (frame.type === "project.upserted") {
    upsertProject(queryClient, parseProject(frame.data), frame.seq)
  } else if (frame.type === "project.deleted") {
    queryClient.removeQueries({ queryKey: ["project", frame.entity.id] })
    queryClient.setQueryData<ProjectListResponse>(PROJECTS_QUERY_KEY, (current) => {
      if (current === undefined) return current
      return {
        items: current.items.filter((item) => "registered" in item || item.id !== frame.entity.id),
        headSeq: frame.seq,
      }
    })
  }
}

export function createStreamStore(options: StreamStoreOptions) {
  const eventSourceFactory = options.eventSourceFactory ?? ((url: string) => new EventSource(url))
  const documents = new Map<string, DocSubscription>()
  const documentListeners = new Map<string, Set<DocumentFrameListener>>()
  let source: StreamEventSource | null = null
  let streamId: string | null = null
  let cursor = 0

  function closeSource(): void {
    const current = source
    source = null
    streamId = null
    current?.close()
  }

  function connect(): void {
    const current = eventSourceFactory(`/api/v1/stream?since=${cursor}`)
    source = current
    current.addEventListener("error", () => {
      if (source === current) streamId = null
    })
    current.addEventListener("hello", (event) => {
      if (source !== current) return
      const hello = parseHello(event)
      if (hello === null) return
      streamId = hello.streamId
      for (const subscription of documents.values()) {
        void options.api.subscribeDoc(streamId, subscription)
      }
    })
    current.addEventListener("entity", (event) => {
      if (source !== current) return
      const frame = parseEntity(event)
      if (frame === null) {
        options.queryClient.invalidateQueries()
        closeSource()
        connect()
        return
      }
      if (frame.seq <= cursor) return
      if (frame.seq !== cursor + 1) {
        closeSource()
        connect()
        return
      }
      applyEntity(options.queryClient, frame)
      cursor = frame.seq
    })
    current.addEventListener("doc", (event) => {
      if (source !== current) return
      if (options.documentPaused?.() === true) return
      const data = parseEventData(event)
      const docId = isRecord(data) && typeof data["docId"] === "string" ? data["docId"] : undefined
      if (docId !== undefined) {
        for (const listener of documentListeners.get(docId) ?? []) listener(data)
      }
      const frame = parseProjectTaskDocumentFrame(data)
      if (frame === null) {
        if (docId === undefined) options.queryClient.invalidateQueries()
        else if (docId.startsWith("project:") && docId.endsWith(":tasks")) {
          options.queryClient.invalidateQueries({ queryKey: ["docs", docId] })
        }
        return
      }
      if (!applyProjectTaskDocumentFrame(options.queryClient, frame)) return
      const subscription = documents.get(frame.docId)
      if (subscription !== undefined) {
        documents.set(frame.docId, { docId: frame.docId, epoch: frame.epoch, rev: frame.toRev })
      }
    })
    current.addEventListener("reset", (event) => {
      if (source !== current) return
      const reset = parseReset(event)
      if (reset === null) {
        options.queryClient.invalidateQueries()
        closeSource()
        connect()
        return
      }
      options.queryClient.invalidateQueries()
      cursor = reset.headSeq
      closeSource()
      connect()
    })
  }

  return {
    get cursor(): number {
      return cursor
    },

    start(initialCursor: number): void {
      if (source !== null) return
      cursor = initialCursor
      connect()
    },

    async subscribeDoc(subscription: DocSubscription): Promise<void> {
      const current = documents.get(subscription.docId)
      if (
        current !== undefined
        && current.epoch === subscription.epoch
        && current.rev === subscription.rev
      ) return
      documents.set(subscription.docId, subscription)
      if (streamId !== null) await options.api.subscribeDoc(streamId, subscription)
    },

    listenDoc(docId: string, listener: DocumentFrameListener): () => void {
      const listeners = documentListeners.get(docId) ?? new Set<DocumentFrameListener>()
      listeners.add(listener)
      documentListeners.set(docId, listeners)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) documentListeners.delete(docId)
      }
    },

    async unsubscribeDoc(docId: string): Promise<void> {
      documents.delete(docId)
      if (streamId !== null) await options.api.unsubscribeDoc(streamId, docId)
    },

    close(): void {
      closeSource()
    },
  }
}
