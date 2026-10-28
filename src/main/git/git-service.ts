import type {
  GitBranchInfo,
  GitCommitInfo,
  GitConflictAnalysis,
  GitConflictSide,
  GitConflictWorkFile,
  GitDiff,
  GitFileChange,
  GitIdentity,
  GitPullStrategy,
  GitRebaseAction,
  GitRemoteInfo,
  GitRemoteUpdate,
  GitRestoreTarget,
  GitResetMode,
  GitStashEntry,
  GitStatus,
  GitSyncDirection,
  GitSyncPeerTarget,
  GitSyncResult,
  GitSyncSummary,
  MergeSummary,
  PullRequestCompare,
  PrComposeInput
} from '../../lib/types'
import { DEFAULT_MAX_CONFLICT_FILE_BYTES } from '../../lib/types'
import { GitServiceBranches } from './git/git-service-branches'
import { GitServiceChanges } from './git/git-service-changes'
import { GitServiceCommits } from './git/git-service-commits'
import { GitServiceConflictResolution } from './git/git-service-conflict-resolution'
import { GitServiceCore } from './git/git-service-core'
import { GitServiceMergeRebase } from './git/git-service-merge-rebase'
import { GitServicePullRequests } from './git/git-service-pull-requests'
import { GitServiceRemotes } from './git/git-service-remotes'
import { GitServiceRepository } from './git/git-service-repository'
import { GitServiceStashes } from './git/git-service-stashes'
import type { PullRequestComposeContext } from './git/git-service-pull-request'
import { DEFAULT_LOG_LIMIT } from './git/git-service-status'
import { GitServiceSync } from './git/git-service-sync'

// Git read commands opportunistically refresh the index, which takes
// `.git/index.lock`. This service shares the repository with agent git CLIs,
// so every polling status read used to race real writes and occasionally
// fail them with "index.lock: File exists". Disabling the opportunistic
// refresh keeps our reads lock-free; index writes (add, commit) still take
// the lock when they must, and `withIndexLockRetry` backstops those races.
// simple-git spawns inherit the main process environment, so this covers
// every git command this service runs. (Harness processes get the same
// default via buildProcessEnvironment.)
process.env.GIT_OPTIONAL_LOCKS = process.env.GIT_OPTIONAL_LOCKS ?? '0'

export type { PullRequestComposeContext } from './git/git-service-pull-request'

/**
 * Main-process git runtime built on `simple-git`   the same thin wrapper over
 * the system `git` binary the app already execs in `repository-service`,
 * `change-tracking-service`, and `project-file-index-service`.
 *
 * All repository mutations are serialized per project through a promise queue
 * (the `project-files-service` pattern) so concurrent IPC-driven operations can
 * never interleave and corrupt the working tree. Operations that talk to a
 * remote get a second lane of their own; see `enqueueRemote`.
 */
export interface GitServiceOptions {
  /**
   * Byte cap on a conflicted file the service reads and writes, resolved per
   * call so a settings change applies without a restart. Defaults to
   * {@link DEFAULT_MAX_CONFLICT_FILE_BYTES}.
   */
  conflictFileLimit?: () => Promise<number>
}

/**
 * The one git entry point the main process calls: every method here keeps the
 * name and signature it had when this was a single class, and forwards to the
 * unit that owns the concern.
 *
 * | Unit | Owns |
 * | --- | --- |
 * | {@link GitServiceCore} | the per-project lanes, client factories, error classification, status reads |
 * | {@link GitServiceChanges} | per-file diffs, staging, restore, ignore and discard |
 * | {@link GitServiceConflictResolution} | one conflicted path at a time, and whole-side accepts |
 * | {@link GitServiceRepository} | `git init` and the commit identity |
 * | {@link GitServiceCommits} | history reads and every commit rewrite (amend, reset, drop, delete) |
 * | {@link GitServiceBranches} | branch listing, checkout, create, delete, upstream reflog |
 * | {@link GitServiceRemotes} | remote configuration and fetches |
 * | {@link GitServiceSync} | pull, push, peer sync, and post-integration probing |
 * | {@link GitServiceMergeRebase} | merge, rebase, their aborts, and stepping a stopped rebase |
 * | {@link GitServicePullRequests} | PR branch compare, compose context, PR conflict round trip |
 * | {@link GitServiceStashes} | stash push, list, pop and drop |
 *
 * The doc comment for each operation lives on the method that implements it in
 * its unit, so there is one description and it sits next to the code.
 */
