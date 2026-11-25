import { ApiError } from "../api/errors"
import { json, userRoute, type Route, type UserRouteDeps } from "../api/routes"
import type { Observer } from "./observer"

const DEFAULT_LIMIT = 50
const SHA256 = /^[0-9a-f]{64}$/

function limitParam(url: URL, maxLimit: number): number {
  const raw = url.searchParams.get("limit")
  if (raw === null || raw === "") return DEFAULT_LIMIT
  const limit = /^\d+$/.test(raw) ? Number(raw) : Number.NaN
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxLimit) {
    throw new ApiError("invalid_arguments", `limit must be between 1 and ${maxLimit}`)
  }
  return limit
}

function documentNotFound(docId: string): ApiError {
  return new ApiError("not_found", "document not found", { docId })
}

/** Read-only document routes; every lookup is scoped to the authenticated user, so another user's document is a 404. */
export function observerRoutes(deps: UserRouteDeps, observer: Observer, pageMaxTurns: number): readonly Route[] {
  return [
    userRoute(deps, {
      method: "GET",
      path: "/api/v1/docs/:docId",
      handle: ({ principal, url, params }) => {
        const docId = params.docId ?? ""
        const limit = limitParam(url, pageMaxTurns)
        const beforeTurn = url.searchParams.get("beforeTurn")
        if (beforeTurn === null) {
          const view = observer.snapshot(principal.user, docId, limit)
          if (view === null) throw documentNotFound(docId)
          return json(view)
        }
        const transcript = observer.transcript(principal.user, docId)
        if (transcript === null) {
          if (observer.snapshot(principal.user, docId, limit) === null) throw documentNotFound(docId)
          throw new ApiError("invalid_arguments", "beforeTurn applies to session and task documents", { docId })
        }
        const page = transcript.olderTurns(beforeTurn, limit)
        if (page === undefined) throw new ApiError("not_found", "turn not found", { docId, turnId: beforeTurn })
        return json({ docId, ...page })
      },
    }),

    userRoute(deps, {
      method: "GET",
      path: "/api/v1/docs/:docId/turns/:turnId",
      handle: ({ principal, params }) => {
        const docId = params.docId ?? ""
        const turnId = params.turnId ?? ""
        if (observer.transcript(principal.user, docId) === null) throw documentNotFound(docId)
        const body = observer.turnBody(principal.user, docId, turnId)
        if (body === undefined) throw new ApiError("not_found", "turn not found", { docId, turnId })
        return json(body)
      },
    }),

    userRoute(deps, {
      method: "GET",
      path: "/api/v1/docs/:docId/images/:sha256",
      handle: ({ principal, params }) => {
        const docId = params.docId ?? ""
        const sha256 = params.sha256 ?? ""
        if (!SHA256.test(sha256)) throw new ApiError("invalid_arguments", "sha256 must be 64 lowercase hex characters")
        const image = observer.image(principal.user, docId, sha256)
        if (image === undefined) throw new ApiError("not_found", "image not found", { docId, sha256 })
        return new Response(image.bytes, {
          headers: { "content-type": image.mimeType, "cache-control": "private, max-age=86400, immutable" },
        })
      },
    }),
  ]
}
