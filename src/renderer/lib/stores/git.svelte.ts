import { SvelteMap } from 'svelte/reactivity'
import { parseOvenRootKey } from '$shared/oven-root-routing'
import {
  deploymentDetailKey,
  deploymentKey,
  deploymentLogKey,
  deploymentPageKey,
  issueBundleKey,
  issuePageKey,
  prBundleKey,
  prPageKey,
  workflowRunKey,
  workflowRunPageKey,
  type GitOperation
} from './git-store-helpers'
import { GitDeploymentCache } from './git-store-deployments.svelte'
import { GitPullRequestCache } from './git-store-pull-requests.svelte'
import { GitIssueCache, type CachedIssueRead } from './git-store-issues.svelte'
import { GitPrConflictIndicators } from './git-store-pr-conflicts.svelte'
import {
  GitPullRequestOperations,
  type PrBatchStepListener
} from './git-store-pr-operations.svelte'
import {
  GitIssueOperations,
  type GitIssueOperationAccess
} from './git-store-issue-operations.svelte'
import { GitGitHubAuth } from './git-store-github.svelte'
import { GitLocalOperations } from './git-store-local-operations.svelte'
import {
  type GitBranchInfo,
  type GitCredentialStatus,
  type GitHubAuthStatus,
  type GitHubDeploymentDetail,
  type GitHubDeploymentJobLog,
  type GitHubDeploymentPage,
  type GitHubPermissionRequired,
  type GitHubWorkflowRunDetail,
  type GitHubWorkflowRunPage,
  type GitIdentity,
  type GitRemoteInfo,
  type GitRemoteIssue,
  type GitStashEntry,
  type GitStatus,
  type GitSyncPeerOption,
  type IssueBundle,
  type IssuePage,
  type IssueReference,
  type IssueRelationships,
  type IssueSummary,
  type IssueTimelineEvent,
  type NewIssueInput,
  type PrAgentAssignmentInput,
  type PrAgentAssignmentSummary,
  type PrAgentAssignmentWorkspace,
  type PrAgentReport,
  type PrCommentKind,
  type PrMinimizeReason,
  type PrReactionContent,
  type PrResolveOptions,
  type PrState,
  type Project,
  type PullRequestBundle,
  type PullRequestPage,
  type PullRequestSummary,
  type RepositoryMentionUser,
  type WorkflowRerunMode,
  type WorkflowRunFilter
} from '$shared/types'
import { buildGitStateUnits } from './git/git-units'

export {
  isBranchNotFullyMerged,
  isPushRejected,
  type DeleteBranchResult,
  type GitOperation,
  type GitPushResult
} from './git-store-helpers'

/**
 * How stale the remote-tracking refs may be before the app fetches on its own.
 *
 * `ahead` and `behind` are read from local remote-tracking refs, which only
 * move on a fetch, so without this the Pull and Push counts can sit stale for a
 * whole session. The fetch is fired when a project is opened - a thread opens
 * in it, its scope switches, or the app starts on it - so the counts are
 * already right by the time the user reaches the panel, instead of a round trip
 * starting under the click that asked the panel for something. The panel-open
 * hook re-checks the same gate, so a project left open for hours cannot sit on
 * stale counts either.
 *
 * Five minutes is the gate on every one of those triggers: opening a project
 * repeatedly, and the panel's rail icon, which refires on each refocus (files,
 * then notifications, then back to git), must never turn into a network round
 * trip per switch.
 */
export const REMOTE_FETCH_STALE_MS = 5 * 60_000

/**
 * How recently the working tree state must have been read for a hover warm-up to
 * leave it alone.
 *
 * The header chip is small and sits next to the account controls, so a pointer
 * crossing the header can enter it several times in a second. Each warm-up is six
 * repository reads with a git process spawn behind some of them, which is not
 * something a hover may repeat per pass.
 */
export const GIT_WARM_TTL_MS = 15_000

/**
 * How long a project's panel chrome stays reusable after it was read.
 *
 * Branches, identity, remotes, credential status and stashes are five separate
 * `git` spawns, and they answer questions that only move when the user acts,
 * which the mutation paths re-read live rather than reusing. Switching back to
 * a project inside this window therefore reuses the last answer instead of
 * spawning five processes again, which is what switching between projects in a
 * burst used to pay each time. The working tree read is never reused: it is
 * what the header chip and the file list show, so it always reads live.
 *
 * The window matches the switch path's other freshness bound, the process
 * count's 30s: both answer questions that only move when the user acts, and a
 * branch changed out of band is still corrected the moment the panel opens,
 * since that path reads live.
 */
export const GIT_CHROME_REUSE_MS = 30_000

/** Panel chrome read for one project and scope, kept for reuse. */
interface GitChromeSnapshot {
  branches: GitBranchInfo[]
  identity: GitIdentity
  remotes: GitRemoteInfo[]
  credentialStatus: GitCredentialStatus | null
  stashes: GitStashEntry[]
  readAt: number
}

/**
 * What a remote checkout's Git read is kept as between sessions.
 *
 * The working tree is what the panel paints, and the chrome is what its header
 * needs to be useful, so both are kept together: a cached tree with no branch
 * name would be a worse first paint than none.
 */
export interface CachedGitSurface {
  status: GitStatus
  branches: GitBranchInfo[]
  remotes: GitRemoteInfo[]
  stashes: GitStashEntry[]
}

/**
 * Per-project git runtime state, refreshed on panel activation, after every
 * app-driven mutation, and after agent turns land (`checkpoint.updated`).
 */
export class GitState {
  /**
   * One owner per concern. Each unit holds this engine and nothing else, so they
   * are safe to build first: none of them reads a field at construction.
   */
  readonly units = buildGitStateUnits(this)
  busy: Record<string, boolean> = $state({})

  /**
   * GitHub connection state, owned by the store. Every online git operation
   * awaits `ensureGitHubConnection()` first, so a cold start can never race
   * the connection: online checks simply run whenever the connection is ready.
   */
  githubConnection: 'unknown' | 'connecting' | 'connected' | 'disconnected' = $state('unknown')
  public githubProbe: Promise<boolean> | null = null
  lastGithubProbeAt = 0

  /**
   * The signed-in GitHub login, once a status probe has named one.
   *
   * The pull request reader needs it to tell the user's own comment from someone
   * else's: GitHub only exposes Edit and Delete to an author, and only hides the
   * Block action on yourself. Kept here rather than passed down from the panel so
   * the dock reader, the full screen reader and the panel menu all agree without
   * a prop chain through three components.
   */
  githubViewerLogin: string | null = $state(null)