export class GitService {
  private readonly core: GitServiceCore
  private readonly changes: GitServiceChanges
  private readonly conflicts: GitServiceConflictResolution
  private readonly repository: GitServiceRepository
  private readonly commits: GitServiceCommits
  private readonly branches: GitServiceBranches
  private readonly remotes: GitServiceRemotes
  private readonly sync: GitServiceSync
  private readonly mergeRebase: GitServiceMergeRebase
  private readonly pullRequests: GitServicePullRequests
  private readonly stashes: GitServiceStashes

  constructor(options: GitServiceOptions = {}) {
    const conflictFileLimit =
      options.conflictFileLimit ?? (async () => DEFAULT_MAX_CONFLICT_FILE_BYTES)
    this.core = new GitServiceCore()
    this.changes = new GitServiceChanges(this.core)
    this.conflicts = new GitServiceConflictResolution(this.core, conflictFileLimit)
    this.repository = new GitServiceRepository(this.core)
    this.commits = new GitServiceCommits(this.core)
    this.branches = new GitServiceBranches(this.core)
    this.remotes = new GitServiceRemotes(this.core)
    this.sync = new GitServiceSync(this.core)
    this.mergeRebase = new GitServiceMergeRebase(this.core)
    this.pullRequests = new GitServicePullRequests(this.core)
    this.stashes = new GitServiceStashes(this.core)
  }

  async getStatus(projectPath: string): Promise<GitStatus> {
    return this.core.getStatus(projectPath)
  }

  async getDiff(projectPath: string, relativePath: string, staged: boolean): Promise<GitDiff> {
    return this.changes.getDiff(projectPath, relativePath, staged)
  }

  async stage(projectPath: string, paths: string[]): Promise<GitStatus> {
    return this.changes.stage(projectPath, paths)
  }

  async resolveConflicted(projectPath: string, path: string): Promise<GitStatus> {
    return this.conflicts.resolveConflicted(projectPath, path)
  }

  async acceptConflictSide(projectPath: string, side: GitConflictSide): Promise<GitStatus> {
    return this.conflicts.acceptConflictSide(projectPath, side)
  }

  async analyzeConflict(projectPath: string, relativePath: string): Promise<GitConflictAnalysis> {
    return this.conflicts.analyzeConflict(projectPath, relativePath)
  }

  async prepareConflictWorkFile(
    projectPath: string,
    relativePath: string
  ): Promise<GitConflictWorkFile> {
    return this.conflicts.prepareConflictWorkFile(projectPath, relativePath)
  }

  async saveConflictDraft(
    projectPath: string,
    relativePath: string,
    content: string,
    stateJson: string
  ): Promise<void> {
    return this.conflicts.saveConflictDraft(projectPath, relativePath, content, stateJson)
  }

  async saveConflictResolution(
    projectPath: string,
    relativePath: string,
    content: string
  ): Promise<GitStatus> {
    return this.conflicts.saveConflictResolution(projectPath, relativePath, content)
  }

  async unstage(projectPath: string, paths: string[]): Promise<GitStatus> {
    return this.changes.unstage(projectPath, paths)
  }

  async restoreFiles(
    projectPath: string,
    source: string,
    paths: string[],
    target: GitRestoreTarget
  ): Promise<GitStatus> {
    return this.changes.restoreFiles(projectPath, source, paths, target)
  }

