import { invoke, subscribe } from '$lib/ipc.svelte'
import { ovenSurfaceCacheKey, readOvenSurface, writeOvenSurface } from '$lib/oven-surface-cache'
import { scheduleDeferredWork } from '$lib/deferred-work'
import { parseOvenRootKey } from '$shared/oven-root-routing'
import { GITHUB_PROBE_TTL_MS, type GitOperation } from '../git-store-helpers'
import { GitPullRequestCache } from '../git-store-pull-requests.svelte'
import { GitPullRequestOperations } from '../git-store-pr-operations.svelte'
import type { PrBatchStepListener } from '../git-store-pr-operations.svelte'
import { issueBundleKey } from '../git-store-helpers'
import { GitLocalOperations } from '../git-store-local-operations.svelte'
import type {
  GitStatus,
  GitSyncPeerOption,
  GitHubAuthStatus,
  GitHubDeploymentDetail,
  GitHubDeploymentJobLog,
  IssueTimelineEvent,
  PrAgentAssignmentInput,
  PrAgentAssignmentWorkspace,
  PrCommentKind,
  PrMinimizeReason,
  PrState
} from '$shared/types'
import { INBOX_PROJECT_ID } from '$shared/types'
import type { CachedGitSurface } from '../git.svelte'
import type { GitState } from '../git.svelte'

/** GitState runtime: one concern, moved verbatim from the composition root. */
export class GitStateRuntime {
  constructor(private readonly host: GitState) {}

  rememberScopeNotices(): void {
    if (!this.host.activeProjectId) return
    const key = JSON.stringify([this.host.activeProjectId, this.host.activeScopeBucketId])
    if (this.host.error || this.host.githubPermission) {
      this.host.scopeNotices.set(key, {
        error: this.host.error,
        permission: this.host.githubPermission
      })
    } else this.host.scopeNotices.delete(key)
  }

  restoreScopeNotices(): void {
    const notice = this.host.scopeNotices.get(
      JSON.stringify([this.host.activeProjectId, this.host.activeScopeBucketId])
    )
    this.host.error = notice?.error ?? null
    this.host.githubPermission = notice?.permission ?? null
  }

  /**
   * One conversation's history, whoever is reading it.
   *
   * GitHub's timeline is one endpoint for both readers, because a pull request is
   * an issue to that API and a repository's numbers are one space: `#42` is an
   * issue or a pull request and never both. One read and one cache therefore serve
   * the issue reader and the pull request conversation, and neither reader has to
   * know which key the other looked under.
   */
  conversationTimeline(owner: string, repo: string, number: number): IssueTimelineEvent[] {
    return this.host.issues.timelines.values[issueBundleKey(owner, repo, number)]?.value ?? []
  }

  /**
   * Paint what this Oven last answered, before asking it again.
   *
   * A remote checkout's Git read is an SSH round trip, so the panel would
   * otherwise open on "Checking repository" and then a blank tree for a
   * repository that has been read many times. The live read replaces this the
   * moment it lands; `showingCachedStatus` is what tells the panel to dim it
   * until then, so the cached tree is never passed off as current.
   */
  hydrateFromCache(scopeBucketId: string | null): void {
    const target = parseOvenRootKey(scopeBucketId)
    if (!target) return
    const cached = readOvenSurface<CachedGitSurface>(
      ovenSurfaceCacheKey('git', target.ovenId, target.threadId)
    )
    if (!cached || !cached.status) return
    this.host.status = cached.status
    this.host.branches = Array.isArray(cached.branches) ? cached.branches : []
    this.host.remotes = Array.isArray(cached.remotes) ? cached.remotes : []
    this.host.stashes = Array.isArray(cached.stashes) ? cached.stashes : []
    this.host.cachedStatus = true
  }

  /** Keep a remote checkout's Git read for its next open. */
  rememberSurfaceCache(scopeBucketId: string | null): void {
    const target = parseOvenRootKey(scopeBucketId)
    const status = this.host.status
    if (!target || !status) return
    writeOvenSurface(ovenSurfaceCacheKey('git', target.ovenId, target.threadId), {
      status,
      branches: this.host.branches,
      remotes: this.host.remotes,
      stashes: this.host.stashes
    } satisfies CachedGitSurface)
  }