  /**
   * The project whose data currently lives in the shared fields above. The
   * panel activates a project before reading, and async refreshes only write
   * their result when it still matches - so a slow response from the previous
   * project can never bleed into the one the user is actually viewing.
   */
  activeProjectId: string | null = $state(null)

  /**
   * The scope whose worktree (if any) the shared Git fields reflect. Keyed
   * alongside the active project so one scope can never display another
   * scope's state, and late responses for the prior target are suppressed.
   */
  activeScopeBucketId: string | null = $state(null)

  /**
   * Monotonic identity for the currently activated project/scope target.
   * Project ids alone cannot distinguish a fast A -> B -> A switch, so this
   * prevents the second A activation from reusing or accepting A's old work.
   */
  activationGeneration = 0
  public readonly scopeNotices = new SvelteMap<
    string,
    {
      error: string | null
      permission: GitHubPermissionRequired | null
    }
  >()

  // Not reactive rendered data - a plain dedup registry for agent-event
  // subscriptions, so SvelteSet is the wrong tool here.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  public subscriptions = new Set<string>()
  // In-flight request bookkeeping is intentionally non-reactive.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  public readonly refreshes = new Map<string, Promise<void>>()
  /**
   * When a fetch was last attempted, keyed by project, recorded whether it
   * succeeded or not. A remote that is refusing or unreachable is then retried
   * on the next window instead of on every project or panel open, which would
   * otherwise stall the panel behind a network timeout each time the user came
   * back to it.
   *
   * The key is the project rather than the scope bucket: managed scopes are
   * worktrees of one repository, and worktrees share `refs/remotes`, so a
   * fetch started from one of them already refreshes the refs every sibling
   * scope reads. Keying by scope would refetch on each scope switch inside the
   * same five minutes for no new information.
   */
  public fetchAttempts: Record<string, number> = {}

  /**
   * When the working tree state was last read for the active target. Plain, not
   * `$state`: only the hover warm-up's staleness gate reads it, and publishing
   * it would re-run the very effects that trigger a refresh.
   */
  statusReadAt = 0

  /**
   * Panel chrome already read per project and scope, so a switch back into a
   * project that was read moments ago reuses it instead of spawning five git
   * processes again. Keyed by target rather than held for the active project
   * alone, because the point is to have the answer when the user returns.
   */
  public readonly chromeByTarget = new SvelteMap<string, GitChromeSnapshot>()

  /**
   * Whether the working tree on screen is the last-known read kept for this
   * Oven, painted before the live read answers. Read by the pair of panels that
   * show Git, so a cached tree is dimmed and marked rather than passed off as
   * the checkout's current state.
   */
  public cachedStatus = $state(false)

  /**
   * Why the working-tree read itself failed, or null.
   *
   * Kept apart from `error`, which every Git surface writes to (a pull request
   * action, a deployment lookup, an authentication probe). The Oven surface
   * overlay answers for the checkout read and nothing else; sharing `error`
   * would let a failed pull request on a healthy Oven claim the Oven could not
   * be read.
   */
  public statusError = $state<string | null>(null)

  /** Local git state and operations: status, branches, remotes, stashes, conflicts. */
  public readonly local = new GitLocalOperations({
    markBusy: (operation, busy) => this.markBusy(operation, busy),
    scopeFor: (projectId) => this.scopeFor(projectId),
    scopedGitArgs: (projectId, ...args) => this.scopedGitArgs(projectId, ...args),
    refresh: (projectId) => this.refresh(projectId),
    readStatus: (projectId) => this.readStatus(projectId),
    isActiveTarget: (projectId) => projectId === this.activeProjectId,
    noteFetchAttempt: (projectId) => this.noteFetchAttempt(projectId),
    refreshConflictIndicators: (projectId, force) =>
      void this.refreshPrConflictIndicators(projectId, force)
  })

  /** Cached PR listings, detail bundles, mention users, and agent reports. */
  public readonly prs = new GitPullRequestCache(
    (operation, busy) => this.markBusy(operation, busy),
    (message) => (this.error = message)
  )

  /** Cached deployment overviews, details, and job logs. */
  public readonly deployments = new GitDeploymentCache(
    (operation, busy) => this.markBusy(operation, busy),
    (message) => (this.error = message),
    (permission) => (this.githubPermission = permission)
  )

  /** Open-PR conflict indicators, persisted across restarts. */
  public readonly conflicts = new GitPrConflictIndicators(
    () => this.remotes,
    () => this.activeProjectId,
    () => this.ensureGitHubConnection()
  )

  /** Online pull request mutations, backed by this store's shared state. */
  public readonly prOps = new GitPullRequestOperations({
    markBusy: (operation, busy) => this.markBusy(operation, busy),
    setError: (message) => (this.error = message),
    setGitHubPermission: (permission) => (this.githubPermission = permission),
    scopeFor: (projectId) => this.scopeFor(projectId),
    refreshConflictIndicators: (projectId, force) =>
      void this.refreshPrConflictIndicators(projectId, force),
    patchPullRequest: (owner, repo, pullNumber, patch) => {
      this.prs.patchPullRequest(owner, repo, pullNumber, patch)
      // A draft transition is drawn as a row of the conversation's history, so the
      // cached read is dropped along with the field that changed.
      this.issues.timelines.invalidate(owner, repo, pullNumber)
    },
    patchBundleReactions: (owner, repo, pullNumber, nodeId, groups) =>
      this.prs.patchBundleReactions(owner, repo, pullNumber, nodeId, groups),
    applyPullRequestState: (owner, repo, pullNumber, state) => {
      this.prs.applyPullRequestState(owner, repo, pullNumber, state)
      // A close, a reopen and a merge are each a row of the history, and they reach
      // here from the reader and from a listing batch alike, so the drop belongs on
      // this hook rather than on every caller.
      this.issues.timelines.invalidate(owner, repo, pullNumber)
    }
  })

  /** GitHub account auth calls. */
  public readonly github = new GitGitHubAuth(
    (message) => (this.error = message),
    (login) => (this.githubViewerLogin = login)
  )

  /** Cached issue listings and detail bundles. */
  public readonly issues = new GitIssueCache(
    (operation, busy) => this.markBusy(operation, busy),
    (message) => (this.error = message)
  )

