import { appendFile, mkdir, rm } from "node:fs/promises"
import { dirname, resolve, sep } from "node:path"
import { ApiError, knownErrorResponse } from "../../src/api/errors"
import { json, Router } from "../../src/api/routes"
import type { App } from "../../src/app"
import { isPlainObject } from "../../src/config/reader"
import { threadId } from "../../src/core/ids"
import type { ThreadState } from "../../src/core/ports"
import type { FakeClock, FakeGateway } from "./fakes"

const THREAD_STATES: readonly ThreadState[] = ["running", "idle", "inactive"]

function bodyRecord(body: unknown): Record<string, unknown> {
  if (!isPlainObject(body)) throw new ApiError("invalid_arguments", "body must be a JSON object")
  return body
}

type E2eControlTarget = {
  readonly clock: FakeClock
  readonly gateway: FakeGateway
  readonly agentDir: string
  readonly app: App
}

function controlRouter(target: E2eControlTarget): Router {
  const router = new Router()
  const read = async (request: Request): Promise<Record<string, unknown>> => bodyRecord(await request.json())
  router.add({
    method: "POST",
    path: "/__test/stream/close",
    handle: () => {
      target.app.hub.closeAll()
      return new Response(null, { status: 204 })
    },
  })
  router.add({
    method: "POST",
    path: "/__test/clock/advance",
    handle: async (request) => {
      const { ms } = await read(request)
      if (typeof ms !== "number" || !Number.isSafeInteger(ms) || ms < 0) {
        throw new ApiError("invalid_arguments", "ms must be a non-negative integer")
      }
      target.clock.advance(ms)
      return json({ now: target.clock.now() })
    },
  })
  router.add({
    method: "POST",
    path: "/__test/gateway/threads",
    handle: async (request) => {
      const { name, cwd } = await read(request)
      const thread = target.gateway.seedThread({
        ...(typeof name === "string" ? { name } : {}),
        ...(typeof cwd === "string" ? { cwd } : {}),
      })
      return json({ thread }, 201)
    },
  })
  router.add({
    method: "POST",
    path: "/__test/gateway/threads/:thread/state",
    handle: async (request, _peer, params) => {
      const { state } = await read(request)
      const parsed = THREAD_STATES.find((candidate) => candidate === state)
      if (parsed === undefined) throw new ApiError("invalid_arguments", `state must be one of ${THREAD_STATES.join(", ")}`)
      target.gateway.setThreadState(threadId(params.thread ?? ""), parsed)
      return new Response(null, { status: 204 })
    },
  })
  router.add({
    method: "POST",
    path: "/__test/fixtures/append",
    handle: async (request) => {
      const { path, line } = await read(request)
      if (typeof path !== "string" || typeof line !== "string") {
        throw new ApiError("invalid_arguments", "body must be {path, line}")
      }
      const file = resolve(target.agentDir, path)
      if (!file.startsWith(target.agentDir + sep)) {
        throw new ApiError("invalid_arguments", "path must stay inside the fixture tree")
      }
      await mkdir(dirname(file), { recursive: true })
      await appendFile(file, `${line}\n`)
      return new Response(null, { status: 204 })
    },
  })
  router.add({
    method: "POST",
    path: "/__test/fixtures/remove",
    handle: async (request) => {
      const { path } = await read(request)
      if (typeof path !== "string") throw new ApiError("invalid_arguments", "path must be a string")
      const file = resolve(target.agentDir, path)
      if (!file.startsWith(target.agentDir + sep)) {
        throw new ApiError("invalid_arguments", "path must stay inside the fixture tree")
      }
      await rm(file, { force: true })
      return new Response(null, { status: 204 })
    },
  })
  return router
}

export function createE2eControlHandler(target: E2eControlTarget): (request: Request) => Promise<Response> {
  const router = controlRouter(target)
  return async (request) => {
    try {
      const matched = router.match(request.method, new URL(request.url).pathname)
      if (matched === null) throw new ApiError("not_found", "unknown control route")
      return await matched.route.handle(request, "", matched.params)
    } catch (error) {
      const known = knownErrorResponse(error)
      if (known === null) throw error
      return known
    }
  }
}