  async commit(projectPath: string, message: string): Promise<GitStatus> {
    return this.commits.commit(projectPath, message)
  }

  async initialize(projectPath: string): Promise<GitStatus> {
    return this.repository.initialize(projectPath)
  }

  async listBranches(projectPath: string): Promise<GitBranchInfo[]> {
    return this.branches.listBranches(projectPath)
  }

  async getDefaultBranch(projectPath: string): Promise<string | null> {
    return this.branches.getDefaultBranch(projectPath)
  }

  async checkout(projectPath: string, branch: string): Promise<GitStatus> {
    return this.branches.checkout(projectPath, branch)
  }

  async createBranch(projectPath: string, name: string): Promise<GitStatus> {
    return this.branches.createBranch(projectPath, name)
  }

  async createTrackingBranch(
    projectPath: string,
    remote: string,
    branch: string,
    localName: string
  ): Promise<GitStatus> {
    return this.branches.createTrackingBranch(projectPath, remote, branch, localName)
  }

  async deleteBranch(projectPath: string, name: string, force = false): Promise<GitStatus> {
    return this.branches.deleteBranch(projectPath, name, force)
  }

  async deleteRemoteBranch(projectPath: string, remote: string, name: string): Promise<GitStatus> {
    return this.branches.deleteRemoteBranch(projectPath, remote, name)
  }

  async remoteUpdates(projectPath: string): Promise<GitRemoteUpdate[]> {
    return this.branches.remoteUpdates(projectPath)
  }

  async log(
    projectPath: string,
    limit = DEFAULT_LOG_LIMIT,
    offset = 0,
    query?: string
  ): Promise<GitCommitInfo[]> {
    return this.commits.log(projectPath, limit, offset, query)
  }

  async commitDiff(projectPath: string, hash: string): Promise<GitFileChange[]> {
    return this.commits.commitDiff(projectPath, hash)
  }

  async commitFileDiff(projectPath: string, hash: string, relativePath: string): Promise<GitDiff> {
    return this.commits.commitFileDiff(projectPath, hash, relativePath)
  }

  async stashDiff(projectPath: string, id: string): Promise<GitFileChange[]> {
    return this.commits.stashDiff(projectPath, id)
  }

  async stashFileDiff(projectPath: string, id: string, relativePath: string): Promise<GitDiff> {
    return this.commits.stashFileDiff(projectPath, id, relativePath)
  }

  async amend(projectPath: string, message: string): Promise<GitStatus> {
    return this.commits.amend(projectPath, message)
  }

  async removeCommitChanges(
    projectPath: string,
    hash: string,
    paths: string[]
  ): Promise<GitStatus> {
    return this.commits.removeCommitChanges(projectPath, hash, paths)
  }

  async reset(projectPath: string, mode: GitResetMode, target?: string): Promise<GitStatus> {
    return this.commits.reset(projectPath, mode, target)
  }

  async deleteCommit(projectPath: string, target: string): Promise<GitStatus> {
    return this.commits.deleteCommit(projectPath, target)
  }

  async getIdentity(projectPath: string): Promise<GitIdentity> {
    return this.repository.getIdentity(projectPath)
  }

  async setIdentity(projectPath: string, name: string, email: string): Promise<GitIdentity> {
    return this.repository.setIdentity(projectPath, name, email)
  }

  async listRemotes(projectPath: string): Promise<GitRemoteInfo[]> {
    return this.remotes.listRemotes(projectPath)
  }

  async addRemote(projectPath: string, name: string, url: string): Promise<GitRemoteInfo[]> {
    return this.remotes.addRemote(projectPath, name, url)
  }

  async setRemoteUrl(projectPath: string, name: string, url: string): Promise<GitRemoteInfo[]> {
    return this.remotes.setRemoteUrl(projectPath, name, url)
  }

  async removeRemote(projectPath: string, name: string): Promise<GitRemoteInfo[]> {
    return this.remotes.removeRemote(projectPath, name)
  }

