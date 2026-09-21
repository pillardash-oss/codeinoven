import { invoke, subscribe } from '$lib/ipc.svelte'
import { scheduleDeferredWork } from '$lib/deferred-work'
import { loadRepositoryPreflight } from '$lib/repository-preflight-cache'
import {
  GITHUB_PROBE_TTL_MS,
  deploymentDetailKey,
  deploymentKey,
  deploymentLogKey,
  errorMessage,
  prBundleKey,
  prPageKey,
  workflowRunKey,
  type GitOperation
} from './git-store-helpers'
import { GitDeploymentCache } from './git-store-deployments.svelte'
import { GitPullRequestCache } from './git-store-pull-requests.svelte'
import { GitPrConflictIndicators } from './git-store-pr-conflicts.svelte'
import { GitPullRequestOperations } from './git-store-pr-operations.svelte'
import { GitGitHubAuth } from './git-store-github.svelte'
import { GitLocalOperations } from './git-store-local-operations.svelte'
import type {
  GitIdentity,
  GitStatus,
  GitSyncPeerOption,
  Project,
  GitBranchInfo,
  GitRemoteInfo,
  GitCredentialStatus,
  GitStashEntry,
  GitHubDeploymentDetail,
  GitHubDeploymentJobLog,
  GitHubDeploymentOverviewResult,
  GitHubPermissionRequired,
  GitHubWorkflowRunDetail,
  PrAgentReport,
  PrCommentKind,
  PrMinimizeReason,
  PrResolveOptions,
  PullRequestBundle,
  PullRequestPage,
  PullRequestSummary,
  RepositoryMentionUser,
  WorkflowRerunMode
} from '$shared/types'
import { INBOX_PROJECT_ID } from '$shared/types'

export {
  isBranchNotFullyMerged,
  isPushRejected,
  type DeleteBranchResult,
  type GitOperation,
  type GitPushResult
} from './git-store-helpers'

/**
 * How stale the remote-tracking refs may be when the git panel is opened
 * before it fetches on its own.
 *
 * `ahead` and `behind` are read from local remote-tracking refs, which only
 * move on a fetch, so without this the Pull and Push counts can sit stale for a
 * whole session. The panel-open hook fires on every refocus of the panel's rail
 * icon (files, then notifications, then back to git), so an unthrottled fetch
 * would hit the network on each flip. Five minutes keeps the counts honest at
 * the moment the user looks, without turning icon switching into network
 * traffic.
 */
const PANEL_FETCH_STALE_MS = 5 * 60_000

/**
 * How recently the working tree state must have been read for a hover warm-up to
 * leave it alone.
 *
 * The header chip is small and sits next to the account controls, so a pointer
 * crossing the header can enter it several times in a second. Each warm-up is six
 * repository reads with a git process spawn behind some of them, which is not
 * something a hover may repeat per pass.
 */
const GIT_WARM_TTL_MS = 15_000

/**
 * Per-project git runtime state, refreshed on panel activation, after every
 * app-driven mutation, and after agent turns land (`checkpoint.updated`).
 */
export class GitState {
  busy: Record<string, boolean> = $state({})

  /**
   * GitHub connection state, owned by the store. Every online git operation
   * awaits `ensureGitHubConnection()` first, so a cold start can never race
   * the connection: online checks simply run whenever the connection is ready.
   */
  githubConnection: 'unknown' | 'connecting' | 'connected' | 'disconnected' = $state('unknown')
  private githubProbe: Promise<boolean> | null = null
  private lastGithubProbeAt = 0

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
  private activationGeneration = 0

  // Not reactive rendered data - a plain dedup registry for agent-event
  // subscriptions, so SvelteSet is the wrong tool here.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  private subscriptions = new Set<string>()
  // In-flight request bookkeeping is intentionally non-reactive.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  private readonly refreshes = new Map<string, Promise<void>>()
  /**
   * When a fetch was last attempted, keyed by project, recorded whether it
   * succeeded or not. A remote that is refusing or unreachable is then retried
   * on the next window instead of on every panel open, which would otherwise
   * stall the panel behind a network timeout each time the user came back to
   * it.
   *
   * The key is the project rather than the scope bucket: managed scopes are
   * worktrees of one repository, and worktrees share `refs/remotes`, so a
   * fetch started from one of them already refreshes the refs every sibling
   * scope reads. Keying by scope would refetch on each scope switch inside the
   * same five minutes for no new information.
   */
  private fetchAttempts: Record<string, number> = {}

