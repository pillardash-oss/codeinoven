import { invoke, subscribe } from '$lib/ipc.svelte'
import type {
  GitBranchInfo,
  GitCommitInfo,
  GitCredentialStatus,
  GitDiff,
  GitFileChange,
  GitHubAuthStatus,
  GitHubDeploymentDetail,
  GitHubDeploymentJobLog,
  GitHubDeploymentOverviewResult,
  GitHubDeviceCode,
  GitHubPollResult,
  GitHubWorkflowRunDetail,
  GitIdentity,
  GitRemoteInfo,
  GitResetMode,
  GitStashEntry,
  GitStatus,
  MergeSummary,
  PrCreateInput,
  PrAgentReport,
  PrMergeMethod,
  PrReviewEvent,
  PrState,
  PullRequestBundle,
  PullRequestComment,
  PullRequestCompare,
  PullRequestFile,
  PullRequestPage,
  PullRequestReference,
  PullRequestReviewResult
} from '$shared/types'

/** One in-flight git operation, tracked per project for busy/disabled UI. */
export type GitOperation =
  | 'refresh'
  | 'stage'
  | 'unstage'
  | 'commit'
  | 'amend'
  | 'reset'
  | 'delete-commit'
  | 'init'
  | 'checkout'
  | 'fetch'
  | 'pull'
  | 'push'
  | 'merge'
  | 'rebase'
  | 'stash'
  | 'ignore'
  | 'discard'
  | 'stash-pop'
  | 'stash-drop'
  | 'abortMerge'
  | 'abortRebase'
  | 'pr-create'
  | 'pr-merge'
  | 'pr-comment'
  | 'pr-review'
  | 'pr-list'
  | 'pr-detail'
  | 'pr-reopen'
  | 'pr-close'
  | 'deployments'
  | 'deployment-detail'
  | 'deployment-run-detail'
  | 'deployment-log'

/** How long a cached PR page or bundle is served without refetching. */
const PR_CACHE_TTL_MS = 60_000

/** How long a cached deployment overview/detail is served without refetching. */
const DEPLOYMENT_CACHE_TTL_MS = 60_000

/** Job logs change rarely and are heavy — hold them a little longer. */
const DEPLOYMENT_LOG_CACHE_TTL_MS = 5 * 60_000

/**
 * How long a failed PR request is remembered before it may be tried again.
 *
 * A failure caches nothing, so without this the panel's periodic git refresh
 * would re-run the same doomed request on every tick — a 404 repeats forever
 * and GitHub answers with a secondary rate limit. Explicit refresh (`force`)
 * always ignores the cooldown, so the user is never locked out.
 */
const PR_ERROR_COOLDOWN_MS = 120_000

function errorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback
  return error.message
    .replace(/^Error invoking remote method '[^']+': Error:\s*/u, '')
    .replace(/^Error:\s*/u, '')
}

/**
 * Whether a `git push` failure was a non-fast-forward rejection (the remote
 * contains commits we don't have) rather than an actual error. Matches git's
 * standard stderr phrasing across versions.
 */
export function isPushRejected(message: string): boolean {
  return /non-fast-forward|fetch first|updates were rejected|failed to push some refs/iu.test(
    message
  )
}

/**
 * Per-project git runtime state, refreshed on panel activation, after every
 * app-driven mutation, and after agent turns land (`checkpoint.updated`).
 */
export class GitState {
  status: GitStatus | null = $state(null)
  branches: GitBranchInfo[] = $state([])
  remotes: GitRemoteInfo[] = $state([])
  identity: GitIdentity | null = $state(null)
  credentialStatus: GitCredentialStatus | null = $state(null)
  stashes: GitStashEntry[] = $state([])
  busy: Record<string, boolean> = $state({})
  error: string | null = $state(null)
  reviewPermission: Extract<PullRequestReviewResult, { status: 'permission_required' }> | null =
    $state(null)

  /**
   * The project whose data currently lives in the shared fields above. The
   * panel activates a project before reading, and async refreshes only write
   * their result when it still matches — so a slow response from the previous
   * project can never bleed into the one the user is actually viewing.
   */
  activeProjectId: string | null = $state(null)