  /**
   * Scope-sensitive activation: called when a thread moves between scopes
   * while the Git panel stays open. Re-resolves status for the new root so
   * sibling worktrees never display each other's state.
   */
  notifyScopeChanged(projectId: string, scopeBucketId: string): void {
    this.rememberScopeNotices()
    this.host.activationGeneration += 1
    this.host.activeProjectId = projectId
    this.host.activeScopeBucketId = scopeBucketId
    this.host.units['storage'].clearProjectState()
    this.restoreScopeNotices()
    this.hydrateFromCache(scopeBucketId)
    this.scheduleRefresh(projectId)
  }

  scopeFor(projectId: string): string | undefined {
    return this.host.activeProjectId === projectId
      ? (this.host.activeScopeBucketId ?? undefined)
      : undefined
  }

  /**
   * Append the active scope bucket id to a git:* local-repository invoke so the
   * operation runs against the worktree (when one is active) instead of always
   * reaching the project root. `undefined` is forwarded as-is for project-root
   * callers, keeping backward compatibility.
   */
  scopedGitArgs<Args extends unknown[]>(
    projectId: string,
    ...args: Args
  ): [string, ...Args, string | undefined] {
    const scope = this.host.scopeFor(projectId)
    return [projectId, ...args, scope ?? undefined]
  }

  /**
   * Queue the project-open read for after the current view switch has
   * painted. This only runs when the scope target actually moves - a thread
   * switch inside one scope never reaches it, because `activate` and
   * `targetChanged` both short-circuit above. When it does run it fans out to
   * six repository reads plus worktree discovery, and running all of that in
   * the same instant as the conversation mount made a scope switch feel slow.
   * Deferring it keeps the panel's data honestly late rather than the
   * conversation's paint honestly slow.
   *
   * The read hands off to the age-gated fetch once local state has answered, so
   * a project opens with its remote-tracking refs already being refreshed -
   * while the user is still reading the conversation - instead of that round
   * trip starting later, under the click that asked the git panel for
   * something.
   */
  scheduleRefresh(projectId: string): void {
    scheduleDeferredWork('git:refresh', () =>
      this.refreshThenFetchIfDue(projectId, { reuseChrome: true })
    )
  }

  /**
   * Read the working tree, then refresh the remote-tracking refs if they have
   * gone stale.
   *
   * This is the one step every "this project is now in use" event shares - a
   * thread opening in it, a scope switch inside it, the app starting on it, the
   * panel opening onto it - so the ordering lives here once: local state first,
   * because it is what the panel paints and what says whether there is a remote
   * worth fetching from, and the fetch only when the age gate lets it through.
   *
   * The fetch never waits on, or is waited on by, the user's work. It is the one
   * git operation that touches nothing in the working tree (remote-tracking refs
   * and `FETCH_HEAD` only), so main runs it on a lane of its own rather than the
   * status/stage/commit queue, and every caller reaches it behind a deferred or
   * microtask hop, so it starts after the frame the user asked for has painted.
   */
  refreshThenFetchIfDue(projectId: string, options: { reuseChrome?: boolean } = {}): void {
    void this.host
      .refresh(projectId, options)
      .then(() => {
        if (this.host.activeProjectId !== projectId) return
        if (!this.host.units['queries'].fetchIsDue(projectId)) return
        return this.host.fetch(projectId)
      })
      .catch(() => {})
  }

  /** Record that a fetch was tried, so the age gate can throttle the next one. */
  noteFetchAttempt(projectId: string): void {
    this.host.fetchAttempts[projectId] = Date.now()
  }

  /**
   * Guarantee the GitHub connection before any online git operation. Offline
   * operations (status, stage, commit, stash…) never touch this - only online
   * ones (pull requests, deployments) await it. A negative probe is always
   * re-checked, so signing in mid-session is picked up on the next attempt.
   */
  async ensureGitHubConnection(): Promise<boolean> {
    if (this.host.githubConnection === 'connected') return true
    if (this.host.githubProbe) return this.host.githubProbe
    this.host.githubProbe = this.probeGitHubConnection()
    try {
      return await this.host.githubProbe
    } finally {
      this.host.githubProbe = null
    }
  }