  /**
   * When the working tree state was last read for the active target. Plain, not
   * `$state`: only the hover warm-up's staleness gate reads it, and publishing
   * it would re-run the very effects that trigger a refresh.
   */
  private statusReadAt = 0

  /** Local git state and operations: status, branches, remotes, stashes, conflicts. */
  private readonly local = new GitLocalOperations({
    markBusy: (operation, busy) => this.markBusy(operation, busy),
    scopeFor: (projectId) => this.scopeFor(projectId),
    scopedGitArgs: (projectId, ...args) => this.scopedGitArgs(projectId, ...args),
    refresh: (projectId) => this.refresh(projectId),
    readStatus: (projectId) => this.readStatus(projectId),
    noteFetchAttempt: (projectId) => this.noteFetchAttempt(projectId),
    refreshConflictIndicators: (projectId, force) =>
      void this.refreshPrConflictIndicators(projectId, force)
  })

  /** Cached PR listings, detail bundles, mention users, and agent reports. */
  private readonly prs = new GitPullRequestCache(
    (operation, busy) => this.markBusy(operation, busy),
    (message) => (this.error = message)
  )

  /** Cached deployment overviews, details, and job logs. */
  private readonly deployments = new GitDeploymentCache(
    (operation, busy) => this.markBusy(operation, busy),
    (message) => (this.error = message),
    (permission) => (this.githubPermission = permission)
  )

  /** Open-PR conflict indicators, persisted across restarts. */
  private readonly conflicts = new GitPrConflictIndicators(
    () => this.remotes,
    () => this.activeProjectId,
    () => this.ensureGitHubConnection()
  )

  /** Online pull request mutations, backed by this store's shared state. */
  private readonly prOps = new GitPullRequestOperations({
    markBusy: (operation, busy) => this.markBusy(operation, busy),
    setError: (message) => (this.error = message),
    setGitHubPermission: (permission) => (this.githubPermission = permission),
    scopeFor: (projectId) => this.scopeFor(projectId),
    refreshConflictIndicators: (projectId, force) =>
      void this.refreshPrConflictIndicators(projectId, force),
    updateDraftState: (owner, repo, pullNumber, draft) =>
      this.prs.updateDraftState(owner, repo, pullNumber, draft)
  })

  /** GitHub account auth calls. */
  private readonly github = new GitGitHubAuth(
    (message) => (this.error = message),
    (login) => (this.githubViewerLogin = login)
  )

  get status(): GitStatus | null {
    return this.local.status
  }