  // Not reactive rendered data — a plain dedup registry for agent-event
  // subscriptions, so SvelteSet is the wrong tool here.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  private subscriptions = new Set<string>()

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
  activate(projectId: string): void {
    if (this.activeProjectId === projectId) return
    this.activeProjectId = projectId
    this.status = null
    this.branches = []
    this.remotes = []
    this.identity = null
    this.credentialStatus = null
    this.stashes = []
    this.error = null
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
    if (this.subscriptions.has(projectId)) return
    this.subscriptions.add(projectId)
    subscribe('agent:event', (...args: unknown[]) => {
      const event = args[0] as { type: string; projectId?: string } | undefined
      if (event?.type === 'checkpoint.updated' && event.projectId === projectId) {
        void this.refresh(projectId)
      }
    })
  }

  async refresh(projectId: string): Promise<void> {
    this.markBusy('refresh', true)
    // The refresh targets whichever project is active right now; if the panel
    // has already switched to another project, the result is stale and must
    // never be written.
    const targetProject = this.activeProjectId
    this.error = null
    try {
      const [status, branches, identity, remotes, credentialStatus, stashes] = await Promise.all([
        invoke('git:status', projectId),
        invoke('git:branches', projectId),
        invoke('git:getIdentity', projectId),
        invoke('git:remotes', projectId).catch(() => [] as GitRemoteInfo[]),
        invoke('git:getCredentialStatus', projectId).catch(
          () => null as GitCredentialStatus | null
        ),
        invoke('git:stashList', projectId).catch(() => [] as GitStashEntry[])
      ])
      if (targetProject !== this.activeProjectId || projectId !== this.activeProjectId) return
      this.status = status
      this.branches = branches
      this.identity = identity
      this.remotes = remotes
      this.credentialStatus = credentialStatus
      this.stashes = stashes
    } catch (reason) {
      if (targetProject !== this.activeProjectId || projectId !== this.activeProjectId) return
      this.error = errorMessage(reason, 'Git status could not be loaded')
      this.status = null
    } finally {
      this.markBusy('refresh', false)
    }
  }

  async stage(projectId: string, paths: string[]): Promise<void> {
    this.markBusy('stage', true)
    this.error = null
    try {
      this.status = await invoke('git:stage', projectId, paths)
    } catch (reason) {
      this.error = errorMessage(reason, 'Files could not be staged')
    } finally {
      this.markBusy('stage', false)
    }
  }

  async unstage(projectId: string, paths: string[]): Promise<void> {
    this.markBusy('unstage', true)
    this.error = null
    try {
      this.status = await invoke('git:unstage', projectId, paths)
    } catch (reason) {
      this.error = errorMessage(reason, 'Files could not be unstaged')
    } finally {
      this.markBusy('unstage', false)
    }
  }

  async commit(projectId: string, message: string): Promise<void> {
    this.markBusy('commit', true)
    this.error = null
    try {
      this.status = await invoke('git:commit', projectId, message)
    } catch (reason) {
      this.error = errorMessage(reason, 'Commit failed')
    } finally {
      this.markBusy('commit', false)
    }
  }

  async initialize(projectId: string): Promise<void> {
    this.markBusy('init', true)
    this.error = null
    try {
      this.status = await invoke('git:init', projectId)
    } catch (reason) {
      this.error = errorMessage(reason, 'Repository could not be initialized')
    } finally {
      this.markBusy('init', false)
    }
  }

  async checkout(projectId: string, branch: string): Promise<void> {
    this.markBusy('checkout', true)
    this.error = null
    try {
      this.status = await invoke('git:checkout', projectId, branch)
      await this.refresh(projectId)
    } catch (reason) {
      this.error = errorMessage(reason, 'Checkout failed')
    } finally {
      this.markBusy('checkout', false)
    }
  }

  async createBranch(projectId: string, name: string): Promise<void> {
    this.markBusy('checkout', true)
    this.error = null
    try {
      this.status = await invoke('git:createBranch', projectId, name)
      await this.refresh(projectId)
    } catch (reason) {
      this.error = errorMessage(reason, 'Branch creation failed')
    } finally {
      this.markBusy('checkout', false)
    }
  }

  async deleteBranch(projectId: string, name: string): Promise<void> {
    this.markBusy('checkout', true)
    this.error = null
    try {
      this.status = await invoke('git:deleteBranch', projectId, name)
      await this.refresh(projectId)
    } catch (reason) {
      this.error = errorMessage(reason, 'Branch deletion failed')
    } finally {
      this.markBusy('checkout', false)
    }
  }

