import { describe, expect, test } from "bun:test"
import { FakeGit } from "./fakes"

const REPO = "/work/project"
const WORKTREE = "/home/.omo-daemonic/worktrees/project/run-1"
const BRANCH = "omo-daemonic/sched-nightly-run-1"

describe("FakeGit", () => {
  test("records a successful worktree add and returns it from worktreeList", async () => {
    const git = new FakeGit()
    git.addRepo(REPO)

    const entry = await git.worktreeAdd({
      repo: REPO,
      path: WORKTREE,
      branch: BRANCH,
      base: "HEAD",
    })

    expect(entry).toEqual({ path: WORKTREE, branch: BRANCH, head: "HEAD", bare: false })
    expect(git.worktreeAdds).toEqual([
      { repo: REPO, path: WORKTREE, branch: BRANCH, base: "HEAD", entry },
    ])
    expect(await git.worktreeList(REPO)).toEqual([entry])
  })

  test("a configured failure throws GitError and is recorded as an attempt, not a success", async () => {
    const git = new FakeGit()
    git.addRepo(REPO)
    git.failWorktreeAdd(REPO, { message: "cannot create worktree", stderr: "fatal: boom" })

    let caught: unknown = null
    try {
      await git.worktreeAdd({ repo: REPO, path: WORKTREE, branch: BRANCH, base: "HEAD" })
    } catch (error) {
      caught = error
    }

    if (!(caught instanceof Error)) {
      throw new Error("expected worktreeAdd to throw")
    }
    expect(caught.name).toBe("GitError")
    expect(caught.message).toBe("cannot create worktree")
    expect(git.worktreeAttempts).toHaveLength(1)
    expect(git.worktreeAdds).toHaveLength(0)
    expect(await git.worktreeList(REPO)).toEqual([])
  })

  test("a one-shot failure clears after the next worktree add", async () => {
    const git = new FakeGit()
    git.addRepo(REPO)
    git.failNextWorktreeAdd({ message: "transient failure" })

    await expect(
      git.worktreeAdd({ repo: REPO, path: WORKTREE, branch: BRANCH, base: "HEAD" }),
    ).rejects.toThrow("transient failure")

    const entry = await git.worktreeAdd({
      repo: REPO,
      path: WORKTREE,
      branch: BRANCH,
      base: "HEAD",
    })
    expect(entry.branch).toBe(BRANCH)
    expect(await git.worktreeList(REPO)).toEqual([entry])
  })

  test("isRepo reflects only configured repositories", async () => {
    const git = new FakeGit()
    git.addRepo(REPO)

    expect(await git.isRepo(REPO)).toBe(true)
    expect(await git.isRepo("/work/other")).toBe(false)
  })
})
