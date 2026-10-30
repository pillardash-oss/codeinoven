import { ovenRootKey } from '$lib/oven-root-target'
import { invoke } from '$lib/ipc.svelte'
import { type GitOperation } from '../git-store-helpers'
import { GitIssueCache } from '../git-store-issues.svelte'
import { GitPullRequestOperations } from '../git-store-pr-operations.svelte'
import type {
  GitStatus,
  Project,
  GitRemoteIssue,
  IssueReference,
  IssueSummary,
  NewIssueInput,
  PrReactionContent
} from '$shared/types'
import { INBOX_PROJECT_ID } from '$shared/types'
import { REMOTE_FETCH_STALE_MS } from '../git.svelte'
import type { GitState } from '../git.svelte'

/** GitState queries: one concern, moved verbatim from the composition root. */
export class GitStateQueries {
  constructor(private readonly host: GitState) {}

  /** The remote verdict belongs to the scope whose checkout made the request. */
  remoteIssueFor(projectId: string, scopeBucketId?: string): GitRemoteIssue | null {
    return this.host.local.remoteIssueFor(
      projectId,
      ovenRootKey(projectId) ?? scopeBucketId ?? this.host.scopeFor(projectId)
    )
  }

  /** The scope-qualified Git target used by status reads. */
  statusTarget(projectId: string): [string, string | null] {
    const project = this.host.activeProjectId === projectId ? this.host.activeScopeBucketId : null
    return [projectId, project]
  }

  async readStatus(projectId: string): Promise<GitStatus | null> {
    const [id, scope] = this.statusTarget(projectId)
    const status = (await invoke('git:status', id, scope ?? undefined)) as
      GitStatus | null | undefined
    if (!status) return null
    return status
  }

  /**
   * Event-driven entry point: called by the workspace store whenever a thread
   * is opened in a project (new project added, new thread created, thread
   * switched, app-restore). The store decides whether git tracking applies and
   * refreshes deterministically - no polling anywhere.
   */
  notifyThreadOpened(project: Project | null, thread?: { scopeBucketId?: string } | null): void {
    if (!project || project.id === INBOX_PROJECT_ID) return
    if (project.source !== 'local' || project.changeTrackingMode !== 'git') return
    if (!project.path.trim()) return
    const scopeBucketId = ovenRootKey(project.id) ?? thread?.scopeBucketId ?? null
    // A scope target is what Git cares about, not a thread. Switching between
    // two threads of the same project and scope changes nothing here, so this
    // returns before touching status: no read, no blank panel, no worktree
    // discovery.
    const targetChanged =
      this.host.activeProjectId !== project.id || this.host.activeScopeBucketId !== scopeBucketId
    // Claim the target synchronously so the panel can never show another
    // scope's state, then read the new one *after* the switch has painted.
    this.host.activate(project.id, thread?.scopeBucketId ?? undefined)
    if (!targetChanged) return
    this.host.units['runtime'].scheduleRefresh(project.id)
  }

  /**
   * Whether the age-gated fetch is due: nothing is fetched for a repository with
   * no remote, and a project already attempted inside the window is left alone,
   * which is what keeps repeated project opens - and repeated panel opens - from
   * becoming repeated network round trips.
   */
  fetchIsDue(projectId: string): boolean {
    if (this.host.remotes.length === 0) return false
    return Date.now() - (this.host.fetchAttempts[projectId] ?? 0) >= REMOTE_FETCH_STALE_MS
  }

  /**
   * Whether an open PR currently needs conflict resolution. All indicator UI
   * (header button, PR list rows, PR detail) reads this one store-owned fact,
   * so every subscribed surface shows exactly the same state.
   */
  hasPrIssue(owner: string, repo: string, pullNumber: number): boolean {
    return this.host.conflicts.hasIssue(owner, repo, pullNumber)
  }

  isBusy(operation: GitOperation | GitOperation[]): boolean {
    const operations = Array.isArray(operation) ? operation : [operation]
    return operations.some((name) => this.host.busy[name] === true)
  }

  getDiff(projectId: string, path: string, staged: boolean) {
    return this.host.local.getDiff(projectId, path, staged)
  }

  finishPrResolve(projectId: string): Promise<boolean> {
    return this.host.local.finishPrResolve(projectId)
  }

