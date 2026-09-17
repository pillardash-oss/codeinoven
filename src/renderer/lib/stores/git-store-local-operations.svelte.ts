import { invoke } from '$lib/ipc.svelte'
import type {
  GitBranchInfo,
  GitCommitInfo,
  GitCredentialStatus,
  GitConflictAnalysis,
  GitConflictSide,
  GitConflictWorkFile,
  GitConflictWorkHunkState,
  GitDiff,
  GitFileChange,
  GitIdentity,
  GitPullStrategy,
  GitRebaseAction,
  GitRemoteInfo,
  GitResetMode,
  GitRestoreTarget,
  GitStashEntry,
  GitStatus,
  GitSyncDirection,
  GitSyncPeer,
  GitSyncPeerOption,
  GitSyncResult,
  GitHubPermissionRequired,
  MergeSummary,
  PrResolveOptions
} from '$shared/types'
import {
  errorMessage,
  isBranchNotFullyMerged,
  isPushRejected,
  type DeleteBranchResult,
  type GitOperation,
  type GitPushResult
} from './git-store-helpers'

/** The store services the local git operations need, so the class stays decoupled. */
export interface GitLocalOperationAccess {
  markBusy(operation: GitOperation, busy: boolean): void
  scopeFor(projectId: string): string | undefined
  scopedGitArgs<Args extends unknown[]>(
    projectId: string,
    ...args: Args
  ): [string, ...Args, string | undefined]
  refresh(projectId: string): Promise<void>
  readStatus(projectId: string): Promise<GitStatus | null>
  /** Record that a fetch was tried, so the panel-open gate can throttle it. */
  noteFetchAttempt(projectId: string): void
  /** Refresh the open-PR conflict indicator after a mutation that changes it. */
  refreshConflictIndicators(projectId: string, force?: boolean): void
}

/**
 * Per-project local git state and the operations that mutate it. The store
 * holds one instance and exposes its reactive fields and methods, so every
 * consumer still reads the same surface it always did.
 */
export class GitLocalOperations {
  status: GitStatus | null = $state(null)
  branches: GitBranchInfo[] = $state([])
  remotes: GitRemoteInfo[] = $state([])
  identity: GitIdentity | null = $state(null)
  credentialStatus: GitCredentialStatus | null = $state(null)
  stashes: GitStashEntry[] = $state([])
  error: string | null = $state(null)
  githubPermission: GitHubPermissionRequired | null = $state(null)
  /**
   * When true, the file explorer reveals only conflicted files (a mode like the
   * "Last turn" filter, driven from the git panel's Resolve flow and the file
   * tree's Conflicts toggle). Cleared when no conflicts remain.
   */
  conflictsMode = $state(false)

  /**
   * When the current working tree is a temporary PR-conflict session (the
   * `pr-<n>` branch created by `preparePrResolve`), this records everything
   * needed to finish it automatically once the merge is resolved and
   * committed: push back to the PR head, check out the original branch, and
   * delete the temporary branch. Cleared after a successful finish.
   */
  prResolveSession = $state<(PrResolveOptions & { projectId: string }) | null>(null)

  constructor(private readonly access: GitLocalOperationAccess) {}

  async stage(projectId: string, paths: string[]): Promise<void> {
    this.access.markBusy('stage', true)
    this.error = null
    try {
      const scopeBucketId = this.access.scopeFor(projectId)
      this.status = scopeBucketId
        ? await invoke('git:stage', projectId, paths, scopeBucketId)
        : await invoke('git:stage', projectId, paths)
    } catch (reason) {
      this.error = errorMessage(reason, 'Files could not be staged')
    } finally {
      this.access.markBusy('stage', false)
    }
  }

  /**
   * Fetch the parsed conflict hunks of one conflicted file for the resolution
   * panel (ours/theirs sides plus their line spans).
   */
  async analyzeConflict(projectId: string, path: string): Promise<GitConflictAnalysis> {
    return invoke('git:analyzeConflict', ...this.access.scopedGitArgs(projectId, path))
  }

  async prepareConflictWorkFile(projectId: string, path: string): Promise<GitConflictWorkFile> {
    return invoke('git:prepareConflictWorkFile', ...this.access.scopedGitArgs(projectId, path))
  }

