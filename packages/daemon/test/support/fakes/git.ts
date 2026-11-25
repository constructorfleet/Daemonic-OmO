import { GitError, type Git, type WorktreeAddArgs, type WorktreeEntry } from "../../../src/core/ports"

export interface FakeGitFailure {
  readonly message?: string
  readonly stderr?: string
  readonly exitCode?: number
}

export class FakeGit implements Git {
  private readonly repos = new Set<string>()
  private readonly trees = new Map<string, WorktreeEntry[]>()
  private readonly successes: Array<WorktreeAddArgs & { readonly entry: WorktreeEntry }> = []
  private readonly attempts: WorktreeAddArgs[] = []
  private readonly repoFailures = new Map<string, FakeGitFailure>()
  private nextFailure: FakeGitFailure | null = null

  addRepo(path: string): void {
    this.repos.add(path)
  }

  seedWorktree(repo: string, entry: WorktreeEntry): void {
    const existing = this.trees.get(repo) ?? []
    this.trees.set(repo, [...existing, entry])
  }

  failWorktreeAdd(repo: string, failure: FakeGitFailure = {}): void {
    this.repoFailures.set(repo, failure)
  }

  failNextWorktreeAdd(failure: FakeGitFailure = {}): void {
    this.nextFailure = failure
  }

  get worktreeAdds(): readonly (WorktreeAddArgs & { readonly entry: WorktreeEntry })[] {
    return [...this.successes]
  }

  get worktreeAttempts(): readonly WorktreeAddArgs[] {
    return [...this.attempts]
  }

  async isRepo(path: string): Promise<boolean> {
    return this.repos.has(path)
  }

  async worktreeAdd(args: WorktreeAddArgs): Promise<WorktreeEntry> {
    this.attempts.push(args)
    const failure = this.nextFailure ?? this.repoFailures.get(args.repo) ?? null
    this.nextFailure = null
    if (failure !== null) {
      throw new GitError(failure.message ?? "fake git worktree add failed", {
        args: ["worktree", "add", "-b", args.branch, args.path, args.base],
        exitCode: failure.exitCode ?? 1,
        stderr: failure.stderr ?? "",
      })
    }
    const entry: WorktreeEntry = {
      path: args.path,
      branch: args.branch,
      head: args.base,
      bare: false,
    }
    this.successes.push({ ...args, entry })
    const existing = this.trees.get(args.repo) ?? []
    this.trees.set(args.repo, [...existing, entry])
    return entry
  }

  async worktreeList(repo: string): Promise<readonly WorktreeEntry[]> {
    return [...(this.trees.get(repo) ?? [])]
  }
}