  /** Online issue mutations, backed by this store's shared state. */
  public readonly issueOps = new GitIssueOperations({
    markBusy: (operation, busy) => this.markBusy(operation, busy),
    setError: (message) => (this.error = message),
    setGitHubPermission: (permission) => (this.githubPermission = permission),
    patchIssue: (owner, repo, issueNumber, patch) =>
      this.issues.patchIssue(owner, repo, issueNumber, patch),
    patchBundleReactions: (owner, repo, issueNumber, nodeId, groups) =>
      this.issues.patchBundleReactions(owner, repo, issueNumber, nodeId, groups),
    refreshIssueLinks: (projectId, owner, repo, issueNumber) => {
      this.issues.relationships.invalidate(owner, repo, issueNumber)
      this.issues.timelines.invalidate(owner, repo, issueNumber)
      void this.issues.relationships.ensure(projectId, owner, repo, issueNumber, true)
      void this.issues.timelines.ensure(projectId, owner, repo, issueNumber, true)
    }
  } satisfies GitIssueOperationAccess)

  get status(): GitStatus | null {
    return this.local.status
  }

  set status(value: GitStatus | null) {
    this.local.status = value
  }

  /**
   * The Oven checkout this panel's Git state belongs to, or null when the
   * active target is a local project.
   *
   * The active scope key is the one thing every read already targets, so it is
   * also what says whether the content came from an Oven and which one, without
   * re-reading the selected thread at render time.
   */
  get remoteTarget(): { threadId: string; ovenId: string } | null {
    return parseOvenRootKey(this.activeScopeBucketId)
  }

  /** Whether the working tree on screen is the last-known read from the Oven. */
  get showingCachedStatus(): boolean {
    return this.cachedStatus
  }

  /** Why the last working-tree read failed, for the Oven surface overlay. */
  get workingTreeError(): string | null {
    return this.statusError
  }

  get branches(): GitBranchInfo[] {
    return this.local.branches
  }

  set branches(value: GitBranchInfo[]) {
    this.local.branches = value
  }

  get remotes(): GitRemoteInfo[] {
    return this.local.remotes
  }

  set remotes(value: GitRemoteInfo[]) {
    this.local.remotes = value
  }

  get identity(): GitIdentity | null {
    return this.local.identity
  }

  set identity(value: GitIdentity | null) {
    this.local.identity = value
  }

  get credentialStatus(): GitCredentialStatus | null {
    return this.local.credentialStatus
  }

  set credentialStatus(value: GitCredentialStatus | null) {
    this.local.credentialStatus = value
  }

  get stashes(): GitStashEntry[] {
    return this.local.stashes
  }

  set stashes(value: GitStashEntry[]) {
    this.local.stashes = value
  }

  get error(): string | null {
    return this.local.error
  }

  set error(value: string | null) {
    this.local.error = value
  }

  get githubPermission(): GitHubPermissionRequired | null {
    return this.local.githubPermission
  }

  set githubPermission(value: GitHubPermissionRequired | null) {
    this.local.githubPermission = value
  }

  get conflictsMode(): boolean {
    return this.local.conflictsMode
  }

  set conflictsMode(value: boolean) {
    this.local.conflictsMode = value
  }

  get prResolveSession(): (PrResolveOptions & { projectId: string }) | null {
    return this.local.prResolveSession
  }

  set prResolveSession(value: (PrResolveOptions & { projectId: string }) | null) {
    this.local.prResolveSession = value
  }
  remoteIssueFor(projectId: string, scopeBucketId?: string): GitRemoteIssue | null {
    return this.units['queries'].remoteIssueFor(projectId, scopeBucketId)
  }

  get prPages(): Record<string, { page: PullRequestPage; fetchedAt: number }> {
    return this.prs.pages
  }

  get prBundles(): Record<string, PullRequestBundle> {
    return this.prs.bundles
  }

  get issuePages(): Record<string, { page: IssuePage; fetchedAt: number }> {
    return this.issues.pages
  }

  get issueBundles(): Record<string, IssueBundle> {
    return this.issues.bundles
  }
  conversationTimeline(owner: string, repo: string, number: number): IssueTimelineEvent[] {
    return this.units['runtime'].conversationTimeline(owner, repo, number)
  }

  get issueRelationships(): Record<string, CachedIssueRead<IssueRelationships>> {
    return this.issues.relationships.values
  }

  get prAgentReports(): Record<string, PrAgentReport[]> {
    return this.prs.agentReports
  }

  /** Row chips: what the list knows about each pull request's agent assignments. */
  get prAgentAssignments(): Record<string, PrAgentAssignmentSummary | null> {
    return this.prs.agentAssignments
  }

  get mentionUsers(): Record<string, { users: RepositoryMentionUser[]; fetchedAt: number }> {
    return this.prs.mentionUsers
  }

  get deploymentRunPages(): Record<string, { page: GitHubWorkflowRunPage; fetchedAt: number }> {
    return this.deployments.runPages
  }

  get deploymentPages(): Record<string, { page: GitHubDeploymentPage; fetchedAt: number }> {
    return this.deployments.deploymentPages
  }

  get deploymentDetails(): Record<string, { detail: GitHubDeploymentDetail; fetchedAt: number }> {
    return this.deployments.details
  }

  get deploymentRunDetails(): Record<
    string,
    { detail: GitHubWorkflowRunDetail; fetchedAt: number }
  > {
    return this.deployments.runDetails
  }

  get deploymentLogs(): Record<string, { log: GitHubDeploymentJobLog; fetchedAt: number }> {
    return this.deployments.logs
  }

  /**
   * Open PRs that need conflict resolution, keyed by `owner/repo`. This is the
   * single source of truth every subscribed surface (header button, PR list
   * rows, PR detail) reads from - seeded from local storage so it survives a
   * restart, then kept current by the store's own connection-gated refreshes.
   */
  get prConflictsByRepo(): Record<string, PullRequestSummary[]> {
    return this.conflicts.byRepo
  }

  get conflicted(): string[] {
    return this.status?.conflicted ?? []
  }

  get conflictState(): 'merge' | 'rebase' | 'none' {
    return this.status?.conflictState ?? 'none'
  }

  get clean(): boolean {
    return this.status?.clean ?? true
  }

