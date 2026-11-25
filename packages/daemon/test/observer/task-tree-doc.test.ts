import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { resolveTaskStateDir, type TaskTreeItem } from "@omo-daemonic/store"
import { projectViews } from "../../src/observer/discovery"
import { TaskTreeDoc, type TaskTreeOp } from "../../src/observer/task-tree-doc"
import { cleanTemps, fixtureTree, repositories, seedProject, seedRun, seedUser, tempDir, writeTask } from "./support"

afterEach(cleanTemps)

function taskIds(doc: TaskTreeDoc): readonly string[] {
  return doc.snapshot().items.flatMap((item) => item.kind === "task" ? [item.id] : []).toSorted()
}

/** A client applying ops in order, as the TaskTreeDoc contract states. */
function apply(items: readonly TaskTreeItem[], ops: readonly TaskTreeOp[]): readonly TaskTreeItem[] {
  const next = [...items]
  for (const op of ops) {
    const at = next.findIndex((item) => item.id === (op.op === "task.remove" ? op.id : op.item.id))
    if (at >= 0) next.splice(at, 1)
    if (op.op === "task.upsert") next.splice(op.index, 0, op.item)
  }
  return next
}

describe("project discovery and task tree doc", () => {
  test("a worktree run's tasks are merged into its project's tree", () => {
    const tree = fixtureTree()
    const repos = repositories()
    const user = seedUser(repos, tree.agentDir, "alice")
    const project = seedProject(repos, user, tree.projectDir)
    const worktree = join(tempDir("worktrees"), "run-1")
    const plainCwd = join(tempDir("plain"), "elsewhere")
    mkdirSync(worktree)
    mkdirSync(plainCwd)
    seedRun(repos, project, worktree, true)
    seedRun(repos, project, plainCwd, false)
    writeTask(resolveTaskStateDir(worktree, { agentDir: tree.agentDir }), { task_id: "task-wt", parent_session_id: "sess-wt" })
    writeTask(resolveTaskStateDir(plainCwd, { agentDir: tree.agentDir }), { task_id: "task-plain", parent_session_id: "sess-plain" })
    const view = projectViews(repos, user).find((candidate) => candidate.id === project.id)
    const doc = new TaskTreeDoc(() => view?.stateDirs ?? [])

    doc.poll()

    expect(taskIds(doc)).toEqual(["task-events", "task-multi", "task-wt"])
  })

  test("discovered session cwds are listed beside registered projects", () => {
    const tree = fixtureTree()
    const repos = repositories()
    const user = seedUser(repos, tree.agentDir, "alice")
    const project = seedProject(repos, user, tree.projectDir)

    const views = projectViews(repos, user)

    expect(views.map((view) => [view.registered, view.cwd])).toEqual([[true, project.cwd], [false, "/tmp/project-fixture"]])
    expect(views[1]?.id).toMatch(/^disc-[0-9a-f]{16}$/)
  })

  test("a changed task file upserts its row and a deleted one removes it", () => {
    const tree = fixtureTree()
    const doc = new TaskTreeDoc(() => [tree.stateDir])
    doc.poll()
    const initial = doc.snapshot().items
    writeTask(tree.stateDir, { task_id: "task-events", parent_session_id: "sess-basic", status: "completed", created_at: "2026-11-25T08:02:00.000Z" })
    const changed = doc.poll()
    const afterChange = doc.snapshot().items
    rmSync(join(tree.stateDir, "tasks", "task-multi.json"))

    const removed = doc.poll()

    expect(changed?.ops).toEqual([{ op: "task.upsert", index: 3, item: expect.objectContaining({ id: "task-events", task: expect.objectContaining({ status: "completed" }) }) }])
    expect(apply(initial, changed?.ops ?? [])).toEqual(afterChange)
    expect(removed?.ops).toContainEqual({ op: "task.remove", id: "task-multi" })
    expect(apply(afterChange, removed?.ops ?? [])).toEqual(doc.snapshot().items)
  })
})