  async fetch(projectPath: string): Promise<GitStatus> {
    return this.remotes.fetch(projectPath)
  }

  async fetchBranch(projectPath: string, remote: string, branch: string): Promise<GitStatus> {
    return this.remotes.fetchBranch(projectPath, remote, branch)
  }

  async pull(projectPath: string): Promise<GitStatus> {
    return this.sync.pull(projectPath)
  }

  async pullIntegrate(
    projectPath: string,
    options: {
      remote?: string
      branch?: string
      strategy: GitPullStrategy
      token?: string
    }
  ): Promise<GitStatus> {
    return this.sync.pullIntegrate(projectPath, options)
  }

  async push(
    projectPath: string,
    options: { setUpstream: boolean; remote?: string; branch?: string; token?: string } = {
      setUpstream: false
    }
  ): Promise<GitStatus> {
    return this.sync.push(projectPath, options)
  }

  async syncWith(
    projectPath: string,
    options: {
      direction: GitSyncDirection
      /** The other end of the sync, already resolved by the caller. */
      peer: GitSyncPeerTarget
      strategy: GitPullStrategy
      remote?: string
      token?: string
    }
  ): Promise<GitSyncResult> {
    return this.sync.syncWith(projectPath, options)
  }

  async syncSummary(projectPath: string): Promise<GitSyncSummary> {
    return this.sync.syncSummary(projectPath)
  }

  async comparePullRequestBranches(
    projectPath: string,
    base: string,
    head: string
  ): Promise<PullRequestCompare | null> {
    return this.pullRequests.comparePullRequestBranches(projectPath, base, head)
  }

  async pullRequestComposeContext(
    projectPath: string,
    input: PrComposeInput
  ): Promise<PullRequestComposeContext> {
    return this.pullRequests.pullRequestComposeContext(projectPath, input)
  }

  async merge(projectPath: string, target: string): Promise<MergeSummary> {
    return this.mergeRebase.merge(projectPath, target)
  }

  async rebase(projectPath: string, target: string): Promise<MergeSummary> {
    return this.mergeRebase.rebase(projectPath, target)
  }

  async abortMerge(projectPath: string): Promise<GitStatus> {
    return this.mergeRebase.abortMerge(projectPath)
  }

  async abortRebase(projectPath: string): Promise<GitStatus> {
    return this.mergeRebase.abortRebase(projectPath)
  }

  async rebaseAction(projectPath: string, action: GitRebaseAction): Promise<GitStatus> {
    return this.mergeRebase.rebaseAction(projectPath, action)
  }

  async preparePrResolve(
    projectPath: string,
    options: { remote: string; pullNumber: number; baseBranch: string }
  ): Promise<GitStatus> {
    return this.pullRequests.preparePrResolve(projectPath, options)
  }

  async finishPrResolve(
    projectPath: string,
    options: {
      remote: string
      pullNumber: number
      headBranch: string
      returnBranch: string
      token?: string
    }
  ): Promise<GitStatus> {
    return this.pullRequests.finishPrResolve(projectPath, options)
  }

  async stash(projectPath: string, message?: string, paths?: string[]): Promise<GitStatus> {
    return this.stashes.stash(projectPath, message, paths)
  }

  async ignore(projectPath: string, paths: string[]): Promise<GitStatus> {
    return this.changes.ignore(projectPath, paths)
  }

  async discard(projectPath: string, paths: string[]): Promise<GitStatus> {
    return this.changes.discard(projectPath, paths)
  }

  async listStashes(projectPath: string): Promise<GitStashEntry[]> {
    return this.stashes.listStashes(projectPath)
  }

  async popStash(projectPath: string, id?: string): Promise<GitStatus> {
    return this.stashes.popStash(projectPath, id)
  }

  async dropStash(projectPath: string, id?: string): Promise<GitStatus> {
    return this.stashes.dropStash(projectPath, id)
  }
}