  get branch(): string | null {
    return this.status?.branch ?? null
  }
  activate(projectId: string, scopeBucketId?: string): void {
    return this.units['lifecycle'].activate(projectId, scopeBucketId)
  }
  notifyScopeChanged(projectId: string, scopeBucketId: string): void {
    return this.units['runtime'].notifyScopeChanged(projectId, scopeBucketId)
  }
  scopeFor(projectId: string): string | undefined {
    return this.units['runtime'].scopeFor(projectId)
  }
  scopedGitArgs<Args extends unknown[]>(
    projectId: string,
    ...args: Args
  ): [string, ...Args, string | undefined] {
    return this.units['runtime'].scopedGitArgs(projectId, ...args)
  }
  async readStatus(projectId: string): Promise<GitStatus | null> {
    return this.units['queries'].readStatus(projectId)
  }
  deactivate(): void {
    return this.units['lifecycle'].deactivate()
  }
  notifyThreadOpened(project: Project | null, thread?: { scopeBucketId?: string } | null): void {
    return this.units['queries'].notifyThreadOpened(project, thread)
  }
  notifyAppStarted(project: Project | null): void {
    return this.units['lifecycle'].notifyAppStarted(project)
  }
  notifyGitPanelOpened(projectId: string): void {
    return this.units['panels'].notifyGitPanelOpened(projectId)
  }
  warmGitPanel(projectId: string): void {
    return this.units['panels'].warmGitPanel(projectId)
  }
  noteFetchAttempt(projectId: string): void {
    return this.units['runtime'].noteFetchAttempt(projectId)
  }
  async ensureGitHubConnection(): Promise<boolean> {
    return this.units['runtime'].ensureGitHubConnection()
  }