  /** Persist partial resolution progress in the conflict scratch file only. */
  async saveConflictDraft(
    projectId: string,
    path: string,
    content: string,
    hunks: GitConflictWorkHunkState[]
  ): Promise<boolean> {
    this.error = null
    try {
      await invoke(
        'git:saveConflictDraft',
        ...this.access.scopedGitArgs(projectId, path, content, JSON.stringify(hunks))
      )
      return true
    } catch (reason) {
      this.error = errorMessage(reason, 'Conflict draft could not be saved')
      return false
    }
  }

  /**
   * Persist a fully-resolved conflict file. Writes the assembled content and
   * stages it so git clears the unmerged entry; refreshes the stored status.
   * Returns true when saved, false when rejected (leftover markers, busy, etc).
   */
  async saveConflictResolution(projectId: string, path: string, content: string): Promise<boolean> {
    this.access.markBusy('stage', true)
    this.error = null
    try {
      this.status = await invoke(
        'git:saveConflictResolution',
        ...this.access.scopedGitArgs(projectId, path, content)
      )
      return true
    } catch (reason) {
      this.error = errorMessage(reason, 'Conflict could not be saved')
      return false
    } finally {
      this.access.markBusy('stage', false)
    }
  }

  /**
   * Mark a single conflicted path resolved once its conflict markers are gone.
   * Staging it tells git the unmerged entry is resolved, which clears it from
   * the conflicted list and refreshes the stored status.
   */
  async resolveConflicted(projectId: string, path: string): Promise<void> {
    this.access.markBusy('stage', true)
    this.error = null
    try {
      this.status = await invoke(
        'git:resolveConflicted',
        ...this.access.scopedGitArgs(projectId, path)
      )
    } catch (reason) {
      this.error = errorMessage(reason, 'Conflict could not be resolved')
    } finally {
      this.access.markBusy('stage', false)
    }
  }

  /**
   * Take one side of every unresolved conflict at once: each conflicted file is
   * replaced with its incoming (theirs) or current (ours) version and staged,
   * so the whole set leaves the conflicted list in one step.
   */
  async acceptConflictSide(projectId: string, side: GitConflictSide): Promise<void> {
    this.access.markBusy('accept-conflicts', true)
    this.error = null
    try {
      this.status = await invoke(
        'git:acceptConflictSide',
        ...this.access.scopedGitArgs(projectId, side)
      )
    } catch (reason) {
      this.error = errorMessage(reason, 'The conflicts could not be resolved')
    } finally {
      this.access.markBusy('accept-conflicts', false)
    }
  }

  async unstage(projectId: string, paths: string[]): Promise<void> {
    this.access.markBusy('unstage', true)
    this.error = null
    try {
      this.status = await invoke('git:unstage', ...this.access.scopedGitArgs(projectId, paths))
    } catch (reason) {
      this.error = errorMessage(reason, 'Files could not be unstaged')
    } finally {
      this.access.markBusy('unstage', false)
    }
  }

  async commit(projectId: string, message: string): Promise<void> {
    this.access.markBusy('commit', true)
    this.error = null
    try {
      const scopeBucketId = this.access.scopeFor(projectId)
      this.status = scopeBucketId
        ? await invoke('git:commit', projectId, message, scopeBucketId)
        : await invoke('git:commit', projectId, message)
    } catch (reason) {
      this.error = errorMessage(reason, 'Commit failed')
    } finally {
      this.access.markBusy('commit', false)
    }
  }

  async initialize(projectId: string): Promise<void> {
    this.access.markBusy('init', true)
    this.error = null
    try {
      this.status = await invoke('git:init', ...this.access.scopedGitArgs(projectId))
    } catch (reason) {
      this.error = errorMessage(reason, 'Repository could not be initialized')
    } finally {
      this.access.markBusy('init', false)
    }
  }

