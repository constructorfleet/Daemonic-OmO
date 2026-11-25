import { describe, expect, test } from "bun:test"

import { ulid } from "../../src/core/ids"
import { ensureWorktree, worktreeLocation } from "../../src/runs/worktree"
import { FakeGit, SeededRng } from "../support/fakes"

const rng = new SeededRng(3)
const ROOT = "/daemon-home/worktrees"
const project = { id: ulid(rng, 1_700_000_000_000), cwd: "/src/app" }
const runId = ulid(rng, 1_700_000_000_000)

function gitWithRepo(): FakeGit {
  const git = new FakeGit()
  git.addRepo(project.cwd)
  git.seedWorktree(project.cwd, { path: project.cwd, branch: "refs/heads/main", head: "abc", bare: false })
  return git
}

describe("run worktrees", () => {
  test("a schedule fire gets its own worktree outside the checkout, branched from HEAD", async () => {
    const git = gitWithRepo()
    const location = worktreeLocation(ROOT, project.id, { kind: "sched", id: runId, name: "Nightly Build!" })
    const result = await ensureWorktree({ git, root: ROOT, maxKeptPerProject: 50 }, project, location)
    expect(result).toEqual({ kind: "ready", path: `${ROOT}/${project.id}/${runId}`, branch: `omo-daemonic/sched-nightly-build-${runId}` })
    expect(git.worktreeAdds.map(({ repo, path, branch, base }) => ({ repo, path, branch, base }))).toEqual([
      { repo: project.cwd, path: `${ROOT}/${project.id}/${runId}`, branch: `omo-daemonic/sched-nightly-build-${runId}`, base: "HEAD" },
    ])
  })

  test("a loop's worktree is keyed by the loop and shared by its iterations", () => {
    const loopId = ulid(rng, 1_700_000_000_000)
    expect(worktreeLocation(ROOT, project.id, { kind: "loop", id: loopId, name: "fix tests" })).toEqual({
      path: `${ROOT}/${project.id}/${loopId}`,
      branch: `omo-daemonic/loop-fix-tests-${loopId}`,
    })
  })

  test("an existing worktree at the run's path is reused, so a recovered run never adds it twice", async () => {
    const git = gitWithRepo()
    const location = worktreeLocation(ROOT, project.id, { kind: "sched", id: runId, name: "n" })
    git.seedWorktree(project.cwd, { path: location.path, branch: location.branch, head: "abc", bare: false })
    expect(await ensureWorktree({ git, root: ROOT, maxKeptPerProject: 1 }, project, location)).toEqual({ kind: "ready", ...location })
    expect(git.worktreeAttempts).toHaveLength(0)
  })

  test("past maxKeptPerProject daemon worktrees of the project the run is capped and nothing is added", async () => {
    const git = gitWithRepo()
    for (const index of [1, 2]) {
      git.seedWorktree(project.cwd, { path: `${ROOT}/${project.id}/kept-${index}`, branch: `b${index}`, head: "abc", bare: false })
    }
    git.seedWorktree(project.cwd, { path: `${ROOT}/${ulid(rng, 1_700_000_000_000)}/x`, branch: "other", head: "abc", bare: false })
    const location = worktreeLocation(ROOT, project.id, { kind: "sched", id: runId, name: "n" })
    expect(await ensureWorktree({ git, root: ROOT, maxKeptPerProject: 2 }, project, location)).toEqual({ kind: "capped", kept: 2 })
    expect(git.worktreeAttempts).toHaveLength(0)
    expect((await ensureWorktree({ git, root: ROOT, maxKeptPerProject: 3 }, project, location)).kind).toBe("ready")
  })
})