  async setIdentity(projectId: string, name: string, email: string): Promise<void> {
    this.error = null
    try {
      this.identity = await invoke('git:setIdentity', projectId, { name, email })
    } catch (reason) {
      this.error = errorMessage(reason, 'Identity could not be saved')
    }
  }

  async getDiff(projectId: string, path: string, staged: boolean): Promise<GitDiff> {
    return invoke('git:diff', projectId, path, staged)
  }

  async fetch(projectId: string): Promise<void> {
    this.markBusy('fetch', true)
    this.error = null
    try {
      this.status = await invoke('git:fetch', projectId)
    } catch (reason) {
      this.error = errorMessage(reason, 'Fetch failed')
    } finally {
      this.markBusy('fetch', false)
    }
  }

  async pull(projectId: string): Promise<void> {
    this.markBusy('pull', true)
    this.error = null
    try {
      this.status = await invoke('git:pull', projectId)
    } catch (reason) {
      this.error = errorMessage(reason, 'Pull failed')
    } finally {
      this.markBusy('pull', false)
    }
  }

  async push(
    projectId: string,
    setUpstream: boolean,
    remote?: string,
    branch?: string
  ): Promise<'pushed' | 'rejected' | 'failed'> {
    this.markBusy('push', true)
    this.error = null
    try {
      this.status = await invoke('git:push', projectId, { setUpstream, remote, branch })
      return 'pushed'
    } catch (reason) {
      const message = errorMessage(reason, 'Push failed')
      // A non-fast-forward rejection is not a failure — the panel turns it into
      // the "pull & push" recovery dialog instead of a scary error banner.
      if (isPushRejected(message)) return 'rejected'
      this.error = message
      return 'failed'
    } finally {
      this.markBusy('push', false)
    }
  }

  /**
   * Pull a specific remote branch (merge or rebase) for push recovery, then
   * surface the refreshed status. A pull that stops on conflicts is a normal
   * state — the panel hands over to the conflict UI and never auto-pushes.
   */
  async pullIntegrate(
    projectId: string,
    remote: string,
    branch: string,
    rebase: boolean
  ): Promise<void> {
    this.markBusy('pull', true)
    this.error = null
    try {
      this.status = await invoke('git:pullIntegrate', projectId, { remote, branch, rebase })
    } catch (reason) {
      this.error = errorMessage(reason, rebase ? 'Pull with rebase failed' : 'Pull failed')
    } finally {
      this.markBusy('pull', false)
    }
  }

  async addRemote(projectId: string, name: string, url: string): Promise<void> {
    this.error = null
    try {
      this.remotes = await invoke('git:addRemote', projectId, name, url)
    } catch (reason) {
      this.error = errorMessage(reason, 'Remote could not be added')
    }
  }