  async checkout(projectId: string, branch: string): Promise<void> {
    this.access.markBusy('checkout', true)
    this.error = null
    try {
      this.status = await invoke('git:checkout', ...this.access.scopedGitArgs(projectId, branch))
      await this.access.refresh(projectId)
    } catch (reason) {
      this.error = errorMessage(reason, 'Checkout failed')
    } finally {
      this.access.markBusy('checkout', false)
    }
  }

  async createBranch(projectId: string, name: string): Promise<void> {
    this.access.markBusy('checkout', true)
    this.error = null
    try {
      this.status = await invoke('git:createBranch', ...this.access.scopedGitArgs(projectId, name))
      await this.access.refresh(projectId)
    } catch (reason) {
      this.error = errorMessage(reason, 'Branch creation failed')
    } finally {
      this.access.markBusy('checkout', false)
    }
  }

  async createTrackingBranch(
    projectId: string,
    remote: string,
    branch: string,
    localName = branch
  ): Promise<void> {
    this.access.markBusy('checkout', true)
    this.error = null
    try {
      this.status = await invoke(
        'git:createTrackingBranch',
        ...this.access.scopedGitArgs(projectId, remote, branch, localName)
      )
      await this.access.refresh(projectId)
    } catch (reason) {
      this.error = errorMessage(reason, 'Remote branch checkout failed')
    } finally {
      this.access.markBusy('checkout', false)
    }
  }

  async deleteBranch(projectId: string, name: string, force = false): Promise<DeleteBranchResult> {
    this.access.markBusy('checkout', true)
    this.error = null
    try {
      this.status = await invoke(
        'git:deleteBranch',
        ...this.access.scopedGitArgs(projectId, name, force)
      )
      await this.access.refresh(projectId)
      return 'deleted'
    } catch (reason) {
      const message = errorMessage(reason, 'Branch deletion failed')
      if (!force && isBranchNotFullyMerged(message)) return 'requires-force'
      this.error = message
      return 'failed'
    } finally {
      this.access.markBusy('checkout', false)
    }
  }

  async deleteRemoteBranch(projectId: string, remote: string, name: string): Promise<void> {
    this.access.markBusy('push', true)
    this.error = null
    try {
      await invoke('git:deleteRemoteBranch', ...this.access.scopedGitArgs(projectId, remote, name))
      await this.access.refresh(projectId)
    } catch (reason) {
      this.error = errorMessage(reason, 'Remote branch deletion failed')
    } finally {
      this.access.markBusy('push', false)
    }
  }

  async setIdentity(projectId: string, name: string, email: string): Promise<void> {
    this.error = null
    try {
      this.identity = await invoke(
        'git:setIdentity',
        ...this.access.scopedGitArgs(projectId, { name, email })
      )
    } catch (reason) {
      this.error = errorMessage(reason, 'Identity could not be saved')
    }
  }

  async getDiff(projectId: string, path: string, staged: boolean): Promise<GitDiff> {
    return invoke('git:diff', ...this.access.scopedGitArgs(projectId, path, staged))
  }

  async fetch(projectId: string): Promise<void> {
    this.access.markBusy('fetch', true)
    this.error = null
    this.access.noteFetchAttempt(projectId)
    try {
      this.status = await invoke('git:fetch', ...this.access.scopedGitArgs(projectId))
      // Branch tracking (ahead/behind) changes with every fetch - refresh it so
      // push decisions (like the PR sheet's "is there anything to push?") are
      // made against freshly fetched remote refs, not the last panel refresh.
      await this.access.refresh(projectId)
    } catch (reason) {
      this.error = errorMessage(reason, 'Fetch failed')
    } finally {
      this.access.markBusy('fetch', false)
    }
  }

  /** Updates one branch's remote-tracking ref only - the working tree is untouched. */
  async fetchBranch(projectId: string, remote: string, branch: string): Promise<void> {
    this.access.markBusy('fetch', true)
    this.error = null
    this.access.noteFetchAttempt(projectId)
    try {
      this.status = await invoke(
        'git:fetchBranch',
        ...this.access.scopedGitArgs(projectId, remote, branch)
      )
      await this.access.refresh(projectId)
    } catch (reason) {
      this.error = errorMessage(reason, 'Fetch failed')
    } finally {
      this.access.markBusy('fetch', false)
    }
  }

