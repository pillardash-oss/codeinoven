import { ovenRootKey } from '$lib/oven-root-target'
import { GitPullRequestCache } from '../git-store-pull-requests.svelte'
import { GitIssueCache } from '../git-store-issues.svelte'
import type { Project, WorkflowRunFilter } from '$shared/types'
import { INBOX_PROJECT_ID } from '$shared/types'
import type { GitState } from '../git.svelte'

/** GitState lifecycle: one concern, moved verbatim from the composition root. */
export class GitStateLifecycle {
  constructor(private readonly host: GitState) {}

  /** Switch the panel to a project, dropping any leftover state from the
   *  previous one so stale data is never shown. */
  activate(projectId: string, scopeBucketId?: string): void {
    const nextScopeBucketId = ovenRootKey(projectId) ?? scopeBucketId ?? null
    if (
      this.host.activeProjectId === projectId &&
      this.host.activeScopeBucketId === nextScopeBucketId
    )
      return
    this.host.units['runtime'].rememberScopeNotices()
    this.host.activationGeneration += 1
    this.host.activeProjectId = projectId
    this.host.activeScopeBucketId = nextScopeBucketId
    this.host.units['storage'].clearProjectState()
    this.host.units['runtime'].restoreScopeNotices()
    this.host.units['runtime'].hydrateFromCache(nextScopeBucketId)
  }

  /** Clear Git state when the active thread has no Git-capable project. */
  deactivate(): void {
    this.host.units['runtime'].rememberScopeNotices()
    if (this.host.activeProjectId === null) return
    this.host.activationGeneration += 1
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
    if (this.host.activeProjectId) return
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
