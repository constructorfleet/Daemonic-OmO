import type { UserScope } from "../auth"
import { ulid } from "../core/ids"
import type { Clock, Rng } from "../core/ports"
import type { User, UserId } from "../core/types"
import type { EventLedger } from "../db/ledger"
import { ApiError } from "./errors"
import type { EventFeed } from "./feed"
import { DOC_PROVIDER, type Services } from "./services"
import { StreamSubscriber } from "./stream-subscriber"

export interface StreamHubDeps {
  readonly feed: EventFeed
  readonly ledger: EventLedger
  readonly clock: Clock
  readonly rng: Rng
  readonly services: Services
  readonly maxFrames: number
  readonly maxBytes: number
  readonly incarnation: string
}

export interface OpenStream {
  readonly user: User
  readonly scope: UserScope
  readonly since: number | null
}

export interface DocSubscription {
  readonly docId: string
  readonly epoch: number | null
  readonly rev: number | null
}

interface Entry {
  readonly owner: UserId
  readonly subscriber: StreamSubscriber
}

export function createStreamHub(deps: StreamHubDeps) {
  const streams = new Map<string, Entry>()

  function owned(user: User, streamId: string): StreamSubscriber {
    const entry = streams.get(streamId)
    if (entry === undefined || entry.owner !== user.id) throw new ApiError("not_found", "stream not found")
    return entry.subscriber
  }

  return {
    open(request: OpenStream): { readonly streamId: string; readonly stream: ReadableStream<Uint8Array> } {
      const streamId = ulid(deps.rng, deps.clock.now())
      const subscriber = new StreamSubscriber(deps, {
        streamId,
        scope: request.scope,
        since: request.since,
        onRelease: () => streams.delete(streamId),
      })
      if (!subscriber.released) streams.set(streamId, { owner: request.user.id, subscriber })
      return { streamId, stream: subscriber.stream }
    },

    subscribeDoc(user: User, streamId: string, subscription: DocSubscription): void {
      const subscriber = owned(user, streamId)
      const provider = deps.services.get(DOC_PROVIDER)
      const unsubscribe = provider?.open(
        { user, docId: subscription.docId, epoch: subscription.epoch, rev: subscription.rev },
        (frame) => subscriber.pushDoc(frame),
      ) ?? null
      if (unsubscribe === null) throw new ApiError("not_found", "document not found", { docId: subscription.docId })
      subscriber.addDoc(subscription.docId, unsubscribe)
    },

    unsubscribeDoc(user: User, streamId: string, docId: string): void {
      if (!owned(user, streamId).removeDoc(docId)) {
        throw new ApiError("not_found", "document subscription not found", { docId })
      }
    },

    closeAll(): void {
      for (const { subscriber } of [...streams.values()]) subscriber.close()
    },
  }
}

export type StreamHub = ReturnType<typeof createStreamHub>
