import type {
  GitIntegrationProbe,
  GitPullStrategy,
  GitRemoteInfo,
  GitStatus,
  GitSyncDirection,
  GitSyncPeerTarget,
  GitSyncResult,
  GitSyncSummary
} from '../../../lib/types'
import { Logger } from '../../system/logger'
import { GitRefusal, isUncommittedChangesRefusal } from '../git-refusal'
import type { GitServiceCore } from './git-service-core'
import { isAncestor } from './git-service-diffs'
import { withIndexLockRetry } from './git-service-runtime'

/**
 * Tracked, not-yet-committed files in a checkout: what a rebase refuses and a
 * merge only tolerates while nothing would be overwritten. Untracked files are
 * excluded because no integration ever touches them.
 */
function uncommittedCount(status: GitStatus): number {
  return status.changes.filter((change) => change.status !== 'untracked').length
}

/**
 * Remote round trips and cross-checkout sync: pull, push, and the peer sync that
 * folds one checkout's committed work into another.
 *
 * A conflicted integration is never an error here   it comes back as the
 * refreshed status so the panel hands over to the conflict UI   and a
 * cross-checkout move fails closed before a single ref moves when either end is
 * dirty, detached, or mid-integration.
 */
export class GitServiceSync {
  constructor(private readonly core: GitServiceCore) {}

  async pull(projectPath: string): Promise<GitStatus> {
    return this.core.enqueue(projectPath, async () => {
      const directory = await this.core.repo(projectPath)
      // A pull fetches before it integrates, so it takes the remote lane for the
      // round trip rather than running beside a fetch that is moving the same
      // remote-tracking refs.
      await this.core.enqueueRemote(projectPath, () =>
        this.core.wrapError(projectPath, 'mutation', async () => {
          await this.core.client(directory).pull()
        })
      )
      return this.core.readStatus(directory)
    })
  }

  /**
   * Pull a specific remote branch with an explicit reconciliation strategy and
   * return the refreshed status even when the integration stops on conflicts.
   *
   * The push-recovery flow needs to distinguish "pulled cleanly, safe to push"
   * from "stopped on conflicts, hand over to the conflict UI". A conflicted
   * pull is not an error   it returns the conflicted status so the renderer
   * can show the merge/rebase conflict banner and never auto-push a half-merged
   * tree. Only genuine failures (network, auth, no upstream) throw.
   */
  async pullIntegrate(
    projectPath: string,
    options: {
      remote?: string
      branch?: string
      strategy: GitPullStrategy
      token?: string
    }
  ): Promise<GitStatus> {
    return this.core.enqueue(projectPath, async () => {
      const directory = await this.core.repo(projectPath)
      const args: string[] = []
      if (options.strategy === 'rebase') args.push('--rebase')
      else if (options.strategy === 'ff-only') args.push('--ff-only')
      else args.push('--no-rebase')
      if (options.remote) args.push(options.remote)
      if (options.branch) args.push(options.branch)
      const git = options.token
        ? this.core.withAuthHeader(directory, options.token)
        : this.core.client(directory)
      try {
        // The round trip is the only part that talks to the remote, so it takes
        // the remote lane; the conflicted-status read and the error mapping in
        // the catch below are local and stay on this lane.
        await this.core.enqueueRemote(projectPath, () => git.pull(args))
      } catch (failure) {
        const status = await this.core.readStatus(directory).catch(() => null)
        if (status && status.conflicted.length > 0) return status
        await this.core.wrapError(projectPath, 'mutation', async () => {
          throw failure
        })
      }
      return this.core.readStatus(directory)
    })
  }

  async push(
    projectPath: string,
    options: { setUpstream: boolean; remote?: string; branch?: string; token?: string } = {
      setUpstream: false
    }
  ): Promise<GitStatus> {
    return this.core.enqueue(projectPath, async () => {
      const directory = await this.core.repo(projectPath)
      // Push decides from the remote-tracking refs whether it is a fast-forward
      // and whether there is anything to send at all, so it takes the remote
      // lane: a fetch in flight finishes first, and one asked for now waits for
      // this push. This is the one local operation the panel blocks on a fetch.
      await this.core.enqueueRemote(projectPath, () =>
        this.core.wrapError(projectPath, 'mutation', async () => {
          const args: string[] = []
          if (options.setUpstream) args.push('--set-upstream')
          if (options.remote) args.push(options.remote)
          if (options.branch) args.push(options.branch)
          const git = options.token
            ? this.core.withAuthHeader(directory, options.token)
            : this.core.client(directory)
          await git.push(args)
        })
      )
      return this.core.readStatus(directory)
    })
  }

