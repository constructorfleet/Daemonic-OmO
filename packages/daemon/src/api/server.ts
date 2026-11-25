import { stat } from "node:fs/promises"
import { join, resolve, sep } from "node:path"
import type { Server } from "bun"
import type { ListenConfig } from "../config"
import { ApiError, errorResponse, knownErrorResponse } from "./errors"
import type { Router } from "./routes"
import { GUARD, type Services } from "./services"

export type FetchHandler = (request: Request, server: Server<undefined>) => Promise<Response>

export interface HttpHandlerDeps {
  readonly router: Router
  readonly services: Services
  readonly staticDir: string | null
}

async function staticFile(root: string, pathname: string): Promise<string | null> {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch (error) {
    if (error instanceof URIError) return null
    throw error
  }
  const target = join(root, decoded)
  if (target !== root && !target.startsWith(root + sep)) return null
  try {
    return (await stat(target)).isFile() ? target : null
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return null
    throw error
  }
}

function boundaryError(error: unknown): Response {
  const known = knownErrorResponse(error)
  if (known !== null) return known
  console.error("omo-daemonic: unhandled request error", error)
  return errorResponse(new ApiError("internal", "internal error"))
}

export function createHttpHandler(deps: HttpHandlerDeps): FetchHandler {
  const root = deps.staticDir === null ? null : resolve(deps.staticDir)

  async function dispatch(request: Request, peer: string): Promise<Response> {
    const url = new URL(request.url)
    const matched = deps.router.match(request.method, url.pathname)
    if (matched !== null) return matched.route.handle(request, peer, matched.params)
    const isPageRequest = request.method === "GET" || request.method === "HEAD"
    if (root === null || !isPageRequest || url.pathname.startsWith("/api/")) {
      throw new ApiError("not_found", `no route for ${request.method} ${url.pathname}`)
    }
    deps.services.require(GUARD).admitPublic(request, peer)
    const file = await staticFile(root, url.pathname) ?? await staticFile(root, "/index.html")
    if (file === null) throw new ApiError("not_found", "the web app is not built")
    return new Response(Bun.file(file))
  }

  return async (request, server) => {
    const peer = server.requestIP(request)?.address ?? ""
    let response: Response
    try {
      response = await dispatch(request, peer)
    } catch (error) {
      response = boundaryError(error)
    }
    // Bun closes connections idle past idleTimeout; an SSE stream is idle between frames.
    if (response.headers.get("content-type")?.startsWith("text/event-stream") === true) server.timeout(request, 0)
    return response
  }
}

export function startServer(fetch: FetchHandler, listen: ListenConfig): Server<undefined> {
  return Bun.serve({ hostname: listen.host, port: listen.port, fetch })
}
