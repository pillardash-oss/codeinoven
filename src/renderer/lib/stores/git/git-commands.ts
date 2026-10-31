import { invoke } from '$lib/ipc.svelte'
import { errorMessage } from '../git-store-helpers'
import { GitLocalOperations } from '../git-store-local-operations.svelte'
import type {
  GitIdentity,
  GitBranchInfo,
  GitRemoteInfo,
  GitCredentialStatus,
  GitStashEntry,
  GitHubWorkflowRunDetail,
  PrReactionContent,
  WorkflowRerunMode,
  WorkflowRunFilter
} from '$shared/types'
import { GIT_CHROME_REUSE_MS } from '../git.svelte'
import type { GitState } from '../git.svelte'

/** GitState commands: one concern, moved verbatim from the composition root. */
export class GitStateCommands {
  constructor(private readonly host: GitState) {}

  async runRefresh(projectId: string, generation: number, reuseChrome: boolean): Promise<void> {
    this.host.markBusy('refresh', true)
    // The refresh targets whichever project is active right now; if the panel
    // has already switched to another project, the result is stale and must
    // never be written.
    const targetProject = this.host.activeProjectId
    const targetScope = this.host.activeScopeBucketId
    const stillCurrent = (): boolean =>
      targetProject === this.host.activeProjectId &&
      targetScope === this.host.activeScopeBucketId &&
      generation === this.host.activationGeneration &&
      projectId === this.host.activeProjectId
    /** Whether this round has already published working tree state. */
    let publishedStatus = false
    this.host.statusError = null
    try {
      // The chrome reads are started first so they overlap the status read, but
      // nothing downstream waits on them. Staging and committing are local
      // operations on the working tree and must never be held behind a branch
      // listing, a remote listing, or the OS keychain probe that answers
      // whether a credential is stored. A single `Promise.all` over all six
      // reads did exactly that: `status` was only published once the slowest of
      // them had answered, which is what made a local operation look like it was
      // waiting on the network.
      const chromeKey = `${targetProject ?? ''}:${targetScope ?? ''}`
      const cachedChrome = reuseChrome ? this.host.chromeByTarget.get(chromeKey) : undefined
      const freshChrome =
        cachedChrome !== undefined && Date.now() - cachedChrome.readAt <= GIT_CHROME_REUSE_MS
          ? cachedChrome
          : null
      const chrome: Promise<
        [GitBranchInfo[], GitIdentity, GitRemoteInfo[], GitCredentialStatus | null, GitStashEntry[]]
      > = freshChrome
        ? Promise.resolve([
            freshChrome.branches,
            freshChrome.identity,
            freshChrome.remotes,
            freshChrome.credentialStatus,
            freshChrome.stashes
          ])
        : Promise.all([
            invoke('git:branches', projectId, targetScope ?? undefined),
            invoke('git:getIdentity', projectId),
            invoke('git:remotes', projectId, targetScope ?? undefined).catch(
              () => [] as GitRemoteInfo[]
            ),
            invoke('git:getCredentialStatus', projectId).catch(
              () => null as GitCredentialStatus | null
            ),
            invoke('git:stashList', projectId).catch(() => [] as GitStashEntry[])
          ])
      // Every read here is best-effort, and a failed status read returns above
      // without ever awaiting this: without a handler attached now, a chrome
      // failure would surface as an unhandled rejection for an error the panel
      // has already reported.
      void chrome.catch(() => undefined)

      const status = await this.host.readStatus(projectId)
      if (!stillCurrent()) return
      if (!status) {
        this.host.error = 'Git status could not be loaded'
        this.host.statusError = 'Git status could not be loaded'
        // A cached tree is deliberately kept: the surface shows it dimmed behind
        // the error rather than going blank for a checkout that has been read.
        if (!this.host.cachedStatus) this.host.status = null
        return
      }
      this.host.status = status
      this.host.cachedStatus = false
      this.host.statusError = null
      publishedStatus = true
      this.host.statusReadAt = Date.now()
      // Conflicts mode is only meaningful while actual conflicts exist - once
      // they are all resolved the filter auto-closes, like the last-turn one.
      // Decided here, off the status alone, so the filter settles without
      // waiting for the chrome reads below.
      if (status.conflicted.length === 0) this.host.conflictsMode = false

      const [branches, identity, remotes, credentialStatus, stashes] = await chrome
      if (!stillCurrent()) return
      this.host.branches = branches
      // A recorded PR-conflict session is only real while its temporary
      // `pr-<n>` branch still exists: once the branch is gone (finished, or
      // deleted by hand) the session must not keep offering a merge to
      // complete.
      const session = this.host.prResolveSession
      if (
        session &&
        !branches.some(
          (branch) => branch.kind === 'local' && branch.name === `pr-${session.pullNumber}`
        )
      ) {
        this.host.prResolveSession = null
      }
      this.host.identity = identity
      this.host.remotes = Array.isArray(remotes) ? remotes : []
      this.host.credentialStatus = credentialStatus
      this.host.stashes = stashes
      this.host.units['runtime'].rememberSurfaceCache(targetScope)
      if (!freshChrome) {
        // Remember what this target's chrome answered while it is still fresh,
        // and drop the entries nobody can reuse any more so the map cannot grow
        // with every project the session touches.
        const now = Date.now()
        for (const [key, snapshot] of this.host.chromeByTarget) {
          if (now - snapshot.readAt > GIT_CHROME_REUSE_MS) this.host.chromeByTarget.delete(key)
        }
        this.host.chromeByTarget.set(chromeKey, {
          branches,
          identity,
          remotes: Array.isArray(remotes) ? remotes : [],
          credentialStatus,
          stashes,
          readAt: now
        })
      }
      // Refresh the open-PR conflict indicator (cooldown-gated) so the header
      // badge stays current without a GitHub round trip on every mutation.
      void this.host.refreshPrConflictIndicators(projectId).catch(() => {})
    } catch (reason) {
      if (!stillCurrent()) return
      this.host.error = errorMessage(reason, 'Git status could not be loaded')
      // A chrome read is what failed here when status has already landed, and a
      // failed branch listing is not a reason to stop staging files: the
      // published status is left in place and only its own failure clears it.
      // A cached tree stays for the same reason the panel shows it at all.
      if (!publishedStatus) {
        this.host.statusError = this.host.error
        if (!this.host.cachedStatus) this.host.status = null
      }
    } finally {
      this.host.markBusy('refresh', false)
    }
  }

