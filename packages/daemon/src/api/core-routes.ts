import { scopeFor, type UserScope } from "../auth"
import { isPlainObject } from "../config/reader"
import type { JsonObject } from "../core/types"
import { parseJsonObject } from "../db/repos/json"
import type { FeatureContext } from "./context"
import { ApiError } from "./errors"
import { json, userRoute, type Route } from "./routes"
import type { StreamHub } from "./sse"

/** The omo compatibility probe stores its CompatReport JSON under this meta key; /health returns it. */
export const OMO_COMPAT_META_KEY = "omo.compat"
const EVENTS_DEFAULT_LIMIT = 100
const EVENTS_MAX_LIMIT = 1_000

export interface CoreRouteDeps {
  readonly ctx: FeatureContext
  readonly hub: StreamHub
  readonly version: string
  readonly incarnation: string
}

function cursorParam(name: string, value: string | null): number | null {
  if (value === null || value.length === 0) return null
  const parsed = /^\d+$/.test(value) ? Number(value) : Number.NaN
  if (!Number.isSafeInteger(parsed)) throw new ApiError("invalid_arguments", `${name} must be a non-negative integer`)
  return parsed
}

function optionalCount(body: Record<string, unknown>, key: string): number | null {
  const value = body[key]
  if (value === undefined) return null
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value
  throw new ApiError("invalid_arguments", `${key} must be a non-negative integer`)
}

function scopeOf(url: URL, user: Parameters<typeof scopeFor>[0]): UserScope {
  return scopeFor(user, url.searchParams.get("userId"))
}

export function coreRoutes({ ctx, hub, version, incarnation }: CoreRouteDeps): readonly Route[] {
  const { feed } = ctx
  const compat = ctx.db.query<{ readonly value: string }, [string]>("SELECT value FROM meta WHERE key = ?")
  const omoReport = (): JsonObject | null => {
    const row = compat.get(OMO_COMPAT_META_KEY)
    return row === null ? null : parseJsonObject(row.value, OMO_COMPAT_META_KEY)
  }

  return [
    userRoute(ctx, {
      method: "GET",
      path: "/api/v1/health",
      handle: ({ principal, url }) => json({
        version,
        incarnation,
        headSeq: feed.head(scopeOf(url, principal.user)),
        omo: omoReport(),
      }),
    }),

    userRoute(ctx, {
      method: "GET",
      path: "/api/v1/events",
      handle: ({ principal, url }) => {
        const scope = scopeOf(url, principal.user)
        const since = cursorParam("since", url.searchParams.get("since")) ?? 0
        const limit = cursorParam("limit", url.searchParams.get("limit")) ?? EVENTS_DEFAULT_LIMIT
        if (limit < 1 || limit > EVENTS_MAX_LIMIT) {
          throw new ApiError("invalid_arguments", `limit must be between 1 and ${EVENTS_MAX_LIMIT}`)
        }
        const headSeq = feed.head(scope)
        const oldest = feed.oldest(scope)
        if (since < headSeq && (oldest === null || oldest > since + 1)) {
          throw new ApiError("state_conflict", "cursor is older than the retained events", { reason: "cursor_expired", headSeq })
        }
        const events = feed.page(scope, since, headSeq, limit)
        const last = events.at(-1)
        const nextSince = last === undefined ? since : feed.cursorOf(scope, last)
        return json({
          events: events.map((event) => feed.payload(scope, event)),
          nextSince,
          headSeq,
          hasMore: nextSince < headSeq,
        })
      },
    }),

    userRoute(ctx, {
      method: "GET",
      path: "/api/v1/stream",
      handle: ({ principal, request, url }) => {
        const since = cursorParam("Last-Event-ID", request.headers.get("last-event-id"))
          ?? cursorParam("since", url.searchParams.get("since"))
        const { stream } = hub.open({ user: principal.user, scope: scopeOf(url, principal.user), since })
        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-store",
            "x-accel-buffering": "no",
          },
        })
      },
    }),

    userRoute(ctx, {
      method: "POST",
      path: "/api/v1/stream/:streamId/docs",
      handle: ({ principal, params, body }) => {
        if (!isPlainObject(body) || typeof body.docId !== "string" || body.docId.length === 0) {
          throw new ApiError("invalid_arguments", "body must be {docId, epoch?, rev?}")
        }
        const subscription = { docId: body.docId, epoch: optionalCount(body, "epoch"), rev: optionalCount(body, "rev") }
        hub.subscribeDoc(principal.user, params.streamId ?? "", subscription)
        return json({ docId: subscription.docId, subscribed: true })
      },
    }),

    userRoute(ctx, {
      method: "DELETE",
      path: "/api/v1/stream/:streamId/docs/:docId",
      handle: ({ principal, params }) => {
        hub.unsubscribeDoc(principal.user, params.streamId ?? "", params.docId ?? "")
        return new Response(null, { status: 204 })
      },
    }),
  ]
}
