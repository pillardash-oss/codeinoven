import { ovenRootKey } from '$lib/oven-root-target'
import { GitPullRequestCache } from '../git-store-pull-requests.svelte'
import { GitIssueCache } from '../git-store-issues.svelte'
import type { Project, WorkflowRunFilter } from '$shared/types'
import { INBOX_PROJECT_ID } from '$shared/types'
import type { GitState } from '../git.svelte'

/** The identity of one Git target: the project plus the scope bucket it is read on. */
function targetKey(projectId: string, scopeBucketId: string | null): string {
  return `${projectId}\u0000${scopeBucketId ?? ''}`
}

/** GitState lifecycle: one concern, moved verbatim from the composition root. */
export class GitStateLifecycle {
  /**
   * Mounted surfaces that hold the target they are showing (the Git panel, the
   * pull request sheet), with one count per target so two surfaces showing the
   * same checkout cannot release each other's hold.
   *
   * Plain bookkeeping no render reads, hence a Map and not a SvelteMap.
   */
  private readonly holds = new Map<string, number>()

  constructor(private readonly host: GitState) {}

  /** Switch the panel to a project, dropping any leftover state from the
   *  previous one so stale data is never shown. */
  activate(projectId: string, scopeBucketId?: string): void {
    const nextScopeBucketId = ovenRootKey(projectId) ?? scopeBucketId ?? null
    const nextKey = targetKey(projectId, nextScopeBucketId)
    if (this.host.claimedTargetKey === nextKey) return
    this.host.units['runtime'].rememberScopeNotices()
    this.host.activationGeneration += 1
    this.host.claimedTargetKey = nextKey
    this.host.activeProjectId = projectId
    this.host.activeScopeBucketId = nextScopeBucketId
    this.host.units['storage'].clearProjectState()
    this.host.units['runtime'].restoreScopeNotices()
    this.host.units['runtime'].hydrateFromCache(nextScopeBucketId)
  }

  /**
   * Claim a target for as long as the caller is on screen, and hand back the
   * release. A docked Git surface keeps the checkout it is showing even while the
   * selected thread has no Git context of its own, so the header's release below
   * can never clear the data out from under a panel the user is looking at.
   */
  holdTarget(projectId: string, scopeBucketId?: string): () => void {
    this.activate(projectId, scopeBucketId)
    const key = targetKey(projectId, ovenRootKey(projectId) ?? scopeBucketId ?? null)
    this.holds.set(key, (this.holds.get(key) ?? 0) + 1)
    return () => {
      const count = this.holds.get(key) ?? 0
      if (count <= 1) this.holds.delete(key)
      else this.holds.set(key, count - 1)
    }
  }

  /** Whether the target named here is the one currently claimed. */
  isCurrentTarget(projectId: string, scopeBucketId?: string): boolean {
    return (
      this.host.claimedTargetKey ===
      targetKey(projectId, ovenRootKey(projectId) ?? scopeBucketId ?? null)
    )
  }

  /**
   * Clear Git state when the active thread has no Git-capable project, unless a
   * mounted surface still holds the claimed checkout - that surface is showing it
   * and reads the very fields this would wipe.
   */
  deactivate(): void {
    const claimed = this.host.claimedTargetKey
    if (claimed === null) return
    if (this.holds.has(claimed)) return
    this.host.units['runtime'].rememberScopeNotices()
    this.host.activationGeneration += 1
    this.host.claimedTargetKey = null
    this.host.activeProjectId = null
    this.host.units['storage'].clearProjectState()
  }

  /**
   * App-start hook: when the application launches it checks the active project
   * asynchronously - connection first (the store guarantees it), then the PR
   * indicator - even if no thread is restored yet (fresh start, or the last
   * session ended on a chat). No-ops when a thread already opened, since
   * `notifyThreadOpened` already refreshed that project. Either way this
   * refreshes the remote-tracking refs on the same stale gate, so the first
   * time the user opens the panel its Pull and Push counts are already right.
   */
  notifyAppStarted(project: Project | null): void {
    if (this.host.claimedTargetKey) return
    if (!project || project.id === INBOX_PROJECT_ID) return
    if (project.source !== 'local' || project.changeTrackingMode !== 'git') return
    if (!project.path.trim()) return
    this.host.activate(project.id)
    queueMicrotask(() => this.host.units['runtime'].refreshThenFetchIfDue(project.id))
  }

  /**
   * Warm the pull request under the pointer, so the click that follows renders
   * from cache rather than spinning through a cold `pr:bundle`.
   */
  preloadPullRequestBundle(
    projectId: string,
    owner: string,
    repo: string,
    pullNumber: number
  ): Promise<void> {
    return this.host.prs.preloadPullRequestBundle(projectId, owner, repo, pullNumber)
  }

  /** Warm the page behind Next, from the current page's cursor alone. */
  preloadPullRequestNextPage(
    projectId: string,
    owner: string,
    repo: string,
    state: Parameters<GitPullRequestCache['preloadPullRequestNextPage']>[3],
    page: number,
    query: Parameters<GitPullRequestCache['preloadPullRequestNextPage']>[5]
  ): Promise<void> {
    return this.host.prs.preloadPullRequestNextPage(projectId, owner, repo, state, page, query)
  }

  /** Warm the issue under the pointer, so the click that follows renders from cache. */
  preloadIssueBundle(
    projectId: string,
    owner: string,
    repo: string,
    issueNumber: number
  ): Promise<void> {
    return this.host.issues.preloadIssueBundle(projectId, owner, repo, issueNumber)
  }

  /** Warm the page behind Next, from the current page's cursor alone. */
  preloadIssueNextPage(
    projectId: string,
    owner: string,
    repo: string,
    state: Parameters<GitIssueCache['preloadIssueNextPage']>[3],
    page: number,
    query: Parameters<GitIssueCache['preloadIssueNextPage']>[5]
  ): Promise<void> {
    return this.host.issues.preloadIssueNextPage(projectId, owner, repo, state, page, query)
  }

  /** Every agent assignment report a pull request holds, newest first. */
  loadAgentReports(projectId: string, pullNumber: number) {
    return this.host.prs.loadAgentReports(projectId, pullNumber)
  }

  preloadWorkflowRunPage(
    projectId: string,
    owner: string,
    repo: string,
    filter: WorkflowRunFilter,
    page: number
  ): Promise<void> {
    return this.host.deployments.preloadWorkflowRunPage(projectId, owner, repo, filter, page)
  }

  preloadDeploymentPage(
    projectId: string,
    owner: string,
    repo: string,
    page: number
  ): Promise<void> {
    return this.host.deployments.preloadDeploymentPage(projectId, owner, repo, page)
  }

  startGitHubDeviceFlow() {
    return this.host.github.startGitHubDeviceFlow()
  }
}