  async probeGitHubConnection(): Promise<boolean> {
    const now = Date.now()
    // A positive probe is trusted briefly; a negative one always re-probes.
    if (
      this.host.githubConnection === 'connected' &&
      now - this.host.lastGithubProbeAt < GITHUB_PROBE_TTL_MS
    ) {
      return true
    }
    this.host.lastGithubProbeAt = now
    this.host.githubConnection = 'connecting'
    const status = await this.host.githubAuthStatus()
    const connected = status.connected
    this.host.githubConnection = connected ? 'connected' : 'disconnected'
    if (connected && this.host.activeProjectId) {
      // The connection just became ready - run the online refreshes now
      // instead of waiting for the next poll tick.
      void this.host.refreshPrConflictIndicators(this.host.activeProjectId)
    }
    return connected
  }

  /**
   * Refresh the open-PR conflict indicator for the active project. Gated on
   * the GitHub connection - the store guarantees the connection before any
   * online operation, so this never runs (or records anything) before GitHub
   * is reachable. A fresh successful result is served without a round trip; a
   * failed check records nothing, so the next event simply tries again.
   *
   * `force` bypasses the freshness window for explicit user mutations (push,
   * PR create/merge/reopen/close) that directly change mergeability - those
   * must always re-check immediately.
   */
  async refreshPrConflictIndicators(projectId: string, force = false): Promise<void> {
    return this.host.conflicts.refresh(projectId, force)
  }

  markBusy(operation: GitOperation, busy: boolean): void {
    // No-op when the value is unchanged, so a repeated mark during an in-flight
    // async load never rewrites `busy` (which would re-trigger dependents and
    // can escalate into an effect_update_depth_exceeded loop).
    if (this.host.busy[operation] === busy) return
    this.host.busy = { ...this.host.busy, [operation]: busy }
  }

  /** Subscribe to agent turn completion so the panel reflects external changes. */
  ensureProjectEvents(projectId: string): void {
    if (projectId === INBOX_PROJECT_ID) return
    if (this.host.subscriptions.has(projectId)) return
    this.host.subscriptions.add(projectId)
    subscribe('agent:event', (...args: unknown[]) => {
      const event = args[0] as { type: string; projectId?: string } | undefined
      if (event?.type === 'checkpoint.updated' && event.projectId === projectId) {
        for (const target of this.host.prs.invalidateProject(projectId)) {
          this.host.issues.timelines.invalidate(target.owner, target.repo, target.number)
        }
        void this.host.refresh(projectId).catch(() => {})
      }
    })
  }

  async refresh(projectId: string, options: { reuseChrome?: boolean } = {}): Promise<void> {
    if (projectId === INBOX_PROJECT_ID || projectId !== this.host.activeProjectId) return
    const scopeBucketId = this.host.scopeFor(projectId)
    const generation = this.host.activationGeneration
    const targetKey = `${generation}:${projectId}:${scopeBucketId ?? ''}`
    const inflight = this.host.refreshes.get(targetKey)
    if (inflight) return inflight

    const refresh = this.host.units['commands'].runRefresh(
      projectId,
      generation,
      options.reuseChrome === true
    )
    this.host.refreshes.set(targetKey, refresh)
    try {
      await refresh
    } finally {
      if (this.host.refreshes.get(targetKey) === refresh) this.host.refreshes.delete(targetKey)
    }
  }

  // Local git operations, delegated to the state they mutate.
  stage(projectId: string, paths: string[]): Promise<void> {
    return this.host.local.stage(projectId, paths)
  }

  analyzeConflict(projectId: string, path: string) {
    return this.host.local.analyzeConflict(projectId, path)
  }

  prepareConflictWorkFile(projectId: string, path: string) {
    return this.host.local.prepareConflictWorkFile(projectId, path)
  }

  saveConflictDraft(
    projectId: string,
    path: string,
    content: string,
    hunks: Parameters<GitLocalOperations['saveConflictDraft']>[3]
  ): Promise<boolean> {
    return this.host.local.saveConflictDraft(projectId, path, content, hunks)
  }

  saveConflictResolution(projectId: string, path: string, content: string): Promise<boolean> {
    return this.host.local.saveConflictResolution(projectId, path, content)
  }

  resolveConflicted(projectId: string, path: string): Promise<void> {
    return this.host.local.resolveConflicted(projectId, path)
  }