  /**
   * Sync this checkout with another end, in either direction. The other end is a
   * peer: another checkout (the project root, or a managed worktree) or a named
   * local branch. "Sync with main" is the peer that is the project root, so both
   * of those flows share this one implementation instead of drifting apart.
   *
   * `from` reads the peer and writes this checkout: the peer branch's
   * remote-tracking ref is refreshed first, then integrated. The remote-tracking
   * ref is preferred only when it strictly contains the local branch - i.e. the
   * other checkout has not pulled yet. Otherwise the local branch wins, so
   * commits that exist only in the other checkout are never silently skipped. A
   * failed remote refresh is reported through `fetched: false`, never treated as
   * fatal: the local branch is still the repository's authoritative state when
   * the network is unavailable.
   *
   * `to` reads this checkout and writes the peer: this branch's commits are
   * folded into the branch the peer has checked out. It needs a real checkout to
   * receive them, and nothing is ever pushed - publishing stays an explicit user
   * action.
   *
   * Both directions fail closed instead of guessing: a peer that is this very
   * checkout, a detached HEAD, or an integration already in progress all throw
   * before a single ref moves. A conflicted integration is not an error - the
   * refreshed status is returned so the renderer hands over to the conflict UI.
   *
   * The whole operation holds this checkout's queue, and both ends are mutated
   * under it; two cross-syncs in opposite directions would still serialise, which
   * is why a nested acquisition of the peer's queue is deliberately not taken.
   */
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
    return this.core.enqueue(projectPath, async () => {
      const directory = await this.core.repo(projectPath)
      const peerDirectory = options.peer.path ? await this.core.repo(options.peer.path) : null
      const toward = options.direction === 'from' ? 'from' : 'to'
      if (peerDirectory === directory) {
        throw new GitRefusal(
          options.direction === 'from'
            ? `This checkout is ${options.peer.label}, so there is nothing to sync from`
            : `This checkout is ${options.peer.label}, so it cannot be synced to itself`
        )
      }

      const before = await this.core.readStatus(directory)
      // The in-progress integration is reported first because a rebase leaves
      // HEAD detached: checking the branch first answers a user who is sitting
      // on a conflict in a branch they do have with "check out a branch", which
      // is the dead end, and the branch name is recoverable from the rebase's
      // own state. A merge keeps HEAD on the branch, so for it the two checks
      // agree either way.
      if (before.conflictState !== 'none') {
        throw new GitRefusal(
          `Finish or abort the in-progress ${before.conflictState} before syncing ${toward} ${options.peer.label}`
        )
      }
      if (before.detached || !before.branch) {
        throw new GitRefusal(
          `Check out a branch in this worktree before syncing ${toward} ${options.peer.label}`
        )
      }
      const branch = before.branch

      if (options.direction === 'to') {
        if (!peerDirectory) {
          throw new GitRefusal(
            `${options.peer.label} is not a checkout, so it cannot receive commits. Pick a worktree or the project root to sync to`
          )
        }
        return await this.foldIntoPeer(directory, peerDirectory, before, branch, options)
      }

      const sourceBranch = peerDirectory
        ? await this.branchOfCheckout(peerDirectory, options.peer.label)
        : options.peer.branch
      if (!sourceBranch) {
        throw new GitRefusal(`${options.peer.label} has no branch to sync from`)
      }
      if (!peerDirectory) {
        const exists = await this.core.wrapError(projectPath, 'read', () =>
          this.core.refExists(this.core.client(directory), `refs/heads/${sourceBranch}`)
        )
        if (!exists) {
          throw new GitRefusal(`The branch ${sourceBranch} does not exist in this repository`)
        }
      }

      const remoteName = options.remote ?? (await this.primaryRemoteName(directory))
      let fetched = false
      if (remoteName) {
        try {
          const git = options.token
            ? this.core.withAuthHeader(directory, options.token)
            : this.core.client(directory)
          // Through the remote lane, so this refresh cannot overlap a fetch the
          // panel started. The integration that follows is local and stays on
          // this lane.
          await this.core.enqueueRemote(projectPath, () =>
            withIndexLockRetry(directory, () => git.fetch(remoteName, sourceBranch))
          )
          fetched = true
        } catch (failure) {
          // Reported as `fetched: false` - the local branch is still synced.
          Logger.dev(
            `Sync ${toward} ${options.peer.label}: refreshing ${remoteName}/${sourceBranch} failed: ${
              failure instanceof Error ? failure.message : String(failure)
            }`
          )
        }
      }

      const localRef = `refs/heads/${sourceBranch}`
      const remoteRef = remoteName ? `refs/remotes/${remoteName}/${sourceBranch}` : null
      const ref = await this.pickSyncSourceRef(directory, projectPath, localRef, remoteRef)
      const incoming = await this.countCommitsAhead(directory, projectPath, ref)
      let probe: GitIntegrationProbe = {
        danglingReferences: [],
        changedDependencyManifests: []
      }
      if (incoming > 0) {
        const uncommitted = uncommittedCount(before)
        // A rebase refuses any tracked change outright, so answer before git
        // does: its own wording ("cannot rebase: You have unstaged changes...")
        // names the mechanism instead of what the user has to do about it.
        if (options.strategy === 'rebase' && uncommitted > 0) {
          throw new GitRefusal(
            `This checkout has ${uncommitted} uncommitted file${uncommitted === 1 ? '' : 's'}. Commit or stash ${uncommitted === 1 ? 'it' : 'them'} before syncing from ${options.peer.label}`
          )
        }
        const beforeSha = await this.headSha(directory)
        let outcome: 'done' | 'conflicted'
        try {
          outcome = await this.integrateFromRef(directory, projectPath, ref, options.strategy)
        } catch (failure) {
          // A merge or fast-forward only refuses for local changes that would
          // be overwritten, and git answers with the same advice in its own
          // words. Report the count the refusal is about in the panel's voice.
          if (uncommitted > 0 && isUncommittedChangesRefusal(failure)) {
            throw new GitRefusal(
              `This checkout has ${uncommitted} uncommitted file${uncommitted === 1 ? '' : 's'} that would be overwritten. Commit or stash ${uncommitted === 1 ? 'it' : 'them'} before syncing from ${options.peer.label}`
            )
          }
          throw failure
        }
        // A conflicted integration is reconciled by hand first, and probing a
        // half-applied tree would describe the mess rather than the result.
        if (outcome === 'done') {
          probe = await this.probeIntegration(directory, projectPath, beforeSha)
        }
      }

      return {
        status: await this.core.readStatus(directory),
        direction: 'from',
        branch,
        peerBranch: sourceBranch,
        peerLabel: options.peer.label,
        ref: ref === remoteRef && remoteName ? `${remoteName}/${sourceBranch}` : sourceBranch,
        fetched,
        remote: remoteName ?? null,
        incoming,
        peerAhead: 0,
        danglingReferences: probe.danglingReferences,
        changedDependencyManifests: probe.changedDependencyManifests
      }
    })
  }

  /** The branch a peer checkout has checked out, refusing a detached HEAD. */
  private async branchOfCheckout(directory: string, label: string): Promise<string> {
    const resolved = (
      await this.core.client(directory).raw(['rev-parse', '--abbrev-ref', 'HEAD'])
    ).trim()
    if (!resolved || resolved === 'HEAD') {
      throw new GitRefusal(`${label} is not on a branch, so there is nothing to sync from`)
    }
    return resolved
  }

  /**
   * Fold this worktree's branch into the branch the peer checkout has checked
   * out ("Sync to" the peer).
   *
   * Both checkouts must be committed and idle first: only committed work can
   * move, so uncommitted work would silently stay behind, and a clean target is
   * what makes rolling a refused merge back exact.
   *
   * `rebase` keeps the peer linear without rewriting it: this branch's commits
   * are replayed on top of the peer's branch (a conflict stays here, in the
   * checkout the panel shows, just like `from`), then the peer branch
   * fast-forwards onto the rebased branch. `merge`/`ff-only` integrate directly
   * in the peer, and a merge that conflicts is rolled back before the error
   * surfaces - a one-click action run from a worktree scope must never leave
   * another checkout mid-merge where the user is not looking.
   */
  private async foldIntoPeer(
    directory: string,
    peerDirectory: string,
    before: GitStatus,
    branch: string,
    options: { direction: GitSyncDirection; peer: GitSyncPeerTarget; strategy: GitPullStrategy }
  ): Promise<GitSyncResult> {
    const label = options.peer.label
    const dirty = uncommittedCount(before)
    if (dirty > 0) {
      throw new GitRefusal(
        `This checkout has ${dirty} uncommitted file${dirty === 1 ? '' : 's'}. Commit or stash ${dirty === 1 ? 'it' : 'them'} before syncing to ${label}`
      )
    }

    const peerStatus = await this.core.readStatus(peerDirectory)
    // Same order as the worktree's own check: a rebase in the peer also detaches
    // its HEAD, and "not on a branch" is not what the user needs to hear while
    // its rebase is sitting half-finished.
    if (peerStatus.conflictState !== 'none') {
      throw new GitRefusal(
        `Finish or abort the in-progress ${peerStatus.conflictState} in ${label} before syncing to it`
      )
    }
    if (peerStatus.detached || !peerStatus.branch) {
      throw new GitRefusal(`${label} is not on a branch, so there is nothing to sync to`)
    }
    const peerBranch = peerStatus.branch
    const peerDirty = uncommittedCount(peerStatus)
    if (peerDirty > 0) {
      throw new GitRefusal(
        `${label} has ${peerDirty} uncommitted file${peerDirty === 1 ? '' : 's'}. Commit or stash ${peerDirty === 1 ? 'it' : 'them'} there before syncing to it`
      )
    }

    const incoming = await this.countCommitsAhead(
      peerDirectory,
      options.peer.path ?? peerDirectory,
      branch
    )
    // The commits land in the peer, so the peer is the checkout to probe.
    const peerBeforeSha = await this.headSha(peerDirectory)
    let conflicted = false
    if (incoming > 0) {
      if (options.strategy === 'rebase') {
        const outcome = await this.integrateFromRef(
          directory,
          options.peer.path ?? directory,
          `refs/heads/${peerBranch}`,
          'rebase'
        )
        conflicted = outcome === 'conflicted'
        if (!conflicted) {
          await this.foldIntoPeerBranch(peerDirectory, branch, peerBranch, label, 'ff-only')
        }
      } else {
        await this.foldIntoPeerBranch(peerDirectory, branch, peerBranch, label, options.strategy)
      }
    }

    const probe: GitIntegrationProbe =
      incoming > 0 && !conflicted
        ? await this.probeIntegration(
            peerDirectory,
            options.peer.path ?? peerDirectory,
            peerBeforeSha
          )
        : { danglingReferences: [], changedDependencyManifests: [] }
    return {
      status: await this.core.readStatus(directory),
      direction: 'to',
      branch,
      peerBranch,
      peerLabel: label,
      ref: branch,
      fetched: false,
      remote: null,
      incoming,
      peerAhead:
        incoming > 0 && !conflicted
          ? (await this.core.readStatus(peerDirectory)).ahead
          : peerStatus.ahead,
      danglingReferences: probe.danglingReferences,
      changedDependencyManifests: probe.changedDependencyManifests
    }
  }

  /**
   * Integrate `branch` into the branch checked out in the peer checkout. The
   * caller guarantees a clean, idle target, so a conflicted merge can be rolled
   * back exactly instead of stranding the peer mid-merge.
   */
  private async foldIntoPeerBranch(
    peerDirectory: string,
    branch: string,
    peerBranch: string,
    label: string,
    strategy: 'merge' | 'ff-only'
  ): Promise<void> {
    const git = this.core.client(peerDirectory)
    const args = strategy === 'ff-only' ? ['--no-edit', '--ff-only', branch] : ['--no-edit', branch]
    const failure = await git.merge(args).then(
      () => null,
      (error: unknown) => error
    )
    if (!failure) return

    const conflicted = await git.status().then(
      (status) => status.conflicted.length > 0,
      () => false
    )
    if (conflicted) {
      const rolledBack = await git.raw(['merge', '--abort']).then(
        () => true,
        () => false
      )
      throw new GitRefusal(
        rolledBack
          ? `Merging ${branch} into ${peerBranch} would conflict. Sync from ${label} in this worktree, resolve the conflicts here, then sync to it again`
          : `Merging ${branch} into ${peerBranch} conflicted and could not be rolled back. Resolve it in ${label} first`
      )
    }
    if (strategy === 'ff-only') {
      throw new GitRefusal(
        `${peerBranch} has diverged from ${branch}, so it cannot fast-forward. Merge instead`
      )
    }
    await this.core.wrapError(peerDirectory, 'mutation', async () => {
      throw failure
    })
  }

  /** `origin` when present, else the repository's first configured remote. */
  private async primaryRemoteName(directory: string): Promise<string | null> {
    const remotes = await this.core.readRemotes(directory).catch(() => [] as GitRemoteInfo[])
    return remotes.find((remote) => remote.name === 'origin')?.name ?? remotes[0]?.name ?? null
  }

  /**
   * The exact ref to integrate: the remote-tracking ref when it strictly
   * contains the local branch, else the local branch itself.
   */
  private async pickSyncSourceRef(
    directory: string,
    projectPath: string,
    localRef: string,
    remoteRef: string | null
  ): Promise<string> {
    if (!remoteRef) return localRef
    const git = this.core.client(directory)
    return this.core.wrapError(projectPath, 'read', async () => {
      if (!(await this.core.refExists(git, remoteRef))) return localRef
      if (!(await this.core.refExists(git, localRef))) return remoteRef
      return (await isAncestor(git, localRef, remoteRef)) ? remoteRef : localRef
    })
  }

  /** Commits reachable from `ref` that this checkout does not have yet. */
  private async countCommitsAhead(
    directory: string,
    projectPath: string,
    ref: string
  ): Promise<number> {
    return this.core.wrapError(projectPath, 'read', async () => {
      const output = await this.core.client(directory).raw(['rev-list', '--count', `HEAD..${ref}`])
      const parsed = Number.parseInt(output.trim(), 10)
      return Number.isInteger(parsed) && parsed > 0 ? parsed : 0
    })
  }

  /** The commit a checkout is on, or null when it has no commit to read. */
  private async headSha(directory: string): Promise<string | null> {
    return await this.core
      .client(directory)
      .raw(['rev-parse', 'HEAD'])
      .then((sha) => sha.trim() || null)
      .catch(() => null)
  }

  /**
   * Ask what an integration just did to `directory`, beyond whether git was
   * happy with it: does anything still import a module it removed, and did it
   * rewrite a dependency manifest without installing anything?
   *
   * Read-only and best-effort. A probe that fails must never turn a completed
   * sync into an error, so it degrades to an empty result and says why in the
   * dev log.
   */
  private async probeIntegration(
    directory: string,
    projectPath: string,
    beforeSha: string | null
  ): Promise<GitIntegrationProbe> {
    const nothing: GitIntegrationProbe = {
      danglingReferences: [],
      changedDependencyManifests: []
    }
    if (!beforeSha) return nothing
    try {
      // The probe reads every tracked source file of the checkout, so its module
      // is imported only once an integration actually removed something, instead
      // of sitting in the always-loaded feature-IPC graph. That also keeps the
      // feature-IPC graph emit-able: with this probe inside it, Vite 8's
      // rolldown rendered the whole graph as an empty chunk (see
      // refuseEmptyChunks in electron.vite.config.ts).
      const { changedDependencyManifests, findDanglingReferences, integrationChanges } =
        await import('./git-service-references')
      const git = this.core.client(directory)
      const changes = await integrationChanges(git, beforeSha, await this.headSha(directory))
      return {
        danglingReferences:
          changes.deleted.length === 0
            ? []
            : await findDanglingReferences(directory, changes.deleted, git),
        changedDependencyManifests: changedDependencyManifests(changes)
      }
    } catch (failure) {
      Logger.dev(
        `Post-integration probe for ${projectPath} failed: ${
          failure instanceof Error ? failure.message : String(failure)
        }`
      )
      return nothing
    }
  }

  /**
   * Integrate `ref` with the requested strategy. A conflicted merge/rebase is
   * left in the working tree for the conflict UI (never aborted) and reported
   * as `conflicted`; a diverged fast-forward fails with an actionable message
   * instead of raw git output.
   */
  private async integrateFromRef(
    directory: string,
    projectPath: string,
    ref: string,
    strategy: GitPullStrategy
  ): Promise<'done' | 'conflicted'> {
    const git = this.core.client(directory)
    const conflicted = async (): Promise<boolean> =>
      await git
        .status()
        .then((status) => status.conflicted.length > 0)
        .catch(() => false)

    if (strategy === 'rebase') {
      const failure = await git.rebase([ref]).then(
        () => null,
        (error: unknown) => error
      )
      if (!failure) return 'done'
      if (await conflicted()) return 'conflicted'
      return await this.failIntegration(projectPath, failure)
    }

    const args = strategy === 'ff-only' ? ['--no-edit', '--ff-only', ref] : ['--no-edit', ref]
    const failure = await git.merge(args).then(
      () => null,
      (error: unknown) => error
    )
    if (!failure) return 'done'
    if (await conflicted()) return 'conflicted'
    if (strategy === 'ff-only') {
      throw new GitRefusal(
        `This branch has diverged from ${ref}, so it cannot fast-forward. Merge or rebase instead`
      )
    }
    return await this.failIntegration(projectPath, failure)
  }

  /** Re-report a failed integration through the standard error path. */
  private async failIntegration(label: string, failure: unknown): Promise<never> {
    return this.core.wrapError(label, 'mutation', async (): Promise<never> => {
      throw failure
    })
  }

  async syncSummary(projectPath: string): Promise<GitSyncSummary> {
    const status = await this.core.getStatus(projectPath)
    return { ahead: status.ahead, behind: status.behind }
  }
}
