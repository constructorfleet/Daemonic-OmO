import { QueryClient } from "@tanstack/react-query"
import { describe, expect, it } from "bun:test"
import type { DocSubscription, Project } from "./api"
import { createStreamStore, type StreamEventSource } from "./stream"

class TestEventSource implements StreamEventSource {
  readonly handlers = new Map<string, (event: MessageEvent<string>) => void>()
  closeCount = 0

  constructor(readonly url: string) {}

  addEventListener(type: string, handler: (event: MessageEvent<string>) => void): void {
    this.handlers.set(type, handler)
  }

  close(): void {
    this.closeCount += 1
  }

  emit(type: string, data: unknown): void {
    this.handlers.get(type)?.(new MessageEvent(type, { data: JSON.stringify(data) }))
  }
}

function project(name = "before"): Project {
  return {
    id: "project-1",
    userId: "user-1",
    name,
    cwd: "/tmp/demo",
    agentDir: "/tmp/agent",
    stateDir: "/tmp/agent/projects/demo",
    settings: { fullAccessOptIn: false, maxRunning: 1, worktreeForAdhoc: false },
    state: "active",
    revision: name === "before" ? 1 : 2,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }
}

function frame(seq: number, value: Project) {
  return {
    schemaVersion: 1,
    seq,
    at: "2026-01-01T00:00:00.000Z",
    type: "project.upserted",
    entity: { kind: "project", id: value.id, revision: value.revision },
    projectId: value.id,
    data: value,
  }
}

function setup() {
  const queryClient = new QueryClient()
  queryClient.setQueryData(["projects"], { items: [project()], headSeq: 4 })
  const sources: TestEventSource[] = []
  const subscriptions: { readonly streamId: string; readonly subscription: DocSubscription }[] = []
  const store = createStreamStore({
    queryClient,
    api: {
      subscribeDoc: async (streamId, subscription) => {
        subscriptions.push({ streamId, subscription })
      },
      unsubscribeDoc: async () => {},
    },
    eventSourceFactory: (url) => {
      const source = new TestEventSource(url)
      sources.push(source)
      return source
    },
  })
  return { queryClient, sources, subscriptions, store }
}

describe("project event stream", () => {
  it("applies task document snapshots and deltas to the query cache", () => {
    const { queryClient, sources, store } = setup()
    const docId = "project:project-1:tasks"
    store.start(4)
    const source = sources[0]

    source?.emit("doc", {
      docId,
      epoch: 7,
      fromRev: 0,
      toRev: 0,
      ops: [{ op: "snapshot", items: [], invalidRecords: 0, agentDirHash: "agent-hash" }],
    })
    source?.emit("doc", {
      docId,
      epoch: 7,
      fromRev: 0,
      toRev: 1,
      ops: [{
        op: "task.upsert",
        index: 0,
        item: {
          id: "qa-task-1",
          kind: "task",
          rootSessionId: "root-session",
          depth: 1,
          task: { task_id: "qa-task-1", parent_session_id: "root-session", root_session_id: "root-session", status: "running", created_at: "2026-11-25T08:00:00.000Z" },
        },
      }],
    })

    expect(queryClient.getQueryData<{
      readonly rev: number
      readonly snapshot: { readonly items: readonly { readonly id: string }[] }
    }>(["docs", docId])).toMatchObject({
      rev: 1,
      snapshot: { items: [{ id: "qa-task-1" }] },
    })
    expect(store.cursor).toBe(4)
    store.close()
  })

  it("invalidates project runs when a run state event arrives", () => {
    const { queryClient, sources, store } = setup()
    queryClient.setQueryData(["project-runs", "project-1"], [{ id: "run-1", state: "queued" }])
    store.start(4)

    sources[0]?.emit("entity", {
      schemaVersion: 1,
      seq: 5,
      at: "2026-11-25T08:00:00.000Z",
      type: "run.state_changed",
      entity: { kind: "run", id: "run-1", revision: 2 },
      projectId: "project-1",
      data: { id: "run-1", projectId: "project-1", state: "active" },
    })

    expect(queryClient.getQueryState(["project-runs", "project-1"])?.isInvalidated).toBe(true)
    store.close()
  })

  it("applies contiguous project events to the query cache", () => {
    const { queryClient, sources, store } = setup()
    store.start(4)

    sources[0]?.emit("entity", frame(5, project("after")))

    expect(queryClient.getQueryData<{ readonly items: readonly Project[] }>(["projects"])?.items[0]?.name)
      .toBe("after")
    expect(store.cursor).toBe(5)
    store.close()
  })

  it("reconnects from the last contiguous cursor after a gap", () => {
    const { sources, store } = setup()
    store.start(4)
    sources[0]?.emit("entity", frame(6, project("after-gap")))

    expect(sources[0]?.closeCount).toBe(1)
    expect(sources[1]?.url).toBe("/api/v1/stream?since=4")
    store.close()
  })

  it("invalidates cached queries and reconnects from the reset head", () => {
    const { queryClient, sources, store } = setup()
    store.start(4)
    sources[0]?.emit("reset", { reason: "cursor_expired", headSeq: 12 })

    expect(queryClient.getQueryState(["projects"])?.isInvalidated).toBe(true)
    expect(sources[0]?.closeCount).toBe(1)
    expect(sources[1]?.url).toBe("/api/v1/stream?since=12")
    expect(store.cursor).toBe(12)
    store.close()
  })

  it("re-sends document subscriptions with their epoch and revision after reconnect", async () => {
    const { sources, subscriptions, store } = setup()
    const first = { docId: "doc-1", epoch: 2, rev: 7 }
    const second = { docId: "doc-2", epoch: 3, rev: 8 }
    const third = { docId: "doc-3", epoch: 4, rev: 9 }
    await store.subscribeDoc(first)
    store.start(4)
    sources[0]?.emit("hello", { streamId: "stream-1", headSeq: 4, incarnation: "one" })
    sources[0]?.emit("entity", frame(6, project("after-gap")))
    await store.subscribeDoc(second)
    sources[1]?.emit("hello", { streamId: "stream-2", headSeq: 6, incarnation: "one" })
    sources[1]?.emit("error", null)
    await store.subscribeDoc(third)
    sources[1]?.emit("hello", { streamId: "stream-3", headSeq: 6, incarnation: "one" })

    expect(subscriptions).toEqual([
      { streamId: "stream-1", subscription: first },
      { streamId: "stream-2", subscription: first },
      { streamId: "stream-2", subscription: second },
      { streamId: "stream-3", subscription: first },
      { streamId: "stream-3", subscription: second },
      { streamId: "stream-3", subscription: third },
    ])
    store.close()
  })
})