  acceptConflictSide(
    projectId: string,
    side: Parameters<GitLocalOperations['acceptConflictSide']>[1]
  ): Promise<void> {
    return this.host.local.acceptConflictSide(projectId, side)
  }

  unstage(projectId: string, paths: string[]): Promise<void> {
    return this.host.local.unstage(projectId, paths)
  }

  commit(projectId: string, message: string): Promise<void> {
    return this.host.local.commit(projectId, message)
  }

  initialize(projectId: string): Promise<void> {
    return this.host.local.initialize(projectId)
  }

  checkout(projectId: string, branch: string): Promise<void> {
    return this.host.local.checkout(projectId, branch)
  }

  createBranch(projectId: string, name: string): Promise<void> {
    return this.host.local.createBranch(projectId, name)
  }

  createTrackingBranch(
    projectId: string,
    remote: string,
    branch: string,
    localName = branch
  ): Promise<void> {
    return this.host.local.createTrackingBranch(projectId, remote, branch, localName)
  }

  deleteBranch(projectId: string, name: string, force = false) {
    return this.host.local.deleteBranch(projectId, name, force)
  }

  deleteRemoteBranch(projectId: string, remote: string, name: string): Promise<void> {
    return this.host.local.deleteRemoteBranch(projectId, remote, name)
  }

  setIdentity(projectId: string, name: string, email: string): Promise<void> {
    return this.host.local.setIdentity(projectId, name, email)
  }

  fetch(projectId: string): Promise<void> {
    return this.host.local.fetch(projectId)
  }

  fetchBranch(projectId: string, remote: string, branch: string): Promise<void> {
    return this.host.local.fetchBranch(projectId, remote, branch)
  }

  pull(projectId: string): Promise<void> {
    return this.host.local.pull(projectId)
  }

  push(projectId: string, setUpstream: boolean, remote?: string, branch?: string) {
    return this.host.local.push(projectId, setUpstream, remote, branch)
  }

  pullIntegrate(
    projectId: string,
    remote: string,
    branch: string,
    strategy: Parameters<GitLocalOperations['pullIntegrate']>[3]
  ): Promise<GitStatus | null> {
    return this.host.local.pullIntegrate(projectId, remote, branch, strategy)
  }

  syncPeers(projectId: string, scopeBucketId?: string): Promise<GitSyncPeerOption[]> {
    return this.host.local.syncPeers(projectId, scopeBucketId)
  }

  syncWith(
    projectId: string,
    scopeBucketId: string | undefined,
    options: Parameters<GitLocalOperations['syncWith']>[2]
  ) {
    return this.host.local.syncWith(projectId, scopeBucketId, options)
  }

  addRemote(projectId: string, name: string, url: string): Promise<void> {
    return this.host.local.addRemote(projectId, name, url)
  }

  setRemoteUrl(projectId: string, name: string, url: string): Promise<void> {
    return this.host.local.setRemoteUrl(projectId, name, url)
  }

  removeRemote(projectId: string, name: string): Promise<void> {
    return this.host.local.removeRemote(projectId, name)
  }

  setCredential(projectId: string, token: string): Promise<void> {
    return this.host.local.setCredential(projectId, token)
  }

  removeCredential(projectId: string): Promise<void> {
    return this.host.local.removeCredential(projectId)
  }

  merge(projectId: string, target: string) {
    return this.host.local.merge(projectId, target)
  }

  rebase(projectId: string, target: string) {
    return this.host.local.rebase(projectId, target)
  }

  abortMerge(projectId: string): Promise<void> {
    return this.host.local.abortMerge(projectId)
  }

  abortRebase(projectId: string): Promise<void> {
    return this.host.local.abortRebase(projectId)
  }

  preparePrResolve(
    projectId: string,
    options: Parameters<GitLocalOperations['preparePrResolve']>[1]
  ): Promise<void> {
    return this.host.local.preparePrResolve(projectId, options)
  }

  stash(projectId: string, message?: string, paths?: string[]): Promise<void> {
    return this.host.local.stash(projectId, message, paths)
  }

  ignore(projectId: string, paths: string[]): Promise<void> {
    return this.host.local.ignore(projectId, paths)
  }

  popStash(projectId: string, id?: string): Promise<void> {
    return this.host.local.popStash(projectId, id)
  }

  dropStash(projectId: string, id?: string): Promise<void> {
    return this.host.local.dropStash(projectId, id)
  }