  set status(value: GitStatus | null) {
    this.local.status = value
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

  get prPages(): Record<string, { page: PullRequestPage; fetchedAt: number }> {
    return this.prs.pages
  }

  get prBundles(): Record<string, PullRequestBundle> {
    return this.prs.bundles
  }

  get prAgentReports(): Record<string, PrAgentReport> {
    return this.prs.agentReports
  }

  get mentionUsers(): Record<string, { users: RepositoryMentionUser[]; fetchedAt: number }> {
    return this.prs.mentionUsers
  }

  get deploymentOverviews(): Record<
    string,
    { overview: GitHubDeploymentOverviewResult; fetchedAt: number }
  > {
    return this.deployments.overviews
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

  /** Switch the panel to a project, dropping any leftover state from the
   *  previous one so stale data is never shown. */
  activate(projectId: string, scopeBucketId?: string): void {
    const nextScopeBucketId = scopeBucketId ?? null
    if (this.activeProjectId === projectId && this.activeScopeBucketId === nextScopeBucketId) return
    this.activationGeneration += 1
    this.activeProjectId = projectId
    this.activeScopeBucketId = nextScopeBucketId
    this.clearProjectState()
  }

  /**
   * Scope-sensitive activation: called when a thread moves between scopes
   * while the Git panel stays open. Re-resolves status for the new root so
   * sibling worktrees never display each other's state.
   */
  notifyScopeChanged(projectId: string, scopeBucketId: string): void {
    this.activationGeneration += 1
    this.activeProjectId = projectId
    this.activeScopeBucketId = scopeBucketId
    this.clearProjectState()
    this.scheduleRefresh(projectId)
  }

  /** The scope-qualified Git target used by status reads. */
  private statusTarget(projectId: string): [string, string | null] {
    const project = this.activeProjectId === projectId ? this.activeScopeBucketId : null
    return [projectId, project]
  }

  private scopeFor(projectId: string): string | undefined {
    return this.activeProjectId === projectId ? (this.activeScopeBucketId ?? undefined) : undefined
  }

  /**
   * Append the active scope bucket id to a git:* local-repository invoke so the
   * operation runs against the worktree (when one is active) instead of always
   * reaching the project root. `undefined` is forwarded as-is for project-root
   * callers, keeping backward compatibility.
   */
  private scopedGitArgs<Args extends unknown[]>(
    projectId: string,
    ...args: Args
  ): [string, ...Args, string | undefined] {
    const scope = this.scopeFor(projectId)
    return [projectId, ...args, scope ?? undefined]
  }

  private async readStatus(projectId: string): Promise<GitStatus | null> {
    const [id, scope] = this.statusTarget(projectId)
    const status = (await invoke('git:status', id, scope ?? undefined)) as
      GitStatus | null | undefined
    if (!status) return null
    return status
  }

  /** Clear Git state when the active thread has no Git-capable project. */
  deactivate(): void {
    if (this.activeProjectId === null) return
    this.activationGeneration += 1
    this.activeProjectId = null
    this.clearProjectState()
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
    const scopeBucketId = thread?.scopeBucketId ?? null
    // A scope target is what Git cares about, not a thread. Switching between
    // two threads of the same project and scope changes nothing here, so this
    // returns before touching status: no read, no blank panel, no worktree
    // discovery.
    const targetChanged =
      this.activeProjectId !== project.id || this.activeScopeBucketId !== scopeBucketId
    // Claim the target synchronously so the panel can never show another
    // scope's state, then read the new one *after* the switch has painted.
    this.activate(project.id, thread?.scopeBucketId ?? undefined)
    if (!targetChanged) return
    this.scheduleRefresh(project.id)
  }

  /**
   * Queue a status/branches/PR read for after the current view switch has
   * painted. This only runs when the scope target actually moves   a thread
   * switch inside one scope never reaches it, because `activate` and
   * `targetChanged` both short-circuit above. When it does run it fans out to
   * six repository reads plus worktree discovery, and running all of that in
   * the same instant as the conversation mount made a scope switch feel slow.
   * Deferring it keeps the panel's data honestly late rather than the
   * conversation's paint honestly slow.
   */
  private scheduleRefresh(projectId: string): void {
    scheduleDeferredWork('git:refresh', () => void this.refresh(projectId).catch(() => {}))
  }

  /**
   * App-start hook: when the application launches it checks the active project
   * asynchronously - connection first (the store guarantees it), then the PR
   * indicator - even if no thread is restored yet (fresh start, or the last
   * session ended on a chat). No-ops when a thread already opened, since
   * `notifyThreadOpened` already refreshed that project.
   */
  notifyAppStarted(project: Project | null): void {
    if (this.activeProjectId) return
    if (!project || project.id === INBOX_PROJECT_ID) return
    if (project.source !== 'local' || project.changeTrackingMode !== 'git') return
    if (!project.path.trim()) return
    this.activate(project.id)
    queueMicrotask(() => void this.refresh(project.id).catch(() => {}))
  }

  /**
   * Panel-open hook: opening the git panel refreshes local status and the
   * connection-gated PR indicators immediately, so what the user sees is
   * never older than the moment they asked for it. When the remote-tracking
   * refs have gone stale it also fetches, because `ahead` and `behind` come
   * from those local refs: without that fetch a branch could sit behind the
   * server, or ahead of it, with nothing in the panel saying so until the user
   * went looking for Fetch in the menu.
   *
   * The git tool opens from its own rail icon rather than a tab strip, so
   * this fires on every refocus (files → git, notifications → git …). It
   * must therefore never reset the claimed target: `activate(projectId)`
   * without a scope would demote an already-claimed worktree bucket to null,
   * wiping status/branches and forcing the whole panel to visually rebuild.
   * Claiming happens properly elsewhere - the panel's own effect passes the
   * real scope bucket; here we preserve whatever is already active.
   */
  notifyGitPanelOpened(projectId: string): void {
    if (this.activeProjectId !== projectId) return
    queueMicrotask(() => {
      // Local state first: it is what the panel paints, and it is also what
      // says whether there is a remote worth fetching from. The fetch re-reads
      // that state when it finishes, so the second read only happens on the
      // opens the stale gate lets through.
      void this.refresh(projectId)
        .then(() => {
          if (this.activeProjectId !== projectId) return
          if (!this.fetchIsDue(projectId)) return
          return this.fetch(projectId)
        })
        .catch(() => {})
    })
  }

  /**
   * Warm the Git panel from outside it, for a pointer that is about to open it.
   *
   * Two things sit on the panel's cold path and neither is data the user asked
   * for yet: the repository preflight (a git process spawn, behind which the
   * whole panel hides as "Checking repository"), and the working tree read. The
   * first is filled unconditionally because it is cached per project and shared
   * with the panel, so the panel's own mount finds it already answered. The
   * second is left alone unless it has gone stale, because a hover is a guess and
   * six repository reads is too much to repeat on every pass over the chip.
   *
   * The refresh it does run is a real one and marks Git busy like any other. That
   * is invisible from here because the only caller warms a panel that is closed,
   * and the refresh button is the only thing in the app that reads that flag; a
   * warm-up would otherwise spin it for a click that never came.
   */
  warmGitPanel(projectId: string): void {
    if (!projectId || projectId === INBOX_PROJECT_ID || projectId !== this.activeProjectId) return
    void loadRepositoryPreflight(projectId).catch(() => undefined)
    if (Date.now() - this.statusReadAt < GIT_WARM_TTL_MS) return
    void this.refresh(projectId).catch(() => undefined)
  }

  /**
   * Whether the age-gated panel-open fetch is due. A repository without a
   * remote has nothing to fetch, and anything already attempted inside the
   * window is left alone, which is what keeps repeated panel opens from
   * becoming repeated network round trips.
   */
  private fetchIsDue(projectId: string): boolean {
    if (this.remotes.length === 0) return false
    return Date.now() - (this.fetchAttempts[projectId] ?? 0) >= PANEL_FETCH_STALE_MS
  }

  /** Record that a fetch was tried, so the panel-open gate can throttle it. */
  private noteFetchAttempt(projectId: string): void {
    this.fetchAttempts[projectId] = Date.now()
  }

  /**
   * Guarantee the GitHub connection before any online git operation. Offline
   * operations (status, stage, commit, stash…) never touch this - only online
   * ones (pull requests, deployments) await it. A negative probe is always
   * re-checked, so signing in mid-session is picked up on the next attempt.
   */
  async ensureGitHubConnection(): Promise<boolean> {
    if (this.githubConnection === 'connected') return true
    if (this.githubProbe) return this.githubProbe
    this.githubProbe = this.probeGitHubConnection()
    try {
      return await this.githubProbe
    } finally {
      this.githubProbe = null
    }
  }

  private async probeGitHubConnection(): Promise<boolean> {
    const now = Date.now()
    // A positive probe is trusted briefly; a negative one always re-probes.
    if (
      this.githubConnection === 'connected' &&
      now - this.lastGithubProbeAt < GITHUB_PROBE_TTL_MS
    ) {
      return true
    }
    this.lastGithubProbeAt = now
    this.githubConnection = 'connecting'
    const status = await this.githubAuthStatus()
    const connected = status.connected
    this.githubConnection = connected ? 'connected' : 'disconnected'
    if (connected && this.activeProjectId) {
      // The connection just became ready - run the online refreshes now
      // instead of waiting for the next poll tick.
      void this.refreshPrConflictIndicators(this.activeProjectId)
    }
    return connected
  }

  private clearProjectState(): void {
    this.status = null
    this.branches = []
    this.remotes = []
    this.identity = null
    this.credentialStatus = null
    this.stashes = []
    this.error = null
    this.githubPermission = null
    this.conflictsMode = false
    this.statusReadAt = 0
  }

  /**
   * Number of open PRs with merge conflicts for the active project's origin
   * remote. Read from the persisted indicator so it's available immediately
   * on app restart; kept current by the store's connection-gated refreshes.
   */
  get activePrConflictCount(): number {
    return this.conflicts.activeCount
  }

  /**
   * Whether an open PR currently needs conflict resolution. All indicator UI
   * (header button, PR list rows, PR detail) reads this one store-owned fact,
   * so every subscribed surface shows exactly the same state.
   */
  hasPrIssue(owner: string, repo: string, pullNumber: number): boolean {
    return this.conflicts.hasIssue(owner, repo, pullNumber)
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
    return this.conflicts.refresh(projectId, force)
  }

  isBusy(operation: GitOperation | GitOperation[]): boolean {
    const operations = Array.isArray(operation) ? operation : [operation]
    return operations.some((name) => this.busy[name] === true)
  }

  markBusy(operation: GitOperation, busy: boolean): void {
    // No-op when the value is unchanged, so a repeated mark during an in-flight
    // async load never rewrites `busy` (which would re-trigger dependents and
    // can escalate into an effect_update_depth_exceeded loop).
    if (this.busy[operation] === busy) return
    this.busy = { ...this.busy, [operation]: busy }
  }

  /** Subscribe to agent turn completion so the panel reflects external changes. */
  ensureProjectEvents(projectId: string): void {
    if (projectId === INBOX_PROJECT_ID) return
    if (this.subscriptions.has(projectId)) return
    this.subscriptions.add(projectId)
    subscribe('agent:event', (...args: unknown[]) => {
      const event = args[0] as { type: string; projectId?: string } | undefined
      if (event?.type === 'checkpoint.updated' && event.projectId === projectId) {
        void this.refresh(projectId).catch(() => {})
      }
    })
  }

  async refresh(projectId: string): Promise<void> {
    if (projectId === INBOX_PROJECT_ID || projectId !== this.activeProjectId) return
    const scopeBucketId = this.scopeFor(projectId)
    const generation = this.activationGeneration
    const targetKey = `${generation}:${projectId}:${scopeBucketId ?? ''}`
    const inflight = this.refreshes.get(targetKey)
    if (inflight) return inflight

    const refresh = this.runRefresh(projectId, generation)
    this.refreshes.set(targetKey, refresh)
    try {
      await refresh
    } finally {
      if (this.refreshes.get(targetKey) === refresh) this.refreshes.delete(targetKey)
    }
  }

  private async runRefresh(projectId: string, generation: number): Promise<void> {
    this.markBusy('refresh', true)
    // The refresh targets whichever project is active right now; if the panel
    // has already switched to another project, the result is stale and must
    // never be written.
    const targetProject = this.activeProjectId
    const targetScope = this.activeScopeBucketId
    const stillCurrent = (): boolean =>
      targetProject === this.activeProjectId &&
      targetScope === this.activeScopeBucketId &&
      generation === this.activationGeneration &&
      projectId === this.activeProjectId
    /** Whether this round has already published working tree state. */
    let publishedStatus = false
    this.error = null
    try {
      // The chrome reads are started first so they overlap the status read, but
      // nothing downstream waits on them. Staging and committing are local
      // operations on the working tree and must never be held behind a branch
      // listing, a remote listing, or the OS keychain probe that answers
      // whether a credential is stored. A single `Promise.all` over all six
      // reads did exactly that: `status` was only published once the slowest of
      // them had answered, which is what made a local operation look like it was
      // waiting on the network.
      const chrome = Promise.all([
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

      const status = await this.readStatus(projectId)
      if (!stillCurrent()) return
      if (!status) {
        this.error = 'Git status could not be loaded'
        this.status = null
        return
      }
      this.status = status
      publishedStatus = true
      this.statusReadAt = Date.now()
      // Conflicts mode is only meaningful while actual conflicts exist - once
      // they are all resolved the filter auto-closes, like the last-turn one.
      // Decided here, off the status alone, so the filter settles without
      // waiting for the chrome reads below.
      if (status.conflicted.length === 0) this.conflictsMode = false

      const [branches, identity, remotes, credentialStatus, stashes] = await chrome
      if (!stillCurrent()) return
      this.branches = branches
      // A recorded PR-conflict session is only real while its temporary
      // `pr-<n>` branch still exists: once the branch is gone (finished, or
      // deleted by hand) the session must not keep offering a merge to
      // complete.
      const session = this.prResolveSession
      if (
        session &&
        !branches.some(
          (branch) => branch.kind === 'local' && branch.name === `pr-${session.pullNumber}`
        )
      ) {
        this.prResolveSession = null
      }
      this.identity = identity
      this.remotes = Array.isArray(remotes) ? remotes : []
      this.credentialStatus = credentialStatus
      this.stashes = stashes
      // Refresh the open-PR conflict indicator (cooldown-gated) so the header
      // badge stays current without a GitHub round trip on every mutation.
      void this.refreshPrConflictIndicators(projectId).catch(() => {})
    } catch (reason) {
      if (!stillCurrent()) return
      this.error = errorMessage(reason, 'Git status could not be loaded')
      // A chrome read is what failed here when status has already landed, and a
      // failed branch listing is not a reason to stop staging files: the
      // published status is left in place and only its own failure clears it.
      if (!publishedStatus) this.status = null
    } finally {
      this.markBusy('refresh', false)
    }
  }

  // Local git operations, delegated to the state they mutate.
  stage(projectId: string, paths: string[]): Promise<void> {
    return this.local.stage(projectId, paths)
  }

  analyzeConflict(projectId: string, path: string) {
    return this.local.analyzeConflict(projectId, path)
  }

  prepareConflictWorkFile(projectId: string, path: string) {
    return this.local.prepareConflictWorkFile(projectId, path)
  }

  saveConflictDraft(
    projectId: string,
    path: string,
    content: string,
    hunks: Parameters<GitLocalOperations['saveConflictDraft']>[3]
  ): Promise<boolean> {
    return this.local.saveConflictDraft(projectId, path, content, hunks)
  }

  saveConflictResolution(projectId: string, path: string, content: string): Promise<boolean> {
    return this.local.saveConflictResolution(projectId, path, content)
  }

  resolveConflicted(projectId: string, path: string): Promise<void> {
    return this.local.resolveConflicted(projectId, path)
  }

  acceptConflictSide(
    projectId: string,
    side: Parameters<GitLocalOperations['acceptConflictSide']>[1]
  ): Promise<void> {
    return this.local.acceptConflictSide(projectId, side)
  }

  unstage(projectId: string, paths: string[]): Promise<void> {
    return this.local.unstage(projectId, paths)
  }

  commit(projectId: string, message: string): Promise<void> {
    return this.local.commit(projectId, message)
  }

  initialize(projectId: string): Promise<void> {
    return this.local.initialize(projectId)
  }

  checkout(projectId: string, branch: string): Promise<void> {
    return this.local.checkout(projectId, branch)
  }

  createBranch(projectId: string, name: string): Promise<void> {
    return this.local.createBranch(projectId, name)
  }

  createTrackingBranch(
    projectId: string,
    remote: string,
    branch: string,
    localName = branch
  ): Promise<void> {
    return this.local.createTrackingBranch(projectId, remote, branch, localName)
  }

  deleteBranch(projectId: string, name: string, force = false) {
    return this.local.deleteBranch(projectId, name, force)
  }

  deleteRemoteBranch(projectId: string, remote: string, name: string): Promise<void> {
    return this.local.deleteRemoteBranch(projectId, remote, name)
  }

  setIdentity(projectId: string, name: string, email: string): Promise<void> {
    return this.local.setIdentity(projectId, name, email)
  }

  getDiff(projectId: string, path: string, staged: boolean) {
    return this.local.getDiff(projectId, path, staged)
  }

  fetch(projectId: string): Promise<void> {
    return this.local.fetch(projectId)
  }

  fetchBranch(projectId: string, remote: string, branch: string): Promise<void> {
    return this.local.fetchBranch(projectId, remote, branch)
  }

  pull(projectId: string): Promise<void> {
    return this.local.pull(projectId)
  }

  push(projectId: string, setUpstream: boolean, remote?: string, branch?: string) {
    return this.local.push(projectId, setUpstream, remote, branch)
  }

  pullIntegrate(
    projectId: string,
    remote: string,
    branch: string,
    strategy: Parameters<GitLocalOperations['pullIntegrate']>[3]
  ): Promise<void> {
    return this.local.pullIntegrate(projectId, remote, branch, strategy)
  }

  syncPeers(projectId: string, scopeBucketId?: string): Promise<GitSyncPeerOption[]> {
    return this.local.syncPeers(projectId, scopeBucketId)
  }

  syncWith(
    projectId: string,
    scopeBucketId: string | undefined,
    options: Parameters<GitLocalOperations['syncWith']>[2]
  ) {
    return this.local.syncWith(projectId, scopeBucketId, options)
  }

  addRemote(projectId: string, name: string, url: string): Promise<void> {
    return this.local.addRemote(projectId, name, url)
  }

  setRemoteUrl(projectId: string, name: string, url: string): Promise<void> {
    return this.local.setRemoteUrl(projectId, name, url)
  }

  removeRemote(projectId: string, name: string): Promise<void> {
    return this.local.removeRemote(projectId, name)
  }

  setCredential(projectId: string, token: string): Promise<void> {
    return this.local.setCredential(projectId, token)
  }

  removeCredential(projectId: string): Promise<void> {
    return this.local.removeCredential(projectId)
  }

  merge(projectId: string, target: string) {
    return this.local.merge(projectId, target)
  }

  rebase(projectId: string, target: string) {
    return this.local.rebase(projectId, target)
  }

  abortMerge(projectId: string): Promise<void> {
    return this.local.abortMerge(projectId)
  }

  abortRebase(projectId: string): Promise<void> {
    return this.local.abortRebase(projectId)
  }

  rebaseAction(
    projectId: string,
    action: Parameters<GitLocalOperations['rebaseAction']>[1]
  ): Promise<void> {
    return this.local.rebaseAction(projectId, action)
  }

  preparePrResolve(
    projectId: string,
    options: Parameters<GitLocalOperations['preparePrResolve']>[1]
  ): Promise<void> {
    return this.local.preparePrResolve(projectId, options)
  }

  finishPrResolve(projectId: string): Promise<boolean> {
    return this.local.finishPrResolve(projectId)
  }

  stash(projectId: string, message?: string, paths?: string[]): Promise<void> {
    return this.local.stash(projectId, message, paths)
  }

  ignore(projectId: string, paths: string[]): Promise<void> {
    return this.local.ignore(projectId, paths)
  }

  discard(projectId: string, paths: string[]): Promise<void> {
    return this.local.discard(projectId, paths)
  }

  popStash(projectId: string, id?: string): Promise<void> {
    return this.local.popStash(projectId, id)
  }

  dropStash(projectId: string, id?: string): Promise<void> {
    return this.local.dropStash(projectId, id)
  }

  getLog(projectId: string, limit = 30, offset = 0, query?: string) {
    return this.local.getLog(projectId, limit, offset, query)
  }

  getRemoteUpdates(projectId: string) {
    return this.local.getRemoteUpdates(projectId)
  }

  getCommitDiff(projectId: string, hash: string) {
    return this.local.getCommitDiff(projectId, hash)
  }

  getCommitFileDiff(projectId: string, hash: string, path: string) {
    return this.local.getCommitFileDiff(projectId, hash, path)
  }

  getStashDiff(projectId: string, id: string) {
    return this.local.getStashDiff(projectId, id)
  }

  getStashFileDiff(projectId: string, id: string, path: string) {
    return this.local.getStashFileDiff(projectId, id, path)
  }

  restoreFiles(
    projectId: string,
    source: string,
    paths: string[],
    target: Parameters<GitLocalOperations['restoreFiles']>[3]
  ): Promise<void> {
    return this.local.restoreFiles(projectId, source, paths, target)
  }

  amend(projectId: string, message: string): Promise<void> {
    return this.local.amend(projectId, message)
  }

  reset(
    projectId: string,
    mode: Parameters<GitLocalOperations['reset']>[1],
    target?: string
  ): Promise<void> {
    return this.local.reset(projectId, mode, target)
  }

  deleteCommit(projectId: string, target: string): Promise<void> {
    return this.local.deleteCommit(projectId, target)
  }

  removeCommitChanges(projectId: string, hash: string, paths: string[]): Promise<void> {
    return this.local.removeCommitChanges(projectId, hash, paths)
  }

  // Pull request operations, delegated to the online mutation service.
  createPullRequest(
    projectId: string,
    input: Parameters<GitPullRequestOperations['createPullRequest']>[1]
  ) {
    return this.prOps.createPullRequest(projectId, input)
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
    return this.prOps.mergePullRequest(
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
    return this.prOps.markPullRequestReadyForReview(projectId, owner, repo, pullNumber)
  }

  listPullRequests(
    projectId: string,
    owner: string,
    repo: string,
    state?: Parameters<GitPullRequestOperations['listPullRequests']>[3]
  ) {
    return this.prOps.listPullRequests(projectId, owner, repo, state)
  }

  getDefaultBranch(projectId: string) {
    return this.prOps.getDefaultBranch(projectId)
  }

  comparePullRequests(projectId: string, owner: string, repo: string, base: string, head: string) {
    return this.prOps.comparePullRequests(projectId, owner, repo, base, head)
  }

  reopenPullRequest(projectId: string, owner: string, repo: string, pullNumber: number) {
    return this.prOps.reopenPullRequest(projectId, owner, repo, pullNumber)
  }

  closePullRequest(projectId: string, owner: string, repo: string, pullNumber: number) {
    return this.prOps.closePullRequest(projectId, owner, repo, pullNumber)
  }

  updatePullRequest(
    projectId: string,
    owner: string,
    repo: string,
    pullNumber: number,
    title: string | undefined,
    body: string | undefined
  ) {
    return this.prOps.updatePullRequest(projectId, owner, repo, pullNumber, title, body)
  }

  composeWithAgent(
    projectId: string,
    virtualTaskId: string,
    settings: Parameters<GitPullRequestOperations['composeWithAgent']>[2],
    input: Parameters<GitPullRequestOperations['composeWithAgent']>[3]
  ) {
    return this.prOps.composeWithAgent(projectId, virtualTaskId, settings, input)
  }

  commentOnPullRequest(
    projectId: string,
    owner: string,
    repo: string,
    pullNumber: number,
    body: string
  ) {
    return this.prOps.commentOnPullRequest(projectId, owner, repo, pullNumber, body)
  }

  reviewPullRequest(
    projectId: string,
    owner: string,
    repo: string,
    pullNumber: number,
    event: Parameters<GitPullRequestOperations['reviewPullRequest']>[4],
    body: string
  ) {
    return this.prOps.reviewPullRequest(projectId, owner, repo, pullNumber, event, body)
  }

  createPrReviewWorkspace(projectId: string, pullNumber: number, threadId?: string) {
    return this.prOps.createPrReviewWorkspace(projectId, pullNumber, threadId)
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
    return this.prs.ensurePullRequestPage(projectId, owner, repo, state, page, query, force)
  }

  ensurePullRequestBundle(
    projectId: string,
    owner: string,
    repo: string,
    pullNumber: number,
    force = false
  ): Promise<void> {
    return this.prs.ensurePullRequestBundle(projectId, owner, repo, pullNumber, force)
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
    return this.prs.preloadPullRequestBundle(projectId, owner, repo, pullNumber)
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
    return this.prs.preloadPullRequestNextPage(projectId, owner, repo, state, page, query)
  }

  mentionUsersFor(projectId: string, owner: string, repo: string) {
    return this.prs.mentionUsersFor(projectId, owner, repo)
  }

  getCommitFiles(projectId: string, owner: string, repo: string, sha: string) {
    return this.prs.getCommitFiles(projectId, owner, repo, sha)
  }

  loadAgentReport(projectId: string, pullNumber: number) {
    return this.prs.loadAgentReport(projectId, pullNumber)
  }

  ensureDeploymentOverview(
    projectId: string,
    owner: string,
    repo: string,
    force = false
  ): Promise<GitHubDeploymentOverviewResult | null> {
    return this.deployments.ensureDeploymentOverview(projectId, owner, repo, force)
  }

  ensureDeploymentDetail(
    projectId: string,
    owner: string,
    repo: string,
    deploymentId: number,
    force = false
  ): Promise<GitHubDeploymentDetail | null> {
    return this.deployments.ensureDeploymentDetail(projectId, owner, repo, deploymentId, force)
  }

  ensureWorkflowRunDetail(
    projectId: string,
    owner: string,
    repo: string,
    runId: number,
    force = false
  ): Promise<GitHubWorkflowRunDetail | null> {
    return this.deployments.ensureWorkflowRunDetail(projectId, owner, repo, runId, force)
  }

  ensureDeploymentJobLog(
    projectId: string,
    owner: string,
    repo: string,
    jobId: number,
    force = false
  ): Promise<GitHubDeploymentJobLog | null> {
    return this.deployments.ensureDeploymentJobLog(projectId, owner, repo, jobId, force)
  }

  // GitHub account auth.
  githubAuthStatus() {
    return this.github.githubAuthStatus()
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
    return this.deployments.rerunWorkflowRun(projectId, owner, repo, runId, mode)
  }

  startGitHubDeviceFlow() {
    return this.github.startGitHubDeviceFlow()
  }

  pollGitHubDeviceCode(deviceCode: string) {
    return this.github.pollGitHubDeviceCode(deviceCode)
  }

  logoutGitHub() {
    return this.github.logoutGitHub()
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
    return this.prOps.editPrComment(projectId, owner, repo, pullNumber, kind, commentId, body)
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
    return this.prOps.deletePrComment(projectId, owner, repo, pullNumber, kind, commentId)
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
    return this.prOps.replyToPrReviewComment(projectId, owner, repo, pullNumber, commentId, body)
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
    return this.prOps.minimizePrComment(projectId, owner, repo, pullNumber, nodeId, reason)
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

  static deploymentKey(owner: string, repo: string): string {
    return deploymentKey(owner, repo)
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