  rebaseAction(
    projectId: string,
    action: Parameters<GitLocalOperations['rebaseAction']>[1]
  ): Promise<void> {
    return this.host.local.rebaseAction(projectId, action)
  }

  ensureWorkflowRunPage(
    projectId: string,
    owner: string,
    repo: string,
    filter: WorkflowRunFilter,
    page: number,
    force = false
  ): Promise<void> {
    return this.host.deployments.ensureWorkflowRunPage(projectId, owner, repo, filter, page, force)
  }

  ensureWorkflowRunDetail(
    projectId: string,
    owner: string,
    repo: string,
    runId: number,
    force = false
  ): Promise<GitHubWorkflowRunDetail | null> {
    return this.host.deployments.ensureWorkflowRunDetail(projectId, owner, repo, runId, force)
  }

  /**
   * Replay a workflow run's jobs, then drop the cached views so the run, its
   * deployment and its logs are read again instead of showing the stale pre-run
   * state. Returns false when GitHub refused (the reason lands in `error`).
   */
  rerunWorkflowRun(
    projectId: string,
    owner: string,
    repo: string,
    runId: number,
    mode: WorkflowRerunMode
  ): Promise<boolean> {
    return this.host.deployments.rerunWorkflowRun(projectId, owner, repo, runId, mode)
  }

  /**
   * Cancel a queued or in-progress workflow run, then drop the cached views so
   * the run is read again as it settles into `cancelled` instead of showing the
   * stale active state. Returns false when GitHub refused (the reason lands in
   * `error`).
   */
  cancelWorkflowRun(
    projectId: string,
    owner: string,
    repo: string,
    runId: number
  ): Promise<boolean> {
    return this.host.deployments.cancelWorkflowRun(projectId, owner, repo, runId)
  }

  /**
   * React to one comment, or take that reaction back.
   *
   * Addressed by the subject's GraphQL node id, because that is the one handle
   * the description, an issue comment, a review and an inline comment all share.
   * The store corrects the cached bundle from the write's own answer, so the
   * reader's chip changes without the conversation refetching.
   */
  setPrCommentReaction(
    projectId: string,
    owner: string,
    repo: string,
    pullNumber: number,
    nodeId: string,
    content: PrReactionContent,
    add: boolean
  ): Promise<boolean> {
    return this.host.prOps.setPrCommentReaction(
      projectId,
      owner,
      repo,
      pullNumber,
      nodeId,
      content,
      add
    )
  }
}