  restoreFiles(
    projectId: string,
    source: string,
    paths: string[],
    target: Parameters<GitLocalOperations['restoreFiles']>[3]
  ): Promise<void> {
    return this.host.local.restoreFiles(projectId, source, paths, target)
  }

  amend(projectId: string, message: string): Promise<void> {
    return this.host.local.amend(projectId, message)
  }

  reset(
    projectId: string,
    mode: Parameters<GitLocalOperations['reset']>[1],
    target?: string
  ): Promise<void> {
    return this.host.local.reset(projectId, mode, target)
  }

  deleteCommit(projectId: string, target: string): Promise<void> {
    return this.host.local.deleteCommit(projectId, target)
  }

  removeCommitChanges(projectId: string, hash: string, paths: string[]): Promise<void> {
    return this.host.local.removeCommitChanges(projectId, hash, paths)
  }

  // Pull request operations, delegated to the online mutation service.
  createPullRequest(
    projectId: string,
    input: Parameters<GitPullRequestOperations['createPullRequest']>[1]
  ) {
    return this.host.prOps.createPullRequest(projectId, input)
  }

  mergePullRequest(
    projectId: string,
    owner: string,
    repo: string,
    pullNumber: number,
    method: Parameters<GitPullRequestOperations['mergePullRequest']>[4],
    commitTitle?: string,
    commitMessage?: string
  ) {
    return this.host.prOps.mergePullRequest(
      projectId,
      owner,
      repo,
      pullNumber,
      method,
      commitTitle,
      commitMessage
    )
  }

  /**
   * Search this repository's pull requests, for the PR view's own find.
   *
   * The state is the listing the reader is on, so the find answers within the view
   * rather than across every pull request the repository ever had.
   */
  searchPullRequests(projectId: string, owner: string, repo: string, state: PrState, text: string) {
    return this.host.prOps.searchPullRequests(projectId, owner, repo, state, text)
  }

  comparePullRequests(projectId: string, owner: string, repo: string, base: string, head: string) {
    return this.host.prOps.comparePullRequests(projectId, owner, repo, base, head)
  }

  reopenPullRequest(projectId: string, owner: string, repo: string, pullNumber: number) {
    return this.host.prOps.reopenPullRequest(projectId, owner, repo, pullNumber)
  }

  closePullRequest(projectId: string, owner: string, repo: string, pullNumber: number) {
    return this.host.prOps.closePullRequest(projectId, owner, repo, pullNumber)
  }

  /** Delete a merged pull request's head branch from the repository. */
  deleteMergedBranch(projectId: string, owner: string, repo: string, branch: string) {
    return this.host.prOps.deleteMergedBranch(projectId, owner, repo, branch)
  }

  /** Close a batch, one at a time, reporting what succeeded and what did not. */
  closePullRequests(
    projectId: string,
    owner: string,
    repo: string,
    numbers: number[],
    comment: string | null = null,
    onStep?: PrBatchStepListener
  ) {
    return this.host.prOps.closePullRequests(projectId, owner, repo, numbers, comment, onStep)
  }

  /** Reopen a batch, one at a time, reporting what succeeded and what did not. */
  reopenPullRequests(
    projectId: string,
    owner: string,
    repo: string,
    numbers: number[],
    comment: string | null = null,
    onStep?: PrBatchStepListener
  ) {
    return this.host.prOps.reopenPullRequests(projectId, owner, repo, numbers, comment, onStep)
  }

  /** Replace the labels a pull request carries, from the label picker. */
  setPullRequestLabels(
    projectId: string,
    owner: string,
    repo: string,
    pullNumber: number,
    labels: string[]
  ) {
    return this.host.prOps.setPullRequestLabels(projectId, owner, repo, pullNumber, labels)
  }

  /** Replace a pull request's assignees, from the assignee picker. */
  setPullRequestAssignees(
    projectId: string,
    owner: string,
    repo: string,
    pullNumber: number,
    logins: string[]
  ) {
    return this.host.prOps.setPullRequestAssignees(projectId, owner, repo, pullNumber, logins)
  }

  /** Attach or clear a pull request's milestone. */
  setPullRequestMilestone(
    projectId: string,
    owner: string,
    repo: string,
    pullNumber: number,
    milestone: number | null
  ) {
    return this.host.prOps.setPullRequestMilestone(projectId, owner, repo, pullNumber, milestone)
  }