  async removeRemote(projectId: string, name: string): Promise<void> {
    this.error = null
    try {
      this.remotes = await invoke('git:removeRemote', projectId, name)
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
    this.markBusy('merge', true)
    this.error = null
    try {
      const summary = await invoke('git:merge', projectId, target)
      this.status = await invoke('git:status', projectId)
      return summary
    } catch (reason) {
      this.error = errorMessage(reason, 'Merge failed')
      return null
    } finally {
      this.markBusy('merge', false)
    }
  }

  async rebase(projectId: string, target: string): Promise<MergeSummary | null> {
    this.markBusy('rebase', true)
    this.error = null
    try {
      const summary = await invoke('git:rebase', projectId, target)
      this.status = await invoke('git:status', projectId)
      return summary
    } catch (reason) {
      this.error = errorMessage(reason, 'Rebase failed')
      return null
    } finally {
      this.markBusy('rebase', false)
    }
  }

  async abortMerge(projectId: string): Promise<void> {
    this.markBusy('abortMerge', true)
    this.error = null
    try {
      this.status = await invoke('git:abortMerge', projectId)
    } catch (reason) {
      this.error = errorMessage(reason, 'Merge abort failed')
    } finally {
      this.markBusy('abortMerge', false)
    }
  }

  async abortRebase(projectId: string): Promise<void> {
    this.markBusy('abortRebase', true)
    this.error = null
    try {
      this.status = await invoke('git:abortRebase', projectId)
    } catch (reason) {
      this.error = errorMessage(reason, 'Rebase abort failed')
    } finally {
      this.markBusy('abortRebase', false)
    }
  }

  async stash(projectId: string, message?: string, paths?: string[]): Promise<void> {
    this.markBusy('stash', true)
    this.error = null
    try {
      this.status = await invoke('git:stash', projectId, message, paths)
      this.stashes = await invoke('git:stashList', projectId)
    } catch (reason) {
      this.error = errorMessage(reason, 'Stash failed')
    } finally {
      this.markBusy('stash', false)
    }
  }

  async ignore(projectId: string, paths: string[]): Promise<void> {
    this.markBusy('ignore', true)
    this.error = null
    try {
      this.status = await invoke('git:ignore', projectId, paths)
    } catch (reason) {
      this.error = errorMessage(reason, 'Files could not be ignored')
    } finally {
      this.markBusy('ignore', false)
    }
  }

  async discard(projectId: string, paths: string[]): Promise<void> {
    this.markBusy('discard', true)
    this.error = null
    try {
      this.status = await invoke('git:discard', projectId, paths)
    } catch (reason) {
      this.error = errorMessage(reason, 'Changes could not be discarded')
    } finally {
      this.markBusy('discard', false)
    }
  }

  async popStash(projectId: string, id?: string): Promise<void> {
    this.markBusy('stash-pop', true)
    this.error = null
    try {
      this.status = await invoke('git:stashPop', projectId, id)
      this.stashes = await invoke('git:stashList', projectId)
    } catch (reason) {
      this.error = errorMessage(reason, 'Stash pop failed')
    } finally {
      this.markBusy('stash-pop', false)
    }
  }

  async dropStash(projectId: string, id?: string): Promise<void> {
    this.markBusy('stash-drop', true)
    this.error = null
    try {
      this.status = await invoke('git:stashDrop', projectId, id)
      this.stashes = await invoke('git:stashList', projectId)
    } catch (reason) {
      this.error = errorMessage(reason, 'Stash drop failed')
    } finally {
      this.markBusy('stash-drop', false)
    }
  }

  async createPullRequest(
    projectId: string,
    input: PrCreateInput
  ): Promise<PullRequestReference | null> {
    this.markBusy('pr-create', true)
    this.error = null
    try {
      return await invoke('pr:create', projectId, input)
    } catch (reason) {
      this.error = errorMessage(reason, 'Pull request could not be created')
      return null
    } finally {
      this.markBusy('pr-create', false)
    }
  }

  async mergePullRequest(
    projectId: string,
    owner: string,
    repo: string,
    pullNumber: number,
    method: PrMergeMethod,
    commitTitle?: string,
    commitMessage?: string
  ): Promise<PullRequestReference | null> {
    this.markBusy('pr-merge', true)
    this.error = null
    try {
      return await invoke(
        'pr:merge',
        projectId,
        owner,
        repo,
        pullNumber,
        method,
        commitTitle,
        commitMessage
      )
    } catch (reason) {
      this.error = errorMessage(reason, 'Pull request could not be merged')
      return null
    } finally {
      this.markBusy('pr-merge', false)
    }
  }

  async listPullRequests(
    projectId: string,
    owner: string,
    repo: string,
    state: PrState = 'open'
  ): Promise<PullRequestReference[]> {
    try {
      return await invoke('pr:list', projectId, owner, repo, state)
    } catch {
      return []
    }
  }

  /**
   * Compare two refs so the create-PR form can gate on there being a real
   * change. Returns null on failure so the form can disable creation safely.
   */
  async comparePullRequests(
    projectId: string,
    owner: string,
    repo: string,
    base: string,
    head: string
  ): Promise<PullRequestCompare | null> {
    try {
      return await invoke('pr:compare', projectId, owner, repo, base, head)
    } catch {
      return null
    }
  }

  /** Reopen a closed pull request, mirroring GitHub's reopen. */
  async reopenPullRequest(
    projectId: string,
    owner: string,
    repo: string,
    pullNumber: number
  ): Promise<PullRequestReference | null> {
    this.markBusy('pr-reopen', true)
    this.error = null
    try {
      return await invoke('pr:reopen', projectId, owner, repo, pullNumber)
    } catch (reason) {
      this.error = errorMessage(reason, 'Pull request could not be reopened')
      return null
    } finally {
      this.markBusy('pr-reopen', false)
    }
  }

  /** Close an open pull request without merging, mirroring GitHub's close. */
  async closePullRequest(
    projectId: string,
    owner: string,
    repo: string,
    pullNumber: number
  ): Promise<PullRequestReference | null> {
    this.markBusy('pr-close', true)
    this.error = null
    try {
      return await invoke('pr:close', projectId, owner, repo, pullNumber)
    } catch (reason) {
      this.error = errorMessage(reason, 'Pull request could not be closed')
      return null
    } finally {
      this.markBusy('pr-close', false)
    }
  }

  /**
   * Cached PR listings and detail bundles.
   *
   * The sidebar tab is mounted and unmounted every time the user switches tabs,
   * so without a store-level cache every visit would re-fetch and re-show a
   * spinner. Cached data renders immediately and is revalidated in the
   * background when it is older than `PR_CACHE_TTL_MS`.
   */
  prPages: Record<string, { page: PullRequestPage; fetchedAt: number }> = $state({})
  prBundles: Record<string, PullRequestBundle> = $state({})
  prAgentReports: Record<string, PrAgentReport> = $state({})

  /**
   * Cached deployment overviews, details, and job logs — the same
   * stale-while-revalidate pattern as the PR caches. The Deployments tab is
   * mounted/unmounted on every tab switch, so cached data renders instantly
   * and is revalidated in the background once it ages past the TTL.
   */
  deploymentOverviews: Record<
    string,
    { overview: GitHubDeploymentOverviewResult; fetchedAt: number }
  > = $state({})
  deploymentDetails: Record<string, { detail: GitHubDeploymentDetail; fetchedAt: number }> = $state(
    {}
  )
  deploymentRunDetails: Record<string, { detail: GitHubWorkflowRunDetail; fetchedAt: number }> =
    $state({})
  deploymentLogs: Record<string, { log: GitHubDeploymentJobLog; fetchedAt: number }> = $state({})

  /**
   * Epoch ms of the last failure per deployment cache key. Deliberately plain
   * (not `$state`) — it only gates fetching, and making it reactive would feed
   * the very effects that triggered the request.
   */
  private deploymentFailures: Record<string, number> = {}

  /** One overview probe per repository, shared by tab discovery and the monitor. */
  private deploymentOverviewRequests: Record<
    string,
    Promise<GitHubDeploymentOverviewResult | null> | undefined
  > = {}

  /** True while a key is inside its post-failure cooldown. */
  private deploymentCoolingDown(key: string): boolean {
    const failedAt = this.deploymentFailures[key]
    if (failedAt === undefined) return false
    if (Date.now() - failedAt < PR_ERROR_COOLDOWN_MS) return true
    delete this.deploymentFailures[key]
    return false
  }

  private markDeploymentFailure(key: string): void {
    this.deploymentFailures[key] = Date.now()
  }

  /** Epoch ms of the last failure per PR cache key. Deliberately plain (not
   *  `$state`) — it only gates fetching, and making it reactive would feed the
   *  very effects that triggered the request.
   */
  private prFailures: Record<string, number> = {}

  /** One request per page key, preventing duplicate IPC calls from concurrent mounts/effects. */
  private prPageRequests: Record<string, Promise<void> | undefined> = {}

  /** True while a key is inside its post-failure cooldown. */
  private prCoolingDown(key: string): boolean {
    const failedAt = this.prFailures[key]
    if (failedAt === undefined) return false
    if (Date.now() - failedAt < PR_ERROR_COOLDOWN_MS) return true
    delete this.prFailures[key]
    return false
  }

  private markPrFailure(key: string): void {
    this.prFailures[key] = Date.now()
  }

  static pageKey(owner: string, repo: string, state: PrState, page: number): string {
    return `${owner}/${repo}:${state}:${page}`
  }

  static bundleKey(owner: string, repo: string, pullNumber: number): string {
    return `${owner}/${repo}#${pullNumber}`
  }

  static deploymentKey(owner: string, repo: string): string {
    return `${owner}/${repo}`
  }

  static deploymentDetailKey(owner: string, repo: string, deploymentId: number): string {
    return `${owner}/${repo}#${deploymentId}`
  }

  static workflowRunKey(owner: string, repo: string, runId: number): string {
    return `${owner}/${repo}/runs/${runId}`
  }

  static deploymentLogKey(owner: string, repo: string, jobId: number): string {
    return `${owner}/${repo}/jobs/${jobId}`
  }

  /**
   * Load a page of pull requests, serving cache first.
   *
   * Returns immediately when fresh cache exists; otherwise fetches. Pass
   * `force` for the explicit refresh button.
   */
  async ensurePullRequestPage(
    projectId: string,
    owner: string,
    repo: string,
    state: PrState,
    page: number,
    force = false
  ): Promise<void> {
    const key = GitState.pageKey(owner, repo, state, page)
    const cached = this.prPages[key]
    if (!force && cached && Date.now() - cached.fetchedAt < PR_CACHE_TTL_MS) return
    if (!force && this.prCoolingDown(key)) return
    const existingRequest = this.prPageRequests[key]
    if (existingRequest) return existingRequest

    const request = this.loadPullRequestPage(projectId, owner, repo, state, page, key)
    this.prPageRequests[key] = request
    try {
      await request
    } finally {
      if (this.prPageRequests[key] === request) delete this.prPageRequests[key]
    }
  }

  private async loadPullRequestPage(
    projectId: string,
    owner: string,
    repo: string,
    state: PrState,
    page: number,
    key: string
  ): Promise<void> {
    this.markBusy('pr-list', true)
    try {
      const result = await invoke('pr:page', projectId, owner, repo, state, page)
      this.prPages = { ...this.prPages, [key]: { page: result, fetchedAt: Date.now() } }
      delete this.prFailures[key]
    } catch (reason) {
      this.markPrFailure(key)
      this.error = errorMessage(reason, 'Pull requests could not be loaded')
    } finally {
      this.markBusy('pr-list', false)
    }
  }

  /** Load everything a PR detail view needs, serving cache first. */
  async ensurePullRequestBundle(
    projectId: string,
    owner: string,
    repo: string,
    pullNumber: number,
    force = false
  ): Promise<void> {
    const key = GitState.bundleKey(owner, repo, pullNumber)
    const cached = this.prBundles[key]
    if (!force && cached && Date.now() - cached.fetchedAt < PR_CACHE_TTL_MS) return
    if (!force && this.prCoolingDown(key)) return
    this.markBusy('pr-detail', true)
    try {
      const bundle = await invoke('pr:bundle', projectId, owner, repo, pullNumber)
      this.prBundles = { ...this.prBundles, [key]: bundle }
      delete this.prFailures[key]
    } catch (reason) {
      this.markPrFailure(key)
      this.error = errorMessage(reason, 'Pull request could not be loaded')
    } finally {
      this.markBusy('pr-detail', false)
    }
  }

  /** Files and patches for one commit inside a PR. */
  async getCommitFiles(
    projectId: string,
    owner: string,
    repo: string,
    sha: string
  ): Promise<PullRequestFile[]> {
    try {
      return await invoke('pr:commitFiles', projectId, owner, repo, sha)
    } catch (reason) {
      this.error = errorMessage(reason, 'Commit files could not be loaded')
      return []
    }
  }

  /**
   * Load the deployment overview, serving cache first.
   *
   * Returns immediately when fresh cache exists; otherwise fetches and updates
   * the cache. `force` bypasses both the TTL and the failure cooldown (explicit
   * refresh). Failures rethrow so the caller can surface a tailored message
   * (e.g. the GitHub App permission screen) while any stale cache stays on screen.
   */
  async ensureDeploymentOverview(
    projectId: string,
    owner: string,
    repo: string,
    force = false
  ): Promise<GitHubDeploymentOverviewResult | null> {
    const key = GitState.deploymentKey(owner, repo)
    const cached = this.deploymentOverviews[key]
    if (!force && cached && Date.now() - cached.fetchedAt < DEPLOYMENT_CACHE_TTL_MS) {
      return cached.overview
    }
    if (!force && this.deploymentCoolingDown(key)) return cached?.overview ?? null
    const existingRequest = this.deploymentOverviewRequests[key]
    if (existingRequest) return existingRequest

    const request = this.loadDeploymentOverview(projectId, owner, repo, key)
    this.deploymentOverviewRequests[key] = request
    try {
      return await request
    } finally {
      if (this.deploymentOverviewRequests[key] === request) {
        delete this.deploymentOverviewRequests[key]
      }
    }
  }

  private async loadDeploymentOverview(
    projectId: string,
    owner: string,
    repo: string,
    key: string
  ): Promise<GitHubDeploymentOverviewResult | null> {
    this.markBusy('deployments', true)
    try {
      const result = await invoke('deployment:overview', projectId, owner, repo)
      if (result.accessError) throw new Error(result.accessError)
      this.deploymentOverviews = {
        ...this.deploymentOverviews,
        [key]: { overview: result, fetchedAt: Date.now() }
      }
      delete this.deploymentFailures[key]
      return result
    } catch (reason) {
      this.markDeploymentFailure(key)
      throw reason
    } finally {
      this.markBusy('deployments', false)
    }
  }

  /** Load one deployment's rich detail, serving cache first (same pattern). */
  async ensureDeploymentDetail(
    projectId: string,
    owner: string,
    repo: string,
    deploymentId: number,
    force = false
  ): Promise<GitHubDeploymentDetail | null> {
    const key = GitState.deploymentDetailKey(owner, repo, deploymentId)
    const cached = this.deploymentDetails[key]
    if (!force && cached && Date.now() - cached.fetchedAt < DEPLOYMENT_CACHE_TTL_MS) {
      return cached.detail
    }
    if (!force && this.deploymentCoolingDown(key)) return cached?.detail ?? null
    this.markBusy('deployment-detail', true)
    try {
      const result = await invoke('deployment:detail', projectId, owner, repo, deploymentId)
      this.deploymentDetails = {
        ...this.deploymentDetails,
        [key]: { detail: result, fetchedAt: Date.now() }
      }
      delete this.deploymentFailures[key]
      return result
    } catch (reason) {
      this.markDeploymentFailure(key)
      throw reason
    } finally {
      this.markBusy('deployment-detail', false)
    }
  }

  /** Load one workflow run's rich detail (run + jobs), serving cache first. */
  async ensureWorkflowRunDetail(
    projectId: string,
    owner: string,
    repo: string,
    runId: number,
    force = false
  ): Promise<GitHubWorkflowRunDetail | null> {
    const key = GitState.workflowRunKey(owner, repo, runId)
    const cached = this.deploymentRunDetails[key]
    if (!force && cached && Date.now() - cached.fetchedAt < DEPLOYMENT_CACHE_TTL_MS) {
      return cached.detail
    }
    if (!force && this.deploymentCoolingDown(key)) return cached?.detail ?? null
    this.markBusy('deployment-run-detail', true)
    try {
      const result = await invoke('deployment:runDetail', projectId, owner, repo, runId)
      this.deploymentRunDetails = {
        ...this.deploymentRunDetails,
        [key]: { detail: result, fetchedAt: Date.now() }
      }
      delete this.deploymentFailures[key]
      return result
    } catch (reason) {
      this.markDeploymentFailure(key)
      throw reason
    } finally {
      this.markBusy('deployment-run-detail', false)
    }
  }

  /** Load a job log, serving cache first. Logs hold a longer TTL than other caches. */
  async ensureDeploymentJobLog(
    projectId: string,
    owner: string,
    repo: string,
    jobId: number,
    force = false
  ): Promise<GitHubDeploymentJobLog | null> {
    const key = GitState.deploymentLogKey(owner, repo, jobId)
    const cached = this.deploymentLogs[key]
    if (!force && cached && Date.now() - cached.fetchedAt < DEPLOYMENT_LOG_CACHE_TTL_MS) {
      return cached.log
    }
    if (!force && this.deploymentCoolingDown(key)) return cached?.log ?? null
    this.markBusy('deployment-log', true)
    try {
      const result = await invoke('deployment:jobLog', projectId, owner, repo, jobId)
      this.deploymentLogs = {
        ...this.deploymentLogs,
        [key]: { log: result, fetchedAt: Date.now() }
      }
      delete this.deploymentFailures[key]
      return result
    } catch (reason) {
      this.markDeploymentFailure(key)
      throw reason
    } finally {
      this.markBusy('deployment-log', false)
    }
  }

  /** Read the agent's review report for a PR, if it has written one. */
  async loadAgentReport(projectId: string, pullNumber: number): Promise<PrAgentReport | null> {
    try {
      const report = await invoke('pr:agentReport', projectId, pullNumber)
      this.prAgentReports = { ...this.prAgentReports, [String(pullNumber)]: report }
      return report
    } catch {
      return null
    }
  }

  async commentOnPullRequest(
    projectId: string,
    owner: string,
    repo: string,
    pullNumber: number,
    body: string
  ): Promise<PullRequestComment | null> {
    this.markBusy('pr-comment', true)
    this.error = null
    try {
      return await invoke('pr:comment', projectId, owner, repo, pullNumber, body)
    } catch (reason) {
      this.error = errorMessage(reason, 'The comment could not be posted')
      return null
    } finally {
      this.markBusy('pr-comment', false)
    }
  }

  async reviewPullRequest(
    projectId: string,
    owner: string,
    repo: string,
    pullNumber: number,
    event: PrReviewEvent,
    body: string
  ): Promise<boolean> {
    this.markBusy('pr-review', true)
    this.error = null
    this.reviewPermission = null
    try {
      const result = await invoke('pr:review', projectId, owner, repo, pullNumber, event, body)
      if (result.status === 'permission_required') {
        this.reviewPermission = result
        return false
      }
      return true
    } catch (reason) {
      this.error = errorMessage(reason, 'The review could not be submitted')
      return false
    } finally {
      this.markBusy('pr-review', false)
    }
  }

  /** Create `.cio/git/pr/<number>/` so an agent has somewhere to write its report. */
  async createPrReviewWorkspace(
    projectId: string,
    pullNumber: number,
    threadId?: string
  ): Promise<string | null> {
    try {
      return await invoke('pr:reviewWorkspace', projectId, pullNumber, threadId)
    } catch (reason) {
      this.error = errorMessage(reason, 'The review workspace could not be created')
      return null
    }
  }

  async getLog(projectId: string, limit = 30): Promise<GitCommitInfo[]> {
    try {
      return await invoke('git:log', projectId, limit)
    } catch {
      return []
    }
  }

  async getCommitDiff(projectId: string, hash: string): Promise<GitFileChange[]> {
    try {
      return await invoke('git:commitDiff', projectId, hash)
    } catch {
      return []
    }
  }

  async getCommitFileDiff(projectId: string, hash: string, path: string): Promise<GitDiff> {
    return invoke('git:commitFileDiff', projectId, hash, path)
  }

  async getStashDiff(projectId: string, id: string): Promise<GitFileChange[]> {
    try {
      return await invoke('git:stashDiff', projectId, id)
    } catch {
      return []
    }
  }

  async getStashFileDiff(projectId: string, id: string, path: string): Promise<GitDiff> {
    return invoke('git:stashFileDiff', projectId, id, path)
  }

  async amend(projectId: string, message: string): Promise<void> {
    this.markBusy('amend', true)
    this.error = null
    try {
      this.status = await invoke('git:amend', projectId, message)
    } catch (reason) {
      this.error = errorMessage(reason, 'Amend failed')
    } finally {
      this.markBusy('amend', false)
    }
  }

  async reset(projectId: string, mode: GitResetMode, target?: string): Promise<void> {
    this.markBusy('reset', true)
    this.error = null
    try {
      this.status = await invoke('git:reset', projectId, mode, target)
    } catch (reason) {
      this.error = errorMessage(reason, 'Reset failed')
    } finally {
      this.markBusy('reset', false)
    }
  }

  async deleteCommit(projectId: string, target: string): Promise<void> {
    this.markBusy('delete-commit', true)
    this.error = null
    try {
      this.status = await invoke('git:deleteCommit', projectId, target)
    } catch (reason) {
      this.error = errorMessage(reason, 'Commit could not be deleted')
    } finally {
      this.markBusy('delete-commit', false)
    }
  }

  async githubAuthStatus(): Promise<GitHubAuthStatus> {
    try {
      return await invoke('github:authStatus')
    } catch {
      return { connected: false, configured: false }
    }
  }

  async startGitHubDeviceFlow(): Promise<GitHubDeviceCode | null> {
    try {
      return await invoke('github:startDeviceFlow')
    } catch (reason) {
      this.error = errorMessage(reason, 'GitHub sign-in could not be started')
      return null
    }
  }

  async pollGitHubDeviceCode(deviceCode: string): Promise<GitHubPollResult> {
    try {
      return await invoke('github:poll', deviceCode)
    } catch (reason) {
      const message = errorMessage(reason, 'GitHub sign-in check failed')
      return { status: 'error', message }
    }
  }

  async logoutGitHub(): Promise<GitHubAuthStatus> {
    try {
      const status = await invoke('github:logout')
      // During a renderer hot reload, an older main process may still implement
      // the historical void response. Refresh status instead of dereferencing it.
      return status ?? (await this.githubAuthStatus())
    } catch (reason) {
      this.error = errorMessage(reason, 'GitHub sign-out failed')
      return { connected: false, configured: false }
    }
  }
}

export const gitState = new GitState()