  async pull(projectId: string): Promise<void> {
    this.access.markBusy('pull', true)
    this.error = null
    // A pull fetches the upstream before it integrates, so the refs it moved
    // count towards the panel-open gate.
    this.access.noteFetchAttempt(projectId)
    try {
      this.status = await invoke('git:pull', ...this.access.scopedGitArgs(projectId))
      // A pull moves remote-tracking refs, so re-read branches and their
      // ahead/behind counts instead of leaving the panel showing stale ones.
      await this.access.refresh(projectId)
    } catch (reason) {
      this.error = errorMessage(reason, 'Pull failed')
    } finally {
      this.access.markBusy('pull', false)
    }
  }

  async push(
    projectId: string,
    setUpstream: boolean,
    remote?: string,
    branch?: string
  ): Promise<GitPushResult> {
    this.access.markBusy('push', true)
    this.error = null
    try {
      const options = { setUpstream, remote, branch }
      const scopeBucketId = this.access.scopeFor(projectId)
      this.status = scopeBucketId
        ? await invoke('git:push', projectId, options, scopeBucketId)
        : await invoke('git:push', projectId, options)
      await this.access.refresh(projectId)
      // Pushing changes what GitHub computes for the branch - force a fresh
      // conflict check instead of waiting for the next thread open.
      this.access.refreshConflictIndicators(projectId, true)
      return { status: 'pushed' }
    } catch (reason) {
      const message = errorMessage(reason, 'Push failed')
      // A non-fast-forward rejection is not a failure - the panel turns it into
      // the "pull & push" recovery dialog instead of a scary error banner.
      if (isPushRejected(message)) return { status: 'rejected', message }
      this.error = message
      return { status: 'failed', message }
    } finally {
      this.access.markBusy('push', false)
    }
  }

  /**
   * Pull a specific remote branch with an explicit strategy, then surface the
   * refreshed status. A pull that stops on conflicts is a normal state; the
   * panel hands over to the conflict UI and never auto-pushes.
   */
  async pullIntegrate(
    projectId: string,
    remote: string,
    branch: string,
    strategy: GitPullStrategy
  ): Promise<void> {
    this.access.markBusy('pull', true)
    this.error = null
    try {
      const options = { remote, branch, strategy }
      const scopeBucketId = this.access.scopeFor(projectId)
      this.status = scopeBucketId
        ? await invoke('git:pullIntegrate', projectId, options, scopeBucketId)
        : await invoke('git:pullIntegrate', projectId, options)
      // Same reason as pull: a pull moves remote-tracking refs, so the branch
      // list and its ahead/behind counts have to be re-read.
      await this.access.refresh(projectId)
    } catch (reason) {
      const fallback =
        strategy === 'rebase'
          ? 'Pull with rebase failed'
          : strategy === 'ff-only'
            ? 'Fast-forward pull failed'
            : 'Pull with merge failed'
      this.error = errorMessage(reason, fallback)
    } finally {
      this.access.markBusy('pull', false)
    }
  }

  /**
   * Every checkout and branch this project can sync with, as main names them.
   * The picker renders exactly this list and hands the chosen peer back
   * untouched, so main and the UI can never disagree about what an end is.
   */
  async syncPeers(projectId: string, scopeBucketId?: string): Promise<GitSyncPeerOption[]> {
    return scopeBucketId
      ? invoke('git:syncPeers', projectId, scopeBucketId)
      : invoke('git:syncPeers', projectId)
  }

