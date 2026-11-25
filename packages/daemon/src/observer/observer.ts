import type { DocProvider } from "../api/services"
import type { TimerHandle } from "../core/ports"
import type { User, UserId } from "../core/types"
import { DocStream } from "./doc-stream"
import { openDoc, type DocFactoryDeps, type OpenedDoc } from "./doc-factory"
import type { StoredImage } from "./images"
import type { TranscriptDoc, TurnBody } from "./transcript-doc"

interface Entry {
  readonly owner: UserId
  readonly opened: OpenedDoc
  readonly stream: DocStream
  touchedAt: number
  nextPollAt: number
}

export interface DocView {
  readonly docId: string
  readonly epoch: number
  readonly rev: number
  readonly snapshot: unknown
}

/**
 * The open documents of every user, keyed by owner so one user's documents
 * and images are never served to another. Documents are polled through the
 * injected Clock (fast while subscribed or running, slow otherwise) and the
 * least recently used idle ones are evicted.
 */
export function createObserver(deps: DocFactoryDeps) {
  const limits = deps.config.limits
  const entries = new Map<string, Entry>()
  let epochSeed = deps.clock.now()
  let timer: TimerHandle | null = null
  const nextEpoch = (): number => {
    epochSeed += 1
    return epochSeed
  }

  const interval = (entry: Entry): number =>
    entry.stream.subscribers > 0 || entry.opened.active() ? limits.observerActivePollMs : limits.observerIdlePollMs

  const idle = (entry: Entry): boolean => entry.stream.subscribers === 0 && !entry.opened.active()

  function evict(now: number): void {
    for (const [key, entry] of entries) {
      if (idle(entry) && now - entry.touchedAt >= limits.observerIdleEvictMs) entries.delete(key)
    }
    for (const [key, entry] of entries) {
      if (entries.size <= limits.observerMaxOpenDocs) break
      if (idle(entry)) entries.delete(key)
    }
  }

  function arm(): void {
    if (timer !== null || entries.size === 0) return
    timer = deps.clock.setTimer(deps.clock.now() + limits.observerActivePollMs, tick)
  }

  function tick(): void {
    timer = null
    const now = deps.clock.now()
    for (const entry of [...entries.values()]) {
      if (entry.nextPollAt > now) continue
      entry.stream.refresh()
      entry.nextPollAt = now + interval(entry)
    }
    evict(now)
    arm()
  }

  function entryFor(user: User, docId: string): Entry | null {
    const key = `${user.id} ${docId}`
    const now = deps.clock.now()
    const existing = entries.get(key)
    if (existing !== undefined) {
      entries.delete(key)
      entries.set(key, existing)
      existing.touchedAt = now
      existing.stream.refresh()
      return existing
    }
    const opened = openDoc(deps, user, docId)
    if (opened === null) return null
    const entry: Entry = { owner: user.id, opened, stream: new DocStream(docId, opened.stream, nextEpoch), touchedAt: now, nextPollAt: now }
    entry.nextPollAt = now + interval(entry)
    entries.set(key, entry)
    evict(now)
    arm()
    return entry
  }

  function transcriptFor(user: User, docId: string): TranscriptDoc | null {
    return entryFor(user, docId)?.opened.transcript ?? null
  }

  const provider: DocProvider = {
    open(request, emit) {
      const entry = entryFor(request.user, request.docId)
      if (entry === null) return null
      const unsubscribe = entry.stream.subscribe(emit, request.epoch, request.rev)
      entry.nextPollAt = Math.min(entry.nextPollAt, deps.clock.now() + limits.observerActivePollMs)
      return () => {
        unsubscribe()
        entry.touchedAt = deps.clock.now()
      }
    },
  }

  return {
    provider,
    snapshot(user: User, docId: string, limit: number): DocView | null {
      const entry = entryFor(user, docId)
      if (entry === null) return null
      const snapshot = entry.opened.transcript?.snapshot(limit) ?? entry.opened.stream.snapshot()
      return { docId, epoch: entry.stream.epoch, rev: entry.stream.rev, snapshot }
    },
    transcript: transcriptFor,
    turnBody(user: User, docId: string, turnId: string): TurnBody | undefined {
      return transcriptFor(user, docId)?.turnBody(turnId)
    },
    image(user: User, docId: string, sha256: string): StoredImage | undefined {
      return transcriptFor(user, docId)?.image(sha256)
    },
  }
}

export type Observer = ReturnType<typeof createObserver>