  /** The repository's label catalog, for the label picker. */
  repositoryLabels(projectId: string, owner: string, repo: string) {
    return this.host.prs.repositoryLabels(projectId, owner, repo)
  }

  /** The repository's open milestones, for the milestone picker. */
  repositoryMilestones(projectId: string, owner: string, repo: string) {
    return this.host.prs.repositoryMilestones(projectId, owner, repo)
  }

  updatePullRequest(
    projectId: string,
    owner: string,
    repo: string,
    pullNumber: number,
    title: string | undefined,
    body: string | undefined
  ) {
    return this.host.prOps.updatePullRequest(projectId, owner, repo, pullNumber, title, body)
  }

  composeWithAgent(
    projectId: string,
    virtualTaskId: string,
    settings: Parameters<GitPullRequestOperations['composeWithAgent']>[2],
    input: Parameters<GitPullRequestOperations['composeWithAgent']>[3]
  ) {
    return this.host.prOps.composeWithAgent(projectId, virtualTaskId, settings, input)
  }

  commentOnPullRequest(
    projectId: string,
    owner: string,
    repo: string,
    pullNumber: number,
    body: string
  ) {
    return this.host.prOps.commentOnPullRequest(projectId, owner, repo, pullNumber, body)
  }

  reviewPullRequest(
    projectId: string,
    owner: string,
    repo: string,
    pullNumber: number,
    event: Parameters<GitPullRequestOperations['reviewPullRequest']>[4],
    body: string
  ) {
    return this.host.prOps.reviewPullRequest(projectId, owner, repo, pullNumber, event, body)
  }

  /** Open an agent assignment and hand back the report path its brief should name. */
  async createAgentAssignment(
    projectId: string,
    pullNumber: number,
    threadId: string,
    input: PrAgentAssignmentInput
  ): Promise<PrAgentAssignmentWorkspace | null> {
    const assignment = await this.host.prOps.createAgentAssignment(
      projectId,
      pullNumber,
      threadId,
      input
    )
    if (!assignment) return null
    // Recorded here rather than at each call site, so the row chip and the reader's
    // report list show the assignment the moment it exists.
    this.host.prs.recordAgentAssignment(pullNumber, threadId, input, assignment)
    return assignment
  }

  // Cached pulls, deployments, and mention candidates.
  ensurePullRequestPage(
    projectId: string,
    owner: string,
    repo: string,
    state: Parameters<GitPullRequestCache['ensurePullRequestPage']>[3],
    page: number,
    query: Parameters<GitPullRequestCache['ensurePullRequestPage']>[5],
    force = false
  ): Promise<void> {
    return this.host.prs.ensurePullRequestPage(projectId, owner, repo, state, page, query, force)
  }

  ensurePullRequestBundle(
    projectId: string,
    owner: string,
    repo: string,
    pullNumber: number,
    force = false
  ): Promise<void> {
    return this.host.prs.ensurePullRequestBundle(projectId, owner, repo, pullNumber, force)
  }

  mentionUsersFor(projectId: string, owner: string, repo: string) {
    return this.host.prs.mentionUsersFor(projectId, owner, repo)
  }

  /**
   * Read one conversation's history, which the reader draws after the conversation's
   * own content: the issue's description and comments, or the pull request's.
   *
   * Kept apart from `ensureIssueBundle` so a slow history never delays the content
   * the reader came for. Silent on failure, like the warm-ups: the conversation
   * reads the same without it. A pull request passes its number here the same way an
   * issue does, because one endpoint answers for both.
   */
  ensureConversationTimeline(
    projectId: string,
    owner: string,
    repo: string,
    number: number,
    force = false
  ): Promise<void> {
    return this.host.issues.timelines.ensure(projectId, owner, repo, number, force)
  }

  /**
   * Forget one conversation's cached history, so the event a write just added is
   * read back rather than aged out.
   *
   * A close, a reopen, a merge and a draft transition are each a row of that
   * history, and a reader looking at the conversation would otherwise be missing the
   * row its own click caused.
   */
  invalidateConversationTimeline(owner: string, repo: string, number: number): void {
    this.host.issues.timelines.invalidate(owner, repo, number)
  }

