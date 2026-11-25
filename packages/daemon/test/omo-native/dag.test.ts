import { afterEach, describe, expect, test } from "bun:test"
import { cp, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { member, memberHeaders, server } from "../api/harness"
import { cleanOmoNative, projectFor, writeJson } from "./support"

afterEach(cleanOmoNative)

describe("DAG API routes", () => {
  test("run listing rejects unsupported schemas and pages the owned journal", async () => {
    const target = await server()
    const alice = await member(target, "dag-alice")
    const bob = await member(target, "dag-bob")
    const project = await projectFor(target, alice, "alice-project")
    const other = await projectFor(target, bob, "bob-project")
    await mkdir(join(project.stateDir, "dag", "runs"), { recursive: true })
    await cp(
      join(import.meta.dir, "../observer/fixtures/store/dag/runs/dag_fixture.json"),
      join(project.stateDir, "dag", "runs", "dag_fixture.json"),
    )
    await writeJson(join(project.stateDir, "dag", "runs", "run_unsupported.json"), { schemaVersion: 99 })
    const eventsDir = join(project.stateDir, "dag", "events")
    await mkdir(eventsDir, { recursive: true })
    await writeFile(join(eventsDir, "dag_fixture.jsonl"), [1, 2, 3, 4].map((seq) => JSON.stringify({
      schemaVersion: 1, runId: "dag_fixture", seq, at: `2026-11-25T00:0${seq}:00.000Z`,
      lane: "boundary", type: "dag.run.paused",
    })).join("\n") + "\n")

    const listed = await fetch(`${target.url}/api/v1/projects/${project.id}/dag-runs`, {
      headers: memberHeaders(target, alice),
    })
    const page = await fetch(`${target.url}/api/v1/projects/${project.id}/dag-runs/dag_fixture/events?beforeSeq=5&limit=2`, {
      headers: memberHeaders(target, alice),
    })
    const olderPage = await fetch(`${target.url}/api/v1/projects/${project.id}/dag-runs/dag_fixture/events?beforeSeq=3&limit=2`, {
      headers: memberHeaders(target, alice),
    })
    const doc = await fetch(`${target.url}/api/v1/docs/dag:${project.id}:dag_fixture`, {
      headers: memberHeaders(target, alice),
    })
    const hidden = await fetch(`${target.url}/api/v1/projects/${other.id}/dag-runs`, {
      headers: memberHeaders(target, alice),
    })

    expect(listed.status).toBe(200)
    expect(await listed.json()).toMatchObject({
      runs: [{ runId: "dag_fixture", docId: `dag:${project.id}:dag_fixture` }],
      invalidRuns: 1,
    })
    expect(page.status).toBe(200)
    expect(await page.json()).toMatchObject({ events: [{ seq: 3 }, { seq: 4 }], hasMore: true, nextBeforeSeq: 3 })
    expect(await olderPage.json()).toMatchObject({ events: [{ seq: 1 }, { seq: 2 }], hasMore: false })
    expect(doc.status).toBe(200)
    expect(await doc.json()).toMatchObject({ docId: `dag:${project.id}:dag_fixture` })
    expect(hidden.status).toBe(404)
  })

  test("library includes only the member's project and agent definitions", async () => {
    const target = await server()
    const alice = await member(target, "library-alice")
    const bob = await member(target, "library-bob")
    const project = await projectFor(target, alice, "library-project")
    const definition = (key: string) => ({ key, name: key, nodes: [] })
    await writeJson(join(project.cwd, ".omo", "dags", "project.json"), definition("project-dag"))
    await writeJson(join(alice.user.agentDir, ".omo", "dags", "personal.json"), definition("personal-dag"))
    await writeJson(join(bob.user.agentDir, ".omo", "dags", "private.json"), definition("private-dag"))

    const response = await fetch(`${target.url}/api/v1/dag-library?projectId=${project.id}`, {
      headers: memberHeaders(target, alice),
    })
    const body: unknown = await response.json()

    expect(response.status).toBe(200)
    expect(JSON.stringify(body)).toContain("project-dag")
    expect(JSON.stringify(body)).toContain("personal-dag")
    expect(JSON.stringify(body)).not.toContain("private-dag")
  })
})