  /**
   * Number of open PRs with merge conflicts for the active project's origin
   * remote. Read from the persisted indicator so it's available immediately
   * on app restart; kept current by the store's connection-gated refreshes.
   */
  get activePrConflictCount(): number {
    return this.conflicts.activeCount
  }
  hasPrIssue(owner: string, repo: string, pullNumber: number): boolean {
    return this.units['queries'].hasPrIssue(owner, repo, pullNumber)
  }
  async refreshPrConflictIndicators(projectId: string, force = false): Promise<void> {
    return this.units['runtime'].refreshPrConflictIndicators(projectId, force)
  }
  isBusy(operation: GitOperation | GitOperation[]): boolean {
    return this.units['queries'].isBusy(operation)
  }
  markBusy(operation: GitOperation, busy: boolean): void {
    return this.units['runtime'].markBusy(operation, busy)
  }
  ensureProjectEvents(projectId: string): void {
    return this.units['runtime'].ensureProjectEvents(projectId)
  }
  async refresh(projectId: string, options: { reuseChrome?: boolean } = {}): Promise<void> {
    return this.units['runtime'].refresh(projectId, options)
  }
  stage(projectId: string, paths: string[]): Promise<void> {
    return this.units['runtime'].stage(projectId, paths)
  }
  analyzeConflict(projectId: string, path: string) {
    return this.units['runtime'].analyzeConflict(projectId, path)
  }
  prepareConflictWorkFile(projectId: string, path: string) {
    return this.units['runtime'].prepareConflictWorkFile(projectId, path)
  }
  saveConflictDraft(
    projectId: string,
    path: string,
    content: string,
    hunks: Parameters<GitLocalOperations['saveConflictDraft']>[3]
  ): Promise<boolean> {
    return this.units['runtime'].saveConflictDraft(projectId, path, content, hunks)
  }
  saveConflictResolution(projectId: string, path: string, content: string): Promise<boolean> {
    return this.units['runtime'].saveConflictResolution(projectId, path, content)
  }
  resolveConflicted(projectId: string, path: string): Promise<void> {
    return this.units['runtime'].resolveConflicted(projectId, path)
  }
  acceptConflictSide(
    projectId: string,
    side: Parameters<GitLocalOperations['acceptConflictSide']>[1]
  ): Promise<void> {
    return this.units['runtime'].acceptConflictSide(projectId, side)
  }
  unstage(projectId: string, paths: string[]): Promise<void> {
    return this.units['runtime'].unstage(projectId, paths)
  }
  commit(projectId: string, message: string): Promise<void> {
    return this.units['runtime'].commit(projectId, message)
  }
  initialize(projectId: string): Promise<void> {
    return this.units['runtime'].initialize(projectId)
  }
  checkout(projectId: string, branch: string): Promise<void> {
    return this.units['runtime'].checkout(projectId, branch)
  }
  createBranch(projectId: string, name: string): Promise<void> {
    return this.units['runtime'].createBranch(projectId, name)
  }
  createTrackingBranch(
    projectId: string,
    remote: string,
    branch: string,
    localName = branch
  ): Promise<void> {
    return this.units['runtime'].createTrackingBranch(projectId, remote, branch, localName)
  }
  deleteBranch(projectId: string, name: string, force = false) {
    return this.units['runtime'].deleteBranch(projectId, name, force)
  }
  deleteRemoteBranch(projectId: string, remote: string, name: string): Promise<void> {
    return this.units['runtime'].deleteRemoteBranch(projectId, remote, name)
  }
  setIdentity(projectId: string, name: string, email: string): Promise<void> {
    return this.units['runtime'].setIdentity(projectId, name, email)
  }
  getDiff(projectId: string, path: string, staged: boolean) {
    return this.units['queries'].getDiff(projectId, path, staged)
  }
  fetch(projectId: string): Promise<void> {
    return this.units['runtime'].fetch(projectId)
  }
  fetchBranch(projectId: string, remote: string, branch: string): Promise<void> {
    return this.units['runtime'].fetchBranch(projectId, remote, branch)
  }
  pull(projectId: string): Promise<void> {
    return this.units['runtime'].pull(projectId)
  }
  push(projectId: string, setUpstream: boolean, remote?: string, branch?: string) {
    return this.units['runtime'].push(projectId, setUpstream, remote, branch)
  }
  pullIntegrate(
    projectId: string,
    remote: string,
    branch: string,
    strategy: Parameters<GitLocalOperations['pullIntegrate']>[3]
  ): Promise<GitStatus | null> {
    return this.units['runtime'].pullIntegrate(projectId, remote, branch, strategy)
  }
  syncPeers(projectId: string, scopeBucketId?: string): Promise<GitSyncPeerOption[]> {
    return this.units['runtime'].syncPeers(projectId, scopeBucketId)
  }
  syncWith(
    projectId: string,
    scopeBucketId: string | undefined,
    options: Parameters<GitLocalOperations['syncWith']>[2]
  ) {
    return this.units['runtime'].syncWith(projectId, scopeBucketId, options)
  }
  addRemote(projectId: string, name: string, url: string): Promise<void> {
    return this.units['runtime'].addRemote(projectId, name, url)
  }
  setRemoteUrl(projectId: string, name: string, url: string): Promise<void> {
    return this.units['runtime'].setRemoteUrl(projectId, name, url)
  }
  removeRemote(projectId: string, name: string): Promise<void> {
    return this.units['runtime'].removeRemote(projectId, name)
  }
  setCredential(projectId: string, token: string): Promise<void> {
    return this.units['runtime'].setCredential(projectId, token)
  }
  removeCredential(projectId: string): Promise<void> {
    return this.units['runtime'].removeCredential(projectId)
  }
  merge(projectId: string, target: string) {
    return this.units['runtime'].merge(projectId, target)
  }
  rebase(projectId: string, target: string) {
    return this.units['runtime'].rebase(projectId, target)
  }
  abortMerge(projectId: string): Promise<void> {
    return this.units['runtime'].abortMerge(projectId)
  }
  abortRebase(projectId: string): Promise<void> {
    return this.units['runtime'].abortRebase(projectId)
  }
  rebaseAction(
    projectId: string,
    action: Parameters<GitLocalOperations['rebaseAction']>[1]
  ): Promise<void> {
    return this.units['commands'].rebaseAction(projectId, action)
  }
  preparePrResolve(
    projectId: string,
    options: Parameters<GitLocalOperations['preparePrResolve']>[1]
  ): Promise<void> {
    return this.units['runtime'].preparePrResolve(projectId, options)
  }
  finishPrResolve(projectId: string): Promise<boolean> {
    return this.units['queries'].finishPrResolve(projectId)
  }
  stash(projectId: string, message?: string, paths?: string[]): Promise<void> {
    return this.units['runtime'].stash(projectId, message, paths)
  }
  ignore(projectId: string, paths: string[]): Promise<void> {
    return this.units['runtime'].ignore(projectId, paths)
  }
  discard(projectId: string, paths: string[]): Promise<void> {
    return this.units['queries'].discard(projectId, paths)
  }
  popStash(projectId: string, id?: string): Promise<void> {
    return this.units['runtime'].popStash(projectId, id)
  }
  dropStash(projectId: string, id?: string): Promise<void> {
    return this.units['runtime'].dropStash(projectId, id)
  }
  getLog(projectId: string, limit = 30, offset = 0, query?: string) {
    return this.units['queries'].getLog(projectId, limit, offset, query)
  }
  getRemoteUpdates(projectId: string) {
    return this.units['queries'].getRemoteUpdates(projectId)
  }
  getCommitDiff(projectId: string, hash: string) {
    return this.units['queries'].getCommitDiff(projectId, hash)
  }
  getCommitFileDiff(projectId: string, hash: string, path: string) {
    return this.units['queries'].getCommitFileDiff(projectId, hash, path)
  }
  getStashDiff(projectId: string, id: string) {
    return this.units['queries'].getStashDiff(projectId, id)
  }
  getStashFileDiff(projectId: string, id: string, path: string) {
    return this.units['queries'].getStashFileDiff(projectId, id, path)
  }
  restoreFiles(
    projectId: string,
    source: string,
    paths: string[],
    target: Parameters<GitLocalOperations['restoreFiles']>[3]
  ): Promise<void> {
    return this.units['runtime'].restoreFiles(projectId, source, paths, target)
  }
  amend(projectId: string, message: string): Promise<void> {
    return this.units['runtime'].amend(projectId, message)
  }
  reset(
    projectId: string,
    mode: Parameters<GitLocalOperations['reset']>[1],
    target?: string
  ): Promise<void> {
    return this.units['runtime'].reset(projectId, mode, target)
  }
  deleteCommit(projectId: string, target: string): Promise<void> {
    return this.units['runtime'].deleteCommit(projectId, target)
  }
  removeCommitChanges(projectId: string, hash: string, paths: string[]): Promise<void> {
    return this.units['runtime'].removeCommitChanges(projectId, hash, paths)
  }
  createPullRequest(
    projectId: string,
    input: Parameters<GitPullRequestOperations['createPullRequest']>[1]
  ) {
    return this.units['runtime'].createPullRequest(projectId, input)
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
    return this.units['runtime'].mergePullRequest(
      projectId,
      owner,
      repo,
      pullNumber,
      method,
      commitTitle,
      commitMessage
    )
  }
  markPullRequestReadyForReview(
    projectId: string,
    owner: string,
    repo: string,
    pullNumber: number
  ) {
    return this.units['queries'].markPullRequestReadyForReview(projectId, owner, repo, pullNumber)
  }
  listPullRequests(
    projectId: string,
    owner: string,
    repo: string,
    state?: Parameters<GitPullRequestOperations['listPullRequests']>[3]
  ) {
    return this.units['queries'].listPullRequests(projectId, owner, repo, state)
  }
  getDefaultBranch(projectId: string) {
    return this.units['queries'].getDefaultBranch(projectId)
  }
  searchPullRequests(projectId: string, owner: string, repo: string, state: PrState, text: string) {
    return this.units['runtime'].searchPullRequests(projectId, owner, repo, state, text)
  }
  comparePullRequests(projectId: string, owner: string, repo: string, base: string, head: string) {
    return this.units['runtime'].comparePullRequests(projectId, owner, repo, base, head)
  }
  reopenPullRequest(projectId: string, owner: string, repo: string, pullNumber: number) {
    return this.units['runtime'].reopenPullRequest(projectId, owner, repo, pullNumber)
  }
  closePullRequest(projectId: string, owner: string, repo: string, pullNumber: number) {
    return this.units['runtime'].closePullRequest(projectId, owner, repo, pullNumber)
  }
  branchDeletionState(projectId: string, owner: string, repo: string, branch: string) {
    return this.units['storage'].branchDeletionState(projectId, owner, repo, branch)
  }
  deleteMergedBranch(projectId: string, owner: string, repo: string, branch: string) {
    return this.units['runtime'].deleteMergedBranch(projectId, owner, repo, branch)
  }
  closePullRequests(
    projectId: string,
    owner: string,
    repo: string,
    numbers: number[],
    comment: string | null = null,
    onStep?: PrBatchStepListener
  ) {
    return this.units['runtime'].closePullRequests(projectId, owner, repo, numbers, comment, onStep)
  }
  reopenPullRequests(
    projectId: string,
    owner: string,
    repo: string,
    numbers: number[],
    comment: string | null = null,
    onStep?: PrBatchStepListener
  ) {
    return this.units['runtime'].reopenPullRequests(
      projectId,
      owner,
      repo,
      numbers,
      comment,
      onStep
    )
  }
  setPullRequestLabels(
    projectId: string,
    owner: string,
    repo: string,
    pullNumber: number,
    labels: string[]
  ) {
    return this.units['runtime'].setPullRequestLabels(projectId, owner, repo, pullNumber, labels)
  }
  setPullRequestAssignees(
    projectId: string,
    owner: string,
    repo: string,
    pullNumber: number,
    logins: string[]
  ) {
    return this.units['runtime'].setPullRequestAssignees(projectId, owner, repo, pullNumber, logins)
  }
  setPullRequestMilestone(
    projectId: string,
    owner: string,
    repo: string,
    pullNumber: number,
    milestone: number | null
  ) {
    return this.units['runtime'].setPullRequestMilestone(
      projectId,
      owner,
      repo,
      pullNumber,
      milestone
    )
  }
  repositoryLabels(projectId: string, owner: string, repo: string) {
    return this.units['runtime'].repositoryLabels(projectId, owner, repo)
  }
  repositoryMilestones(projectId: string, owner: string, repo: string) {
    return this.units['runtime'].repositoryMilestones(projectId, owner, repo)
  }
  updatePullRequest(
    projectId: string,
    owner: string,
    repo: string,
    pullNumber: number,
    title: string | undefined,
    body: string | undefined
  ) {
    return this.units['runtime'].updatePullRequest(projectId, owner, repo, pullNumber, title, body)
  }
  composeWithAgent(
    projectId: string,
    virtualTaskId: string,
    settings: Parameters<GitPullRequestOperations['composeWithAgent']>[2],
    input: Parameters<GitPullRequestOperations['composeWithAgent']>[3]
  ) {
    return this.units['runtime'].composeWithAgent(projectId, virtualTaskId, settings, input)
  }
  commentOnPullRequest(
    projectId: string,
    owner: string,
    repo: string,
    pullNumber: number,
    body: string
  ) {
    return this.units['runtime'].commentOnPullRequest(projectId, owner, repo, pullNumber, body)
  }
  reviewPullRequest(
    projectId: string,
    owner: string,
    repo: string,
    pullNumber: number,
    event: Parameters<GitPullRequestOperations['reviewPullRequest']>[4],
    body: string
  ) {
    return this.units['runtime'].reviewPullRequest(projectId, owner, repo, pullNumber, event, body)
  }
  async createAgentAssignment(
    projectId: string,
    pullNumber: number,
    threadId: string,
    input: PrAgentAssignmentInput
  ): Promise<PrAgentAssignmentWorkspace | null> {
    return this.units['runtime'].createAgentAssignment(projectId, pullNumber, threadId, input)
  }
  ensurePullRequestPage(
    projectId: string,
    owner: string,
    repo: string,
    state: Parameters<GitPullRequestCache['ensurePullRequestPage']>[3],
    page: number,
    query: Parameters<GitPullRequestCache['ensurePullRequestPage']>[5],
    force = false
  ): Promise<void> {
    return this.units['runtime'].ensurePullRequestPage(
      projectId,
      owner,
      repo,
      state,
      page,
      query,
      force
    )
  }
  ensurePullRequestBundle(
    projectId: string,
    owner: string,
    repo: string,
    pullNumber: number,
    force = false
  ): Promise<void> {
    return this.units['runtime'].ensurePullRequestBundle(projectId, owner, repo, pullNumber, force)
  }
  preloadPullRequestBundle(
    projectId: string,
    owner: string,
    repo: string,
    pullNumber: number
  ): Promise<void> {
    return this.units['lifecycle'].preloadPullRequestBundle(projectId, owner, repo, pullNumber)
  }
  preloadPullRequestNextPage(
    projectId: string,
    owner: string,
    repo: string,
    state: Parameters<GitPullRequestCache['preloadPullRequestNextPage']>[3],
    page: number,
    query: Parameters<GitPullRequestCache['preloadPullRequestNextPage']>[5]
  ): Promise<void> {
    return this.units['lifecycle'].preloadPullRequestNextPage(
      projectId,
      owner,
      repo,
      state,
      page,
      query
    )
  }
  mentionUsersFor(projectId: string, owner: string, repo: string) {
    return this.units['runtime'].mentionUsersFor(projectId, owner, repo)
  }
  createIssue(projectId: string, input: NewIssueInput): Promise<IssueReference | null> {
    return this.units['queries'].createIssue(projectId, input)
  }
  updateIssue(
    projectId: string,
    owner: string,
    repo: string,
    issueNumber: number,
    title: string | undefined,
    body: string | undefined
  ): Promise<IssueReference | null> {
    return this.units['queries'].updateIssue(projectId, owner, repo, issueNumber, title, body)
  }
  setIssueState(
    projectId: string,
    owner: string,
    repo: string,
    issueNumber: number,
    state: 'open' | 'closed',
    stateReason?: 'completed' | 'not_planned'
  ): Promise<IssueReference | null> {
    return this.units['storage'].setIssueState(
      projectId,
      owner,
      repo,
      issueNumber,
      state,
      stateReason
    )
  }
  createIssueComment(
    projectId: string,
    owner: string,
    repo: string,
    issueNumber: number,
    body: string
  ): Promise<boolean> {
    return this.units['queries'].createIssueComment(projectId, owner, repo, issueNumber, body)
  }
  updateIssueComment(
    projectId: string,
    owner: string,
    repo: string,
    commentId: number,
    body: string
  ): Promise<boolean> {
    return this.units['queries'].updateIssueComment(projectId, owner, repo, commentId, body)
  }
  deleteIssueComment(
    projectId: string,
    owner: string,
    repo: string,
    commentId: number
  ): Promise<boolean> {
    return this.units['queries'].deleteIssueComment(projectId, owner, repo, commentId)
  }
  setIssueLabels(
    projectId: string,
    owner: string,
    repo: string,
    issueNumber: number,
    labels: string[]
  ) {
    return this.units['queries'].setIssueLabels(projectId, owner, repo, issueNumber, labels)
  }
  setIssueAssignees(
    projectId: string,
    owner: string,
    repo: string,
    issueNumber: number,
    logins: string[]
  ) {
    return this.units['queries'].setIssueAssignees(projectId, owner, repo, issueNumber, logins)
  }
  setIssueMilestone(
    projectId: string,
    owner: string,
    repo: string,
    issueNumber: number,
    milestone: number | null
  ) {
    return this.units['queries'].setIssueMilestone(projectId, owner, repo, issueNumber, milestone)
  }
  setIssueReaction(
    projectId: string,
    owner: string,
    repo: string,
    issueNumber: number,
    nodeId: string,
    content: PrReactionContent,
    add: boolean
  ): Promise<boolean> {
    return this.units['queries'].setIssueReaction(
      projectId,
      owner,
      repo,
      issueNumber,
      nodeId,
      content,
      add
    )
  }
  ensureIssuePage(
    projectId: string,
    owner: string,
    repo: string,
    state: Parameters<GitIssueCache['ensureIssuePage']>[3],
    page: number,
    query: Parameters<GitIssueCache['ensureIssuePage']>[5],
    force = false
  ): Promise<void> {
    return this.units['queries'].ensureIssuePage(projectId, owner, repo, state, page, query, force)
  }
  ensureIssueBundle(
    projectId: string,
    owner: string,
    repo: string,
    issueNumber: number,
    force = false
  ): Promise<void> {
    return this.units['queries'].ensureIssueBundle(projectId, owner, repo, issueNumber, force)
  }
  ensureConversationTimeline(
    projectId: string,
    owner: string,
    repo: string,
    number: number,
    force = false
  ): Promise<void> {
    return this.units['runtime'].ensureConversationTimeline(projectId, owner, repo, number, force)
  }
  ensureIssueRelationships(
    projectId: string,
    owner: string,
    repo: string,
    issueNumber: number,
    force = false
  ): Promise<void> {
    return this.units['queries'].ensureIssueRelationships(
      projectId,
      owner,
      repo,
      issueNumber,
      force
    )
  }
  invalidateConversationTimeline(owner: string, repo: string, number: number): void {
    return this.units['runtime'].invalidateConversationTimeline(owner, repo, number)
  }
  invalidateIssueRelationships(owner: string, repo: string, issueNumber: number): void {
    return this.units['queries'].invalidateIssueRelationships(owner, repo, issueNumber)
  }
  searchIssueCandidates(
    projectId: string,
    owner: string,
    repo: string,
    text: string
  ): Promise<IssueSummary[]> {
    return this.units['queries'].searchIssueCandidates(projectId, owner, repo, text)
  }
  addIssueSubIssue(
    projectId: string,
    owner: string,
    repo: string,
    issueNumber: number,
    issueNodeId: string,
    relatedNodeId: string
  ): Promise<boolean> {
    return this.units['queries'].addIssueSubIssue(
      projectId,
      owner,
      repo,
      issueNumber,
      issueNodeId,
      relatedNodeId
    )
  }
  removeIssueSubIssue(
    projectId: string,
    owner: string,
    repo: string,
    issueNumber: number,
    issueNodeId: string,
    relatedNodeId: string
  ): Promise<boolean> {
    return this.units['queries'].removeIssueSubIssue(
      projectId,
      owner,
      repo,
      issueNumber,
      issueNodeId,
      relatedNodeId
    )
  }
  addIssueBlockedBy(
    projectId: string,
    owner: string,
    repo: string,
    issueNumber: number,
    issueNodeId: string,
    relatedNodeId: string
  ): Promise<boolean> {
    return this.units['queries'].addIssueBlockedBy(
      projectId,
      owner,
      repo,
      issueNumber,
      issueNodeId,
      relatedNodeId
    )
  }
  removeIssueBlockedBy(
    projectId: string,
    owner: string,
    repo: string,
    issueNumber: number,
    issueNodeId: string,
    relatedNodeId: string
  ): Promise<boolean> {
    return this.units['queries'].removeIssueBlockedBy(
      projectId,
      owner,
      repo,
      issueNumber,
      issueNodeId,
      relatedNodeId
    )
  }
  preloadIssueBundle(
    projectId: string,
    owner: string,
    repo: string,
    issueNumber: number
  ): Promise<void> {
    return this.units['lifecycle'].preloadIssueBundle(projectId, owner, repo, issueNumber)
  }
  preloadIssueNextPage(
    projectId: string,
    owner: string,
    repo: string,
    state: Parameters<GitIssueCache['preloadIssueNextPage']>[3],
    page: number,
    query: Parameters<GitIssueCache['preloadIssueNextPage']>[5]
  ): Promise<void> {
    return this.units['lifecycle'].preloadIssueNextPage(projectId, owner, repo, state, page, query)
  }
  getCommitFiles(projectId: string, owner: string, repo: string, sha: string) {
    return this.units['queries'].getCommitFiles(projectId, owner, repo, sha)
  }
  loadAgentReports(projectId: string, pullNumber: number) {
    return this.units['lifecycle'].loadAgentReports(projectId, pullNumber)
  }
  ensureAgentAssignments(projectId: string, numbers: number[]) {
    return this.units['runtime'].ensureAgentAssignments(projectId, numbers)
  }
  ensureDeploymentActivity(
    projectId: string,
    owner: string,
    repo: string,
    force = false
  ): Promise<boolean | null> {
    return this.units['runtime'].ensureDeploymentActivity(projectId, owner, repo, force)
  }
  ensureWorkflowRunPage(
    projectId: string,
    owner: string,
    repo: string,
    filter: WorkflowRunFilter,
    page: number,
    force = false
  ): Promise<void> {
    return this.units['commands'].ensureWorkflowRunPage(projectId, owner, repo, filter, page, force)
  }
  ensureDeploymentPage(
    projectId: string,
    owner: string,
    repo: string,
    page: number,
    force = false
  ): Promise<void> {
    return this.units['runtime'].ensureDeploymentPage(projectId, owner, repo, page, force)
  }
  preloadWorkflowRunPage(
    projectId: string,
    owner: string,
    repo: string,
    filter: WorkflowRunFilter,
    page: number
  ): Promise<void> {
    return this.units['lifecycle'].preloadWorkflowRunPage(projectId, owner, repo, filter, page)
  }
  preloadDeploymentPage(
    projectId: string,
    owner: string,
    repo: string,
    page: number
  ): Promise<void> {
    return this.units['lifecycle'].preloadDeploymentPage(projectId, owner, repo, page)
  }
  refreshDeploymentPages(projectId: string, owner: string, repo: string): Promise<void> {
    return this.units['runtime'].refreshDeploymentPages(projectId, owner, repo)
  }
  ensureDeploymentDetail(
    projectId: string,
    owner: string,
    repo: string,
    deploymentId: number,
    force = false
  ): Promise<GitHubDeploymentDetail | null> {
    return this.units['runtime'].ensureDeploymentDetail(projectId, owner, repo, deploymentId, force)
  }
  ensureWorkflowRunDetail(
    projectId: string,
    owner: string,
    repo: string,
    runId: number,
    force = false
  ): Promise<GitHubWorkflowRunDetail | null> {
    return this.units['commands'].ensureWorkflowRunDetail(projectId, owner, repo, runId, force)
  }
  ensureDeploymentJobLog(
    projectId: string,
    owner: string,
    repo: string,
    jobId: number,
    force = false
  ): Promise<GitHubDeploymentJobLog | null> {
    return this.units['runtime'].ensureDeploymentJobLog(projectId, owner, repo, jobId, force)
  }
  githubAuthStatus() {
    return this.units['queries'].githubAuthStatus()
  }
  rerunWorkflowRun(
    projectId: string,
    owner: string,
    repo: string,
    runId: number,
    mode: WorkflowRerunMode
  ): Promise<boolean> {
    return this.units['commands'].rerunWorkflowRun(projectId, owner, repo, runId, mode)
  }
  cancelWorkflowRun(
    projectId: string,
    owner: string,
    repo: string,
    runId: number
  ): Promise<boolean> {
    return this.units['commands'].cancelWorkflowRun(projectId, owner, repo, runId)
  }
  startGitHubDeviceFlow() {
    return this.units['lifecycle'].startGitHubDeviceFlow()
  }
  switchGitHubAccount(accountId: string): Promise<GitHubAuthStatus> {
    return this.units['runtime'].switchGitHubAccount(accountId)
  }
  pollGitHubDeviceCode(deviceCode: string) {
    return this.units['runtime'].pollGitHubDeviceCode(deviceCode)
  }
  logoutGitHub() {
    return this.units['runtime'].logoutGitHub()
  }
  editPrComment(
    projectId: string,
    owner: string,
    repo: string,
    pullNumber: number,
    kind: PrCommentKind,
    commentId: number,
    body: string
  ): Promise<boolean> {
    return this.units['runtime'].editPrComment(
      projectId,
      owner,
      repo,
      pullNumber,
      kind,
      commentId,
      body
    )
  }
  deletePrComment(
    projectId: string,
    owner: string,
    repo: string,
    pullNumber: number,
    kind: PrCommentKind,
    commentId: number
  ): Promise<boolean> {
    return this.units['runtime'].deletePrComment(
      projectId,
      owner,
      repo,
      pullNumber,
      kind,
      commentId
    )
  }
  replyToPrReviewComment(
    projectId: string,
    owner: string,
    repo: string,
    pullNumber: number,
    commentId: number,
    body: string
  ): Promise<boolean> {
    return this.units['runtime'].replyToPrReviewComment(
      projectId,
      owner,
      repo,
      pullNumber,
      commentId,
      body
    )
  }
  setPrReviewThreadResolved(
    projectId: string,
    owner: string,
    repo: string,
    pullNumber: number,
    threadNodeId: string,
    resolved: boolean
  ): Promise<boolean> {
    return this.units['queries'].setPrReviewThreadResolved(
      projectId,
      owner,
      repo,
      pullNumber,
      threadNodeId,
      resolved
    )
  }
  setPrCommentReaction(
    projectId: string,
    owner: string,
    repo: string,
    pullNumber: number,
    nodeId: string,
    content: PrReactionContent,
    add: boolean
  ): Promise<boolean> {
    return this.units['commands'].setPrCommentReaction(
      projectId,
      owner,
      repo,
      pullNumber,
      nodeId,
      content,
      add
    )
  }
  minimizePrComment(
    projectId: string,
    owner: string,
    repo: string,
    pullNumber: number,
    nodeId: string,
    reason: PrMinimizeReason
  ): Promise<boolean> {
    return this.units['runtime'].minimizePrComment(
      projectId,
      owner,
      repo,
      pullNumber,
      nodeId,
      reason
    )
  }

