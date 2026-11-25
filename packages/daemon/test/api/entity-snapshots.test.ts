import { afterEach, describe, expect, test } from "bun:test"
import type { Project } from "../../src/core/types"
import { parseUlid } from "../../src/core/ids"
import { member, memberHeaders, server, SseReader, stopServers } from "./harness"

afterEach(stopServers)

describe("entity stream snapshots", () => {
  test("replay returns each entity snapshot as of that event", async () => {
    const target = await server()
    const alice = await member(target, "alice")
    const id = parseUlid("01ARZ3NDEKTSV4RRFFQ69G5FAZ")
    if (id === null) throw new Error("invalid project fixture id")
    const at = new Date(target.clock.now()).toISOString()
    const project: Project = {
      id,
      userId: alice.user.id,
      name: "before",
      cwd: "/work/before",
      agentDir: alice.user.agentDir,
      stateDir: "/state/before",
      maxRunning: 1,
      state: "active",
      revision: 1,
      createdAt: at,
      updatedAt: at,
    }
    const scope = { kind: "user", userId: alice.user.id } as const
    const since = target.app.ctx.feed.head(scope)
    target.app.ctx.repos.projects.put(project)
    target.app.ctx.repos.projects.update({ ...project, name: "after", revision: 2 }, 1)

    const reader = await SseReader.open(target, memberHeaders(target, alice), `?since=${since}`)
    await reader.next()
    const frames = await reader.entitiesThrough(since + 2)

    expect(frames.map(({ data }) => data)).toEqual([
      expect.objectContaining({ data: project }),
      expect.objectContaining({ data: { ...project, name: "after", revision: 2 } }),
    ])
    expect(target.app.ctx.repos.projects.get(id)).toEqual({ ...project, name: "after", revision: 2 })
    await reader.cancel()
  })
})