  discard(projectId: string, paths: string[]): Promise<void> {
    return this.host.local.discard(projectId, paths)
  }

  getLog(projectId: string, limit = 30, offset = 0, query?: string) {
    return this.host.local.getLog(projectId, limit, offset, query)
  }

  getRemoteUpdates(projectId: string) {
    return this.host.local.getRemoteUpdates(projectId)
  }

  getCommitDiff(projectId: string, hash: string) {
    return this.host.local.getCommitDiff(projectId, hash)
  }

  getCommitFileDiff(projectId: string, hash: string, path: string) {
    return this.host.local.getCommitFileDiff(projectId, hash, path)
  }

  getStashDiff(projectId: string, id: string) {
    return this.host.local.getStashDiff(projectId, id)
  }

  getStashFileDiff(projectId: string, id: string, path: string) {
    return this.host.local.getStashFileDiff(projectId, id, path)
  }

  markPullRequestReadyForReview(
    projectId: string,
    owner: string,
    repo: string,
    pullNumber: number
  ) {
    return this.host.prOps.markPullRequestReadyForReview(projectId, owner, repo, pullNumber)
  }

  listPullRequests(
    projectId: string,
    owner: string,
    repo: string,
    state?: Parameters<GitPullRequestOperations['listPullRequests']>[3]
  ) {
    return this.host.prOps.listPullRequests(projectId, owner, repo, state)
  }

  getDefaultBranch(projectId: string) {
    return this.host.prOps.getDefaultBranch(projectId)
  }

  // Issue operations, delegated to the online mutation service.
  createIssue(projectId: string, input: NewIssueInput): Promise<IssueReference | null> {
    return this.host.issueOps.createIssue(projectId, input)
  }

  updateIssue(
    projectId: string,
    owner: string,
    repo: string,
    issueNumber: number,
    title: string | undefined,
    body: string | undefined
  ): Promise<IssueReference | null> {
    return this.host.issueOps.updateIssue(projectId, owner, repo, issueNumber, title, body)
  }

  createIssueComment(
    projectId: string,
    owner: string,
    repo: string,
    issueNumber: number,
    body: string
  ): Promise<boolean> {
    return this.host.issueOps.createIssueComment(projectId, owner, repo, issueNumber, body)
  }

  updateIssueComment(
    projectId: string,
    owner: string,
    repo: string,
    commentId: number,
    body: string
  ): Promise<boolean> {
    return this.host.issueOps.updateIssueComment(projectId, owner, repo, commentId, body)
  }

  deleteIssueComment(
    projectId: string,
    owner: string,
    repo: string,
    commentId: number
  ): Promise<boolean> {
    return this.host.issueOps.deleteIssueComment(projectId, owner, repo, commentId)
  }

  /** Replace the labels an issue carries, from the label picker. */
  setIssueLabels(
    projectId: string,
    owner: string,
    repo: string,
    issueNumber: number,
    labels: string[]
  ) {
    return this.host.issueOps.setIssueLabels(projectId, owner, repo, issueNumber, labels)
  }

  /** Replace an issue's assignees, from the assignee picker. */
  setIssueAssignees(
    projectId: string,
    owner: string,
    repo: string,
    issueNumber: number,
    logins: string[]
  ) {
    return this.host.issueOps.setIssueAssignees(projectId, owner, repo, issueNumber, logins)
  }

  /** Attach or clear an issue's milestone. */
  setIssueMilestone(
    projectId: string,
    owner: string,
    repo: string,
    issueNumber: number,
    milestone: number | null
  ) {
    return this.host.issueOps.setIssueMilestone(projectId, owner, repo, issueNumber, milestone)
  }

  /**
   * Add or take back the signed-in account's reaction on an issue or one of its
   * comments.
   *
   * Addressed by the subject's GraphQL node id, which is the handle the issue and
   * its comments share with every other reactable thing. The store corrects the
   * cached bundle from the write's own answer, so a chip changes without the
   * conversation refetching.
   */
  setIssueReaction(
    projectId: string,
    owner: string,
    repo: string,
    issueNumber: number,
    nodeId: string,
    content: PrReactionContent,
    add: boolean
  ): Promise<boolean> {
    return this.host.issueOps.setIssueReaction(
      projectId,
      owner,
      repo,
      issueNumber,
      nodeId,
      content,
      add
    )
  }