  /**
   * Sync one checkout with another end, in either direction. Main resolves both
   * ends, so the renderer only names them and picks the reconciliation
   * strategy. A conflicted integration is a normal outcome, not an error: the
   * returned status carries the conflicts and the caller hands over to the
   * conflict UI.
   *
   * A refusal (uncommitted work, a detached HEAD, an open integration, a peer
   * that cannot receive commits) arrives as `{ ok: false }` rather than as a
   * rejection, because Electron logs every rejected invoke as a console error;
   * either way it lands in `error`, which is exactly what the sync dialogs
   * render.
   *
   * `scopeBucketId` is the checkout the sync runs in, which is not always the
   * active one: a scope's own menu syncs that scope's worktree while the panel
   * shows something else. Only a run in the active checkout may touch the
   * status this store shows.
   */
  async syncWith(
    projectId: string,
    scopeBucketId: string | undefined,
    options: { direction: GitSyncDirection; peer: GitSyncPeer; strategy: GitPullStrategy }
  ): Promise<GitSyncResult | null> {
    this.access.markBusy('sync', true)
    this.error = null
    try {
      const outcome = scopeBucketId
        ? await invoke('git:syncWith', projectId, options, scopeBucketId)
        : await invoke('git:syncWith', projectId, options)
      if (!outcome.ok) {
        this.error = outcome.refusal
        return null
      }
      const result = outcome.result
      if (this.access.scopeFor(projectId) === scopeBucketId) {
        this.status = result.status
        if (result.status.conflicted.length === 0) this.conflictsMode = false
      }
      return result
    } catch (reason) {
      const toward = options.direction === 'from' ? 'from' : 'to'
      this.error = errorMessage(
        reason,
        options.strategy === 'rebase'
          ? `Syncing ${toward} that branch with rebase failed`
          : options.strategy === 'ff-only'
            ? `Syncing ${toward} that branch with a fast-forward failed`
            : `Syncing ${toward} that branch with a merge failed`
      )
      return null
    } finally {
      this.access.markBusy('sync', false)
    }
  }

  async addRemote(projectId: string, name: string, url: string): Promise<void> {
    this.error = null
    try {
      this.remotes = await invoke(
        'git:addRemote',
        ...this.access.scopedGitArgs(projectId, name, url)
      )
    } catch (reason) {
      this.error = errorMessage(reason, 'Remote could not be added')
    }
  }

  async setRemoteUrl(projectId: string, name: string, url: string): Promise<void> {
    this.error = null
    try {
      this.remotes = await invoke(
        'git:setRemoteUrl',
        ...this.access.scopedGitArgs(projectId, name, url)
      )
    } catch (reason) {
      this.error = errorMessage(reason, 'Remote URL could not be updated')
    }
  }

  async removeRemote(projectId: string, name: string): Promise<void> {
    this.error = null
    try {
      this.remotes = await invoke('git:removeRemote', ...this.access.scopedGitArgs(projectId, name))
    } catch (reason) {
      this.error = errorMessage(reason, 'Remote could not be removed')
    }
  }

  async setCredential(projectId: string, token: string): Promise<void> {
    this.error = null
    try {
      this.credentialStatus = await invoke('git:setCredential', projectId, token)
    } catch (reason) {
      this.error = errorMessage(reason, 'Credential could not be stored')
    }
  }

  async removeCredential(projectId: string): Promise<void> {
    this.error = null
    try {
      this.credentialStatus = await invoke('git:removeCredential', projectId)
    } catch (reason) {
      this.error = errorMessage(reason, 'Credential could not be removed')
    }
  }

  async merge(projectId: string, target: string): Promise<MergeSummary | null> {
    this.access.markBusy('merge', true)
    this.error = null
    try {
      const summary = await invoke('git:merge', ...this.access.scopedGitArgs(projectId, target))
      this.status = await this.access.readStatus(projectId)
      return summary
    } catch (reason) {
      this.error = errorMessage(reason, 'Merge failed')
      return null
    } finally {
      this.access.markBusy('merge', false)
    }
  }

  async rebase(projectId: string, target: string): Promise<MergeSummary | null> {
    this.access.markBusy('rebase', true)
    this.error = null
    try {
      const summary = await invoke('git:rebase', ...this.access.scopedGitArgs(projectId, target))
      this.status = await this.access.readStatus(projectId)
      return summary
    } catch (reason) {
      this.error = errorMessage(reason, 'Rebase failed')
      return null
    } finally {
      this.access.markBusy('rebase', false)
    }
  }

  async abortMerge(projectId: string): Promise<void> {
    this.access.markBusy('abortMerge', true)
    this.error = null
    try {
      this.status = await invoke('git:abortMerge', ...this.access.scopedGitArgs(projectId))
    } catch (reason) {
      this.error = errorMessage(reason, 'Merge abort failed')
    } finally {
      this.access.markBusy('abortMerge', false)
    }
  }

