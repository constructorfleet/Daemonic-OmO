import { readdirSync } from "node:fs"
import { join } from "node:path"
import { listOmoSchedules } from "@omo-daemonic/store"
import { json, userRoute, type Route } from "../api/routes"
import type { FeatureContext } from "../api/context"
import { ApiError } from "../api/errors"
import { sessionDocId } from "../observer/doc-factory"
import { runCommand, tail } from "../omo/command"
import { omoChildEnv } from "../omo/runtime"

export function scheduleRoutes(ctx: FeatureContext): readonly Route[] {
  return [
    userRoute(ctx, {
      method: "GET",
      path: "/api/v1/omo/schedules",
      handle: ({ principal }) => {
        const schedules = listOmoSchedules(principal.user.agentDir, { now: ctx.clock.now() })
        const live = schedules.liveRunners.length
        let total = 0
        try {
          total = readdirSync(join(principal.user.agentDir, "schedule", "runners"))
            .filter((name) => /^\d+\.json$/.test(name)).length
        } catch (error) {
          if (!(error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR"))) {
            throw error
          }
        }
        return json({
          schedules: schedules.jobs.map((job) => ({
            id: job.id,
            state: job.state,
            dueAt: job.dueAt,
            everyMs: job.everyMs,
            fireCount: job.fireCount,
            promptPreview: job.prompt.split(/\r?\n/, 1)[0],
            sessionLink: sessionDocId(principal.user.agentDir, job.sessionId),
            cancelled: job.cancelled,
          })),
          runners: { live, total },
          willFire: live > 0,
          invalidRecords: schedules.invalidRecords,
        })
      },
    }),
    userRoute(ctx, {
      method: "POST",
      path: "/api/v1/omo/schedules/:id/cancel",
      handle: async ({ principal, params }) => {
        const id = params.id ?? ""
        if (!/^sch_[a-z0-9]{12}$/.test(id)) throw new ApiError("not_found", "schedule not found")
        const schedules = listOmoSchedules(principal.user.agentDir, { now: ctx.clock.now() })
        if (!schedules.jobs.some((job) => job.id === id)) throw new ApiError("not_found", "schedule not found")
        const command = `omo schedule cancel ${id}`
        const env = omoChildEnv(process.env, principal.user.agentDir)
        const result = await runCommand({
          cmd: [ctx.config.omo.bin, "schedule", "cancel", id],
          cwd: env.HOME ?? "/",
          env,
          timeoutMs: ctx.config.limits.omoCommandTimeoutMs,
        }, ctx.clock)
        if (result.exitCode !== 0) {
          return Response.json({
            error: {
              code: "omo_unavailable",
              message: "omo could not cancel the schedule",
              details: { stderrTail: tail(result.stderr, ctx.config.limits.omoCommandStderrTailChars), manualCommand: command },
            },
          }, { status: 503, headers: { "cache-control": "no-store" } })
        }
        return json({ id, cancelled: true })
      },
    }),
  ]
}