  // Cached issue listings and detail bundles.
  ensureIssuePage(
    projectId: string,
    owner: string,
    repo: string,
    state: Parameters<GitIssueCache['ensureIssuePage']>[3],
    page: number,
    query: Parameters<GitIssueCache['ensureIssuePage']>[5],
    force = false
  ): Promise<void> {
    return this.host.issues.ensureIssuePage(projectId, owner, repo, state, page, query, force)
  }

  ensureIssueBundle(
    projectId: string,
    owner: string,
    repo: string,
    issueNumber: number,
    force = false
  ): Promise<void> {
    return this.host.issues.ensureIssueBundle(projectId, owner, repo, issueNumber, force)
  }

  /**
   * Read one issue's relationships: its parent, its sub-issues and its dependencies.
   *
   * Deferred for the same reason as the history: it is four more requests, and the
   * issue is readable without any of them.
   */
  ensureIssueRelationships(
    projectId: string,
    owner: string,
    repo: string,
    issueNumber: number,
    force = false
  ): Promise<void> {
    return this.host.issues.relationships.ensure(projectId, owner, repo, issueNumber, force)
  }

  /** Forget an issue's cached relationships, so a link change is read back. */
  invalidateIssueRelationships(owner: string, repo: string, issueNumber: number): void {
    this.host.issues.relationships.invalidate(owner, repo, issueNumber)
  }

  /** Search the repository's issues, for the relationship picker. */
  searchIssueCandidates(
    projectId: string,
    owner: string,
    repo: string,
    text: string
  ): Promise<IssueSummary[]> {
    return this.host.issueOps.searchIssueCandidates(projectId, owner, repo, text)
  }

  /** Make one issue a sub-issue of another. Both sides are node ids. */
  addIssueSubIssue(
    projectId: string,
    owner: string,
    repo: string,
    issueNumber: number,
    issueNodeId: string,
    relatedNodeId: string
  ): Promise<boolean> {
    return this.host.issueOps.addSubIssue(
      projectId,
      owner,
      repo,
      issueNumber,
      issueNodeId,
      relatedNodeId
    )
  }

  /** Detach a sub-issue from its parent. */
  removeIssueSubIssue(
    projectId: string,
    owner: string,
    repo: string,
    issueNumber: number,
    issueNodeId: string,
    relatedNodeId: string
  ): Promise<boolean> {
    return this.host.issueOps.removeSubIssue(
      projectId,
      owner,
      repo,
      issueNumber,
      issueNodeId,
      relatedNodeId
    )
  }

  /** Record that one issue blocks another. */
  addIssueBlockedBy(
    projectId: string,
    owner: string,
    repo: string,
    issueNumber: number,
    issueNodeId: string,
    relatedNodeId: string
  ): Promise<boolean> {
    return this.host.issueOps.addBlockedBy(
      projectId,
      owner,
      repo,
      issueNumber,
      issueNodeId,
      relatedNodeId
    )
  }

  /** Remove a blocking relationship between two issues. */
  removeIssueBlockedBy(
    projectId: string,
    owner: string,
    repo: string,
    issueNumber: number,
    issueNodeId: string,
    relatedNodeId: string
  ): Promise<boolean> {
    return this.host.issueOps.removeBlockedBy(
      projectId,
      owner,
      repo,
      issueNumber,
      issueNodeId,
      relatedNodeId
    )
  }

  getCommitFiles(projectId: string, owner: string, repo: string, sha: string) {
    return this.host.prs.getCommitFiles(projectId, owner, repo, sha)
  }

  // GitHub account auth.
  githubAuthStatus() {
    return this.host.github.githubAuthStatus()
  }

  /**
   * Settle or reopen one inline review thread. The thread is addressed by its
   * GraphQL node id, because GitHub keeps resolution on the thread and only
   * exposes it there.
   */
  setPrReviewThreadResolved(
    projectId: string,
    owner: string,
    repo: string,
    pullNumber: number,
    threadNodeId: string,
    resolved: boolean
  ): Promise<boolean> {
    return this.host.prOps.setPrReviewThreadResolved(
      projectId,
      owner,
      repo,
      pullNumber,
      threadNodeId,
      resolved
    )
  }
}