  async abortRebase(projectId: string): Promise<void> {
    this.access.markBusy('abortRebase', true)
    this.error = null
    try {
      this.status = await invoke('git:abortRebase', ...this.access.scopedGitArgs(projectId))
    } catch (reason) {
      this.error = errorMessage(reason, 'Rebase abort failed')
    } finally {
      this.access.markBusy('abortRebase', false)
    }
  }

  /**
   * Move a stopped rebase along: continue it, or skip the commit git stopped
   * on. A rebase can stop again on the next commit's conflict, which is a normal
   * state rather than an error, so the refreshed status is what the panel shows.
   */
  async rebaseAction(projectId: string, action: GitRebaseAction): Promise<void> {
    this.access.markBusy('rebase-action', true)
    this.error = null
    try {
      this.status = await invoke(
        'git:rebaseAction',
        ...this.access.scopedGitArgs(projectId, action)
      )
    } catch (reason) {
      this.error = errorMessage(
        reason,
        action === 'continue' ? 'The rebase could not continue' : 'The commit could not be skipped'
      )
    } finally {
      this.access.markBusy('rebase-action', false)
    }
  }

  /**
   * Prepare to resolve a PR's online conflicts locally: checks out the PR head
   * as `pr-<number>` and merges the base in so the conflicts land in the working
   * tree. A conflicted result is normal and is not reported as an error - the
   * panel hands over to the conflict UI. Records the session so the Resolve
   * button can finish the whole flow without manual follow-up.
   */
  async preparePrResolve(projectId: string, options: PrResolveOptions): Promise<void> {
    this.access.markBusy('merge', true)
    this.error = null
    try {
      this.status = await invoke(
        'git:preparePrResolve',
        ...this.access.scopedGitArgs(projectId, options)
      )
      this.prResolveSession = { ...options, projectId }
      await this.access.refresh(projectId)
    } catch (reason) {
      this.error = errorMessage(reason, 'Could not prepare PR conflict resolution')
    } finally {
      this.access.markBusy('merge', false)
    }
  }

  /**
   * Finish a recorded PR-conflict session: push the resolved merge commit back
   * to the PR's head branch, check out the user's original branch, and delete
   * the temporary `pr-<n>` branch. Only meaningful after the merge commit was
   * made and `prResolveSession` still matches this project.
   */
  async finishPrResolve(projectId: string): Promise<boolean> {
    const session = this.prResolveSession
    if (!session || session.projectId !== projectId) return false
    this.access.markBusy('push', true)
    this.error = null
    try {
      const { projectId: _sessionProjectId, ...options } = session
      this.status = await invoke(
        'git:finishPrResolve',
        ...this.access.scopedGitArgs(projectId, options)
      )
      this.prResolveSession = null
      await this.access.refresh(projectId)
      return true
    } catch (reason) {
      this.error = errorMessage(reason, 'Could not finish the PR conflict resolution')
      return false
    } finally {
      this.access.markBusy('push', false)
    }
  }

  async stash(projectId: string, message?: string, paths?: string[]): Promise<void> {
    this.access.markBusy('stash', true)
    this.error = null
    try {
      this.status = await invoke(
        'git:stash',
        ...this.access.scopedGitArgs(projectId, message, paths)
      )
      this.stashes = await invoke('git:stashList', ...this.access.scopedGitArgs(projectId))
    } catch (reason) {
      this.error = errorMessage(reason, 'Stash failed')
    } finally {
      this.access.markBusy('stash', false)
    }
  }

  async ignore(projectId: string, paths: string[]): Promise<void> {
    this.access.markBusy('ignore', true)
    this.error = null
    try {
      this.status = await invoke('git:ignore', ...this.access.scopedGitArgs(projectId, paths))
    } catch (reason) {
      this.error = errorMessage(reason, 'Files could not be ignored')
    } finally {
      this.access.markBusy('ignore', false)
    }
  }