  static pageKey(
    owner: string,
    repo: string,
    state: string,
    filter: string,
    sort: string,
    page: number
  ): string {
    return prPageKey(owner, repo, state, filter, sort, page)
  }

  static bundleKey(owner: string, repo: string, pullNumber: number): string {
    return prBundleKey(owner, repo, pullNumber)
  }

  /** Cache key for one page of the issue listing, mirroring `pageKey`. */
  static issuePageKey(
    owner: string,
    repo: string,
    state: string,
    filter: string,
    sort: string,
    page: number
  ): string {
    return issuePageKey(owner, repo, state, filter, sort, page)
  }

  /** Cache key for one issue's detail bundle. */
  static issueBundleKey(owner: string, repo: string, issueNumber: number): string {
    return issueBundleKey(owner, repo, issueNumber)
  }

  static deploymentKey(owner: string, repo: string): string {
    return deploymentKey(owner, repo)
  }

  /** Cache key for one page of workflow runs, under the filter that produced it. */
  static workflowRunPageKey(
    owner: string,
    repo: string,
    filter: WorkflowRunFilter,
    page: number
  ): string {
    return workflowRunPageKey(owner, repo, filter, page)
  }

  /** Cache key for one page of deployments, mirroring `workflowRunPageKey`. */
  static deploymentPageKey(owner: string, repo: string, page: number): string {
    return deploymentPageKey(owner, repo, page)
  }

  static deploymentDetailKey(owner: string, repo: string, deploymentId: number): string {
    return deploymentDetailKey(owner, repo, deploymentId)
  }

  static workflowRunKey(owner: string, repo: string, runId: number): string {
    return workflowRunKey(owner, repo, runId)
  }

  static deploymentLogKey(owner: string, repo: string, jobId: number): string {
    return deploymentLogKey(owner, repo, jobId)
  }
}

export const gitState = new GitState()
