import { loadDagRuns, loadDagLibrary, readDagEvents } from "@omo-daemonic/store"
import type { FeatureContext } from "../api/context"
import { ApiError } from "../api/errors"
import { json, userRoute, type Route } from "../api/routes"
import { projectView } from "../observer/discovery"

function visibleProject(ctx: FeatureContext, user: Parameters<typeof projectView>[1], projectId: string) {
  const view = projectView(ctx.repos, user, projectId)
  if (view === undefined) throw new ApiError("not_found", "project not found")
  return view
}

export function dagRoutes(ctx: FeatureContext): readonly Route[] {
  return [
    userRoute(ctx, {
      method: "GET",
      path: "/api/v1/projects/:id/dag-runs",
      handle: ({ principal, params }) => {
        const projectId = params.id ?? ""
        const view = visibleProject(ctx, principal.user, projectId)
        const snapshots = view.stateDirs.map((stateDir) => loadDagRuns(stateDir))
        const runs = snapshots.flatMap((snapshot) => snapshot.runs)
          .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
        return json({
          runs: runs.map((run) => ({ ...run, docId: `dag:${projectId}:${run.runId}` })),
          invalidRuns: snapshots.reduce((total, snapshot) => total + snapshot.invalidRuns, 0),
        })
      },
    }),
    userRoute(ctx, {
      method: "GET",
      path: "/api/v1/projects/:id/dag-runs/:runId/events",
      handle: ({ principal, params, url }) => {
        const projectId = params.id ?? ""
        const runId = params.runId ?? ""
        const view = visibleProject(ctx, principal.user, projectId)
        const stateDir = view.stateDirs.find((candidate) =>
          loadDagRuns(candidate).runs.some((run) => run.runId === runId))
        if (stateDir === undefined) throw new ApiError("not_found", "DAG run not found")
        const snapshot = readDagEvents(stateDir, runId)
        const max = ctx.config.limits.observerPageMaxTurns
        const rawLimit = url.searchParams.get("limit")
        const parsedLimit = rawLimit === null ? max : /^\d+$/.test(rawLimit) ? Number(rawLimit) : Number.NaN
        if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > max) {
          throw new ApiError("invalid_arguments", `limit must be between 1 and ${max}`)
        }
        const rawBefore = url.searchParams.get("beforeSeq")
        const before = rawBefore === null
          ? Number.MAX_SAFE_INTEGER
          : /^\d+$/.test(rawBefore) ? Number(rawBefore) : Number.NaN
        if (!Number.isSafeInteger(before) || before < 1) {
          throw new ApiError("invalid_arguments", "beforeSeq must be a positive safe integer")
        }
        const eligible = snapshot.events.filter((event) => typeof event.seq === "number" && event.seq < before)
        const events = eligible.slice(-parsedLimit)
        return json({
          events,
          invalidEvents: snapshot.invalidEvents,
          unknownEvents: snapshot.unknownEvents,
          hasMore: eligible.length > events.length,
          ...(events.length === 0 ? {} : { nextBeforeSeq: events[0]?.seq }),
        })
      },
    }),
    userRoute(ctx, {
      method: "GET",
      path: "/api/v1/dag-library",
      handle: ({ principal, url }) => {
        const projectId = url.searchParams.get("projectId")
        if (projectId === null || projectId.length === 0) {
          throw new ApiError("invalid_arguments", "projectId is required")
        }
        const view = visibleProject(ctx, principal.user, projectId)
        const library = loadDagLibrary({
          cwd: view.cwd,
          home: principal.user.agentDir,
          env: { HOME: principal.user.agentDir },
        })
        return json(library)
      },
    }),
  ]
}