  async discard(projectId: string, paths: string[]): Promise<void> {
    this.access.markBusy('discard', true)
    this.error = null
    try {
      this.status = await invoke('git:discard', ...this.access.scopedGitArgs(projectId, paths))
    } catch (reason) {
      this.error = errorMessage(reason, 'Changes could not be discarded')
    } finally {
      this.access.markBusy('discard', false)
    }
  }

  async popStash(projectId: string, id?: string): Promise<void> {
    this.access.markBusy('stash-pop', true)
    this.error = null
    try {
      this.status = await invoke('git:stashPop', ...this.access.scopedGitArgs(projectId, id))
      this.stashes = await invoke('git:stashList', ...this.access.scopedGitArgs(projectId))
    } catch (reason) {
      this.error = errorMessage(reason, 'Stash pop failed')
    } finally {
      this.access.markBusy('stash-pop', false)
    }
  }

  async dropStash(projectId: string, id?: string): Promise<void> {
    this.access.markBusy('stash-drop', true)
    this.error = null
    try {
      this.status = await invoke('git:stashDrop', ...this.access.scopedGitArgs(projectId, id))
      this.stashes = await invoke('git:stashList', ...this.access.scopedGitArgs(projectId))
    } catch (reason) {
      this.error = errorMessage(reason, 'Stash drop failed')
    } finally {
      this.access.markBusy('stash-drop', false)
    }
  }

  async getLog(
    projectId: string,
    limit = 30,
    offset = 0,
    query?: string
  ): Promise<GitCommitInfo[]> {
    try {
      return await invoke('git:log', ...this.access.scopedGitArgs(projectId, limit, offset, query))
    } catch {
      return []
    }
  }

  async getCommitDiff(projectId: string, hash: string): Promise<GitFileChange[]> {
    try {
      return await invoke('git:commitDiff', ...this.access.scopedGitArgs(projectId, hash))
    } catch {
      return []
    }
  }

  async getCommitFileDiff(projectId: string, hash: string, path: string): Promise<GitDiff> {
    return invoke('git:commitFileDiff', ...this.access.scopedGitArgs(projectId, hash, path))
  }

  async getStashDiff(projectId: string, id: string): Promise<GitFileChange[]> {
    try {
      return await invoke('git:stashDiff', ...this.access.scopedGitArgs(projectId, id))
    } catch {
      return []
    }
  }

  async getStashFileDiff(projectId: string, id: string, path: string): Promise<GitDiff> {
    return invoke('git:stashFileDiff', ...this.access.scopedGitArgs(projectId, id, path))
  }

  /** Restore files from a commit-like source back into the index and/or working tree. */
  async restoreFiles(
    projectId: string,
    source: string,
    paths: string[],
    target: GitRestoreTarget
  ): Promise<void> {
    this.access.markBusy('restore-files', true)
    try {
      await invoke(
        'git:restoreFiles',
        ...this.access.scopedGitArgs(projectId, source, paths, target)
      )
      await this.access.refresh(projectId)
    } finally {
      this.access.markBusy('restore-files', false)
    }
  }

  async amend(projectId: string, message: string): Promise<void> {
    this.access.markBusy('amend', true)
    this.error = null
    try {
      this.status = await invoke('git:amend', ...this.access.scopedGitArgs(projectId, message))
    } catch (reason) {
      this.error = errorMessage(reason, 'Amend failed')
    } finally {
      this.access.markBusy('amend', false)
    }
  }

  async reset(projectId: string, mode: GitResetMode, target?: string): Promise<void> {
    this.access.markBusy('reset', true)
    this.error = null
    try {
      this.status = await invoke('git:reset', ...this.access.scopedGitArgs(projectId, mode, target))
    } catch (reason) {
      this.error = errorMessage(reason, 'Reset failed')
    } finally {
      this.access.markBusy('reset', false)
    }
  }

  async deleteCommit(projectId: string, target: string): Promise<void> {
    this.access.markBusy('delete-commit', true)
    this.error = null
    try {
      this.status = await invoke(
        'git:deleteCommit',
        ...this.access.scopedGitArgs(projectId, target)
      )
    } catch (reason) {
      this.error = errorMessage(reason, 'Commit could not be deleted')
    } finally {
      this.access.markBusy('delete-commit', false)
    }
  }
}
