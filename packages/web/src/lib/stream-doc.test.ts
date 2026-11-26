import { QueryClient } from "@tanstack/react-query"
import { describe, expect, it } from "bun:test"
import { createStreamStore, type StreamEventSource } from "./stream"

class TestEventSource implements StreamEventSource {
  readonly handlers = new Map<string, (event: MessageEvent<string>) => void>()

  addEventListener(type: string, handler: (event: MessageEvent<string>) => void): void {
    this.handlers.set(type, handler)
  }

  close(): void {}

  emit(type: string, value: unknown): void {
    this.handlers.get(type)?.(new MessageEvent(type, { data: JSON.stringify(value) }))
  }
}

describe("document stream listeners", () => {
  it("does not apply subscribed document frames while the view is paused", async () => {
    const source = new TestEventSource()
    const received: unknown[] = []
    let paused = false
    const store = createStreamStore({
      queryClient: new QueryClient(),
      api: {
        subscribeDoc: async () => {},
        unsubscribeDoc: async () => {},
      },
      eventSourceFactory: () => source,
      documentPaused: () => paused,
    })
    const docId = "session:agent:root"
    store.listenDoc(docId, (frame) => received.push(frame))
    await store.subscribeDoc({ docId, epoch: 1, rev: 0 })
    store.start(0)
    source.emit("hello", { streamId: "stream-1" })

    source.emit("doc", {
      docId,
      epoch: 1,
      fromRev: 0,
      toRev: 1,
      ops: [{ op: "error.add", text: "first" }],
    })
    paused = true
    source.emit("doc", {
      docId,
      epoch: 1,
      fromRev: 1,
      toRev: 2,
      ops: [{ op: "error.add", text: "second" }],
    })

    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ ops: [{ text: "first" }] })
    store.close()
  })
})
