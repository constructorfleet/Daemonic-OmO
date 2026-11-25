import type { Database } from "bun:sqlite"
import type { UserScope } from "../auth"
import type { DaemonEvent, JsonObject } from "../core/types"
import type { EventLedger } from "../db/ledger"

export interface ListPage<T> {
  readonly items: readonly T[]
  readonly nextCursor?: string
}

export interface ListBody<T> extends ListPage<T> {
  readonly headSeq: number
}

type CursorRow = { readonly cursor: number | null }

/**
 * Reads the event ledger through a subscriber's cursor: the global `seq` for
 * an all-users (admin) scope, the per-user `user_seq` for a single user.
 * Every cursor a client sees (SSE ids, list headSeq, /events) comes from here.
 */
export function createEventFeed(db: Database, ledger: EventLedger) {
  const userHead = db.query<CursorRow, [string]>(
    "SELECT user_seq AS cursor FROM user_event_heads WHERE user_id = ?",
  )
  const oldestGlobal = db.query<CursorRow, []>("SELECT MIN(seq) AS cursor FROM events")
  const oldestUser = db.query<CursorRow, [string]>(
    "SELECT MIN(user_seq) AS cursor FROM events WHERE user_id = ?",
  )
  const firstUserSeq = db.query<CursorRow, [string, number]>(
    "SELECT seq AS cursor FROM events WHERE user_id = ? AND user_seq > ? ORDER BY user_seq LIMIT 1",
  )

  function cursorOf(scope: UserScope, event: DaemonEvent): number {
    return scope.kind === "all" ? event.seq : event.userSeq
  }

  function head(scope: UserScope): number {
    return scope.kind === "all" ? ledger.headSeq() : userHead.get(scope.userId)?.cursor ?? 0
  }

  return {
    cursorOf,
    head,

    includes(scope: UserScope, event: DaemonEvent): boolean {
      return scope.kind === "all" || event.userId === scope.userId
    },

    oldest(scope: UserScope): number | null {
      const row = scope.kind === "all" ? oldestGlobal.get() : oldestUser.get(scope.userId)
      return row?.cursor ?? null
    },

    /** Events with `after < cursor <= upTo`, oldest first, at most `limit` of them. */
    page(scope: UserScope, after: number, upTo: number, limit: number): readonly DaemonEvent[] {
      if (scope.kind === "all") return ledger.readAfter(after, limit).filter((event) => event.seq <= upTo)
      const first = firstUserSeq.get(scope.userId, after)?.cursor ?? null
      if (first === null) return []
      return ledger.readAfter(first - 1, limit)
        .filter((event) => event.userId === scope.userId && event.userSeq <= upTo)
    },

    /** A list body whose headSeq is read in the same transaction as its items. */
    list<T>(scope: UserScope, read: () => ListPage<T>): ListBody<T> {
      return db.transaction(() => ({ ...read(), headSeq: head(scope) }))()
    },

    payload(scope: UserScope, event: DaemonEvent): JsonObject {
      const revision = event.data.revision
      return {
        schemaVersion: 1,
        seq: cursorOf(scope, event),
        at: event.at,
        type: event.type,
        entity: {
          kind: event.entityKind,
          id: event.entityId,
          ...(typeof revision === "number" ? { revision } : {}),
        },
        projectId: event.projectId,
        data: event.data,
      }
    },
  }
}

export type EventFeed = ReturnType<typeof createEventFeed>