  /** The assignment summaries a page of rows needs, in one batched read. */
  ensureAgentAssignments(projectId: string, numbers: number[]) {
    return this.host.prs.ensureAgentAssignments(projectId, numbers)
  }

  ensureDeploymentActivity(
    projectId: string,
    owner: string,
    repo: string,
    force = false
  ): Promise<boolean | null> {
    return this.host.deployments.ensureDeploymentActivity(projectId, owner, repo, force)
  }

  ensureDeploymentPage(
    projectId: string,
    owner: string,
    repo: string,
    page: number,
    force = false
  ): Promise<void> {
    return this.host.deployments.ensureDeploymentPage(projectId, owner, repo, page, force)
  }

  refreshDeploymentPages(projectId: string, owner: string, repo: string): Promise<void> {
    return this.host.deployments.refreshDeploymentPages(projectId, owner, repo)
  }

  ensureDeploymentDetail(
    projectId: string,
    owner: string,
    repo: string,
    deploymentId: number,
    force = false
  ): Promise<GitHubDeploymentDetail | null> {
    return this.host.deployments.ensureDeploymentDetail(projectId, owner, repo, deploymentId, force)
  }

  ensureDeploymentJobLog(
    projectId: string,
    owner: string,
    repo: string,
    jobId: number,
    force = false
  ): Promise<GitHubDeploymentJobLog | null> {
    return this.host.deployments.ensureDeploymentJobLog(projectId, owner, repo, jobId, force)
  }

  /**
   * Make one signed-in account the one every GitHub call runs as.
   *
   * The viewer login follows the switch here, because it decides which comments
   * and reactions the panel offers to edit; the panel reloads the view it is
   * showing afterwards, since everything it had was read with the other account's
   * token.
   */
  switchGitHubAccount(accountId: string): Promise<GitHubAuthStatus> {
    return this.host.github.switchGitHubAccount(accountId).then((status) => {
      this.host.githubViewerLogin = status.connected ? (status.user?.login ?? null) : null
      return status
    })
  }

  pollGitHubDeviceCode(deviceCode: string) {
    return this.host.github.pollGitHubDeviceCode(deviceCode)
  }

  logoutGitHub() {
    return this.host.github.logoutGitHub()
  }

  /**
   * Rewrite an already-posted comment in place.
   *
   * `kind` selects the collection because GitHub stores conversation comments and
   * inline diff comments in two unrelated endpoints with independent id sequences.
   * The mutation returns only whether the write landed: the caller refetches the
   * bundle, which is the one path that keeps the reader's conversation, counts and
   * "edited" marker consistent with the server.
   */
  editPrComment(
    projectId: string,
    owner: string,
    repo: string,
    pullNumber: number,
    kind: PrCommentKind,
    commentId: number,
    body: string
  ): Promise<boolean> {
    return this.host.prOps.editPrComment(projectId, owner, repo, pullNumber, kind, commentId, body)
  }

  /**
   * Permanently delete a comment. GitHub only allows this for its author, so the
   * caller is responsible for only offering it on your own comment.
   */
  deletePrComment(
    projectId: string,
    owner: string,
    repo: string,
    pullNumber: number,
    kind: PrCommentKind,
    commentId: number
  ): Promise<boolean> {
    return this.host.prOps.deletePrComment(projectId, owner, repo, pullNumber, kind, commentId)
  }

  /**
   * Answer an inline review comment inside its thread. Conversation comments have
   * no threading on GitHub, so only inline ones can be answered this way.
   */
  replyToPrReviewComment(
    projectId: string,
    owner: string,
    repo: string,
    pullNumber: number,
    commentId: number,
    body: string
  ): Promise<boolean> {
    return this.host.prOps.replyToPrReviewComment(
      projectId,
      owner,
      repo,
      pullNumber,
      commentId,
      body
    )
  }

  /**
   * Hide a comment behind GitHub's minimised treatment. Addresses the comment by
   * its GraphQL node id, because GitHub exposes no REST endpoint for this.
   */
  minimizePrComment(
    projectId: string,
    owner: string,
    repo: string,
    pullNumber: number,
    nodeId: string,
    reason: PrMinimizeReason
  ): Promise<boolean> {
    return this.host.prOps.minimizePrComment(projectId, owner, repo, pullNumber, nodeId, reason)
  }
}
