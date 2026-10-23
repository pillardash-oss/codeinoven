import { invoke } from '$lib/ipc.svelte'
import type {
  GitHubDeploymentDetail,
  GitHubDeploymentJobLog,
  GitHubDeploymentPage,
  GitHubPermissionRequired,
  GitHubWorkflowRunDetail,
  GitHubWorkflowRunPage,
  WorkflowRerunMode,
  WorkflowRunFilter
} from '$shared/types'
import {
  DEPLOYMENT_CACHE_TTL_MS,
  DEPLOYMENT_LOG_CACHE_TTL_MS,
  PR_ERROR_COOLDOWN_MS,
  PR_PRELOAD_RETRY_MS,
  deploymentDetailKey,
  deploymentKey,
  deploymentLogKey,
  deploymentPageKey,
  errorMessage,
  parseWorkflowRunPageKey,
  workflowRunKey,
  workflowRunPageKey,
  type GitOperation
} from './git-store-helpers'

/** One cached page of a repository's workflow runs, with the filter it was read under. */
interface CachedWorkflowRunPage {
  page: GitHubWorkflowRunPage
  fetchedAt: number
}

/** One cached page of a repository's deployments. */
interface CachedDeploymentPage {
  page: GitHubDeploymentPage
  fetchedAt: number
}

/**
 * Cached deployment activity, pages, details, and job logs - the same
 * stale-while-revalidate pattern as the PR caches. The Deployments tab is
 * mounted/unmounted on every tab switch, so cached data renders instantly
 * and is revalidated in the background once it ages past the TTL.
 *
 * Runs and environments are cached as their own paged listings rather than as one
 * snapshot, because they are read as two views: each keeps the page the reader was
 * on, and an older page is one request away instead of being unreachable.
 */
export class GitDeploymentCache {
  activity: Record<string, { hasDeployments: boolean; fetchedAt: number }> = $state({})
  runPages: Record<string, CachedWorkflowRunPage> = $state({})
  deploymentPages: Record<string, CachedDeploymentPage> = $state({})
  details: Record<string, { detail: GitHubDeploymentDetail; fetchedAt: number }> = $state({})
  runDetails: Record<string, { detail: GitHubWorkflowRunDetail; fetchedAt: number }> = $state({})
  logs: Record<string, { log: GitHubDeploymentJobLog; fetchedAt: number }> = $state({})

  /**
   * Epoch ms of the last failure per cache key. Deliberately plain
   * (not `$state`) - it only gates fetching, and making it reactive would feed
   * the very effects that triggered the request.
   */
  private failures: Record<string, number> = {}

  /**
   * The same clock for warm-ups, kept apart from `failures` on purpose: a hover
   * that failed must leave the click behind it free to try, and to report its own
   * failure.
   */
  private preloadFailures: Record<string, number> = {}

  /**
   * One in-flight request per key, shared by the load and the hover that warmed it.
   *
   * A pointer resting on a tab and the click that follows it are the same request,
   * so awaiting the first here is what turns hover-then-click into one round trip.
   */
  private pageRequests: Record<string, Promise<void> | undefined> = {}
  private activityRequests: Record<string, Promise<boolean | null> | undefined> = {}

  constructor(
    private readonly markBusy: (operation: GitOperation, busy: boolean) => void,
    private readonly setError: (message: string | null) => void,
    private readonly setGitHubPermission: (permission: GitHubPermissionRequired | null) => void
  ) {}

  /** True while a key is inside its post-failure cooldown. */
  private coolingDown(key: string): boolean {
    const failedAt = this.failures[key]
    if (failedAt === undefined) return false
    if (Date.now() - failedAt < PR_ERROR_COOLDOWN_MS) return true
    delete this.failures[key]
    return false
  }

  private markFailure(key: string): void {
    this.failures[key] = Date.now()
  }

  /** True while a warm-up for the key is inside its own shorter cooldown. */
  private preloadCoolingDown(key: string): boolean {
    const failedAt = this.preloadFailures[key]
    if (failedAt === undefined) return false
    if (Date.now() - failedAt < PR_PRELOAD_RETRY_MS) return true
    delete this.preloadFailures[key]
    return false
  }

  /**
   * Whether the repository has any deployment activity, serving cache first.
   *
   * Only the fact is cached, not the lists: the panel asks this question to decide
   * whether the Deployments view exists at all, and the view reads its own pages
   * when it opens. `force` bypasses the TTL and the failure cooldown after an
   * explicit refresh. Failures rethrow so the caller can tell a sign-in problem
   * from a network one; a stale answer stays on screen meanwhile.
   */
  async ensureDeploymentActivity(
    projectId: string,
    owner: string,
    repo: string,
    force = false
  ): Promise<boolean | null> {
    const key = deploymentKey(owner, repo)
    const cached = this.activity[key]
    if (!force && cached && Date.now() - cached.fetchedAt < DEPLOYMENT_CACHE_TTL_MS) {
      return cached.hasDeployments
    }
    if (!force && this.coolingDown(key)) return cached?.hasDeployments ?? null
    const existingRequest = this.activityRequests[key]
    if (existingRequest) return existingRequest

    const request = this.loadDeploymentActivity(projectId, owner, repo, key)
    this.activityRequests[key] = request
    try {
      return await request
    } finally {
      if (this.activityRequests[key] === request) delete this.activityRequests[key]
    }
  }

  private async loadDeploymentActivity(
    projectId: string,
    owner: string,
    repo: string,
    key: string
  ): Promise<boolean | null> {
    this.markBusy('deployment-activity', true)
    try {
      const result = await invoke('deployment:activity', projectId, owner, repo)
      this.activity = {
        ...this.activity,
        [key]: { hasDeployments: result.hasDeployments, fetchedAt: Date.now() }
      }
      if (result.accessError) {
        this.markFailure(key)
        throw new Error(result.accessError)
      }
      delete this.failures[key]
      return result.hasDeployments
    } catch (reason) {
      this.markFailure(key)
      throw reason
    } finally {
      this.markBusy('deployment-activity', false)
    }
  }

  /**
   * Load one page of workflow runs, serving the cache for that page and filter.
   *
   * Only the page asked for is read. GitHub answers these listings by page number,
   * so an older page needs nothing from the ones before it, and walking them would
   * turn one click into a chain of requests.
   */
  async ensureWorkflowRunPage(
    projectId: string,
    owner: string,
    repo: string,
    filter: WorkflowRunFilter,
    page: number,
    force = false
  ): Promise<void> {
    if (!projectId || !owner || !repo) return
    const key = workflowRunPageKey(owner, repo, filter, page)
    const cached = this.runPages[key]
    if (!force && cached && Date.now() - cached.fetchedAt < DEPLOYMENT_CACHE_TTL_MS) return
    if (!force && this.coolingDown(key)) return
    this.markBusy('deployment-runs', true)
    try {
      await this.requestRunPage(projectId, owner, repo, filter, page, key, false)
    } finally {
      this.markBusy('deployment-runs', false)
    }
  }

  /** Load one page of deployments, each with the latest status GitHub recorded. */
  async ensureDeploymentPage(
    projectId: string,
    owner: string,
    repo: string,
    page: number,
    force = false
  ): Promise<void> {
    if (!projectId || !owner || !repo) return
    const key = deploymentPageKey(owner, repo, page)
    const cached = this.deploymentPages[key]
    if (!force && cached && Date.now() - cached.fetchedAt < DEPLOYMENT_CACHE_TTL_MS) return
    if (!force && this.coolingDown(key)) return
    this.markBusy('deployment-environments', true)
    try {
      await this.requestDeploymentPage(projectId, owner, repo, page, key, false)
    } finally {
      this.markBusy('deployment-environments', false)
    }
  }

  /**
   * Warm one page of workflow runs while the pointer rests on its tab.
   *
   * A warm-up is invisible by design: it moves no busy state, posts no error, and
   * files its failure under the shorter preload clock, so the click that follows a
   * failed hover still makes its own attempt and reports its own error.
   */
  async preloadWorkflowRunPage(
    projectId: string,
    owner: string,
    repo: string,
    filter: WorkflowRunFilter,
    page: number
  ): Promise<void> {
    if (!projectId || !owner || !repo) return
    const key = workflowRunPageKey(owner, repo, filter, page)
    const cached = this.runPages[key]
    if (cached && Date.now() - cached.fetchedAt < DEPLOYMENT_CACHE_TTL_MS) return
    if (this.coolingDown(key) || this.preloadCoolingDown(key)) return
    await this.requestRunPage(projectId, owner, repo, filter, page, key, true)
  }

  /** Warm one page of deployments, the same way the runs tab is warmed. */
  async preloadDeploymentPage(
    projectId: string,
    owner: string,
    repo: string,
    page: number
  ): Promise<void> {
    if (!projectId || !owner || !repo) return
    const key = deploymentPageKey(owner, repo, page)
    const cached = this.deploymentPages[key]
    if (cached && Date.now() - cached.fetchedAt < DEPLOYMENT_CACHE_TTL_MS) return
    if (this.coolingDown(key) || this.preloadCoolingDown(key)) return
    await this.requestDeploymentPage(projectId, owner, repo, page, key, true)
  }

  /**
   * Re-read every page of this repository this session has cached, in both views.
   *
   * The panel's refresh button asks for the view to be up to date, and the view's
   * page state lives in the component rather than here, so the store reloads the
   * pages it holds instead: one per view in practice, and never a page the user has
   * not visited.
   */
  async refreshDeploymentPages(projectId: string, owner: string, repo: string): Promise<void> {
    const runRequests = Object.keys(this.runPages).flatMap((key) => {
      // The key is parsed, never destructured by hand: the filter and the page are
      // the fields after the prefix, and reading one field off means the refresh
      // sends a page number where a filter belongs.
      const cached = parseWorkflowRunPageKey(key, owner, repo)
      if (!cached) return []
      return [this.requestRunPage(projectId, owner, repo, cached.filter, cached.page, key, false)]
    })
    const deploymentRequests = Object.keys(this.deploymentPages).flatMap((key) => {
      if (!key.startsWith(`${owner}/${repo}#deployments:`)) return []
      const page = key.slice(`${owner}/${repo}#deployments:`.length)
      return [this.requestDeploymentPage(projectId, owner, repo, Number(page), key, false)]
    })
    await Promise.all([...runRequests, ...deploymentRequests])
  }

  /** One `deployment:runs` request per key, shared by the load and the warm-up. */
  private async requestRunPage(
    projectId: string,
    owner: string,
    repo: string,
    filter: WorkflowRunFilter,
    page: number,
    key: string,
    silent: boolean
  ): Promise<void> {
    const existing = this.pageRequests[key]
    if (existing) {
      await existing
      return
    }
    const request = (async (): Promise<void> => {
      try {
        const result = await invoke('deployment:runs', projectId, owner, repo, filter, page)
        // A warm-up that only learned GitHub is unreachable must not park a
        // transient page in the cache: it would read as a fresh page, and the click
        // it was warming would skip the fetch it needs.
        if (silent && result.transientError) {
          this.preloadFailures[key] = Date.now()
          return
        }
        this.runPages = {
          ...this.runPages,
          [key]: { page: this.keepRunRowsOnTransient(key, result), fetchedAt: Date.now() }
        }
        delete this.failures[key]
        delete this.preloadFailures[key]
      } catch (reason) {
        if (silent) {
          this.preloadFailures[key] = Date.now()
        } else {
          this.markFailure(key)
          this.setError(errorMessage(reason, 'Workflow runs could not be loaded'))
        }
      }
    })()
    this.pageRequests[key] = request
    try {
      await request
    } finally {
      if (this.pageRequests[key] === request) delete this.pageRequests[key]
    }
  }

  /** One `deployment:deployments` request per key, with the same sharing. */
  private async requestDeploymentPage(
    projectId: string,
    owner: string,
    repo: string,
    page: number,
    key: string,
    silent: boolean
  ): Promise<void> {
    const existing = this.pageRequests[key]
    if (existing) {
      await existing
      return
    }
    const request = (async (): Promise<void> => {
      try {
        const result = await invoke('deployment:deployments', projectId, owner, repo, page)
        if (silent && result.transientError) {
          this.preloadFailures[key] = Date.now()
          return
        }
        this.deploymentPages = {
          ...this.deploymentPages,
          [key]: { page: this.keepDeploymentRowsOnTransient(key, result), fetchedAt: Date.now() }
        }
        delete this.failures[key]
        delete this.preloadFailures[key]
      } catch (reason) {
        if (silent) {
          this.preloadFailures[key] = Date.now()
        } else {
          this.markFailure(key)
          this.setError(errorMessage(reason, 'Deployments could not be loaded'))
        }
      }
    })()
    this.pageRequests[key] = request
    try {
      await request
    } finally {
      if (this.pageRequests[key] === request) delete this.pageRequests[key]
    }
  }

  /**
   * A failed runs page keeps the rows already drawn for it.
   *
   * The reader is looking at a listing, and an outage that blanks twenty rows is a
   * worse answer than the same rows with a line explaining why they may be stale.
   */
  private keepRunRowsOnTransient(
    key: string,
    result: GitHubWorkflowRunPage
  ): GitHubWorkflowRunPage {
    const previous = this.runPages[key]?.page
    if (!result.transientError || !previous || previous.items.length === 0) return result
    return { ...result, items: previous.items }
  }

  private keepDeploymentRowsOnTransient(
    key: string,
    result: GitHubDeploymentPage
  ): GitHubDeploymentPage {
    const previous = this.deploymentPages[key]?.page
    if (!result.transientError || !previous || previous.items.length === 0) return result
    return { ...result, items: previous.items }
  }

  /** Load one deployment's rich detail, serving cache first (same pattern). */
  async ensureDeploymentDetail(
    projectId: string,
    owner: string,
    repo: string,
    deploymentId: number,
    force = false
  ): Promise<GitHubDeploymentDetail | null> {
    const key = deploymentDetailKey(owner, repo, deploymentId)
    const cached = this.details[key]
    if (!force && cached && Date.now() - cached.fetchedAt < DEPLOYMENT_CACHE_TTL_MS) {
      return cached.detail
    }
    if (!force && this.coolingDown(key)) return cached?.detail ?? null
    this.markBusy('deployment-detail', true)
    try {
      const result = await invoke('deployment:detail', projectId, owner, repo, deploymentId)
      this.details = {
        ...this.details,
        [key]: { detail: result, fetchedAt: Date.now() }
      }
      delete this.failures[key]
      return result
    } catch (reason) {
      this.markFailure(key)
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
    const key = workflowRunKey(owner, repo, runId)
    const cached = this.runDetails[key]
    if (!force && cached && Date.now() - cached.fetchedAt < DEPLOYMENT_CACHE_TTL_MS) {
      return cached.detail
    }
    if (!force && this.coolingDown(key)) return cached?.detail ?? null
    this.markBusy('deployment-run-detail', true)
    try {
      const result = await invoke('deployment:runDetail', projectId, owner, repo, runId)
      this.runDetails = {
        ...this.runDetails,
        [key]: { detail: result, fetchedAt: Date.now() }
      }
      delete this.failures[key]
      return result
    } catch (reason) {
      this.markFailure(key)
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
    const key = deploymentLogKey(owner, repo, jobId)
    const cached = this.logs[key]
    if (!force && cached && Date.now() - cached.fetchedAt < DEPLOYMENT_LOG_CACHE_TTL_MS) {
      return cached.log
    }
    if (!force && this.coolingDown(key)) return cached?.log ?? null
    this.markBusy('deployment-log', true)
    try {
      const result = await invoke('deployment:jobLog', projectId, owner, repo, jobId)
      this.logs = {
        ...this.logs,
        [key]: { log: result, fetchedAt: Date.now() }
      }
      delete this.failures[key]
      return result
    } catch (reason) {
      this.markFailure(key)
      throw reason
    } finally {
      this.markBusy('deployment-log', false)
    }
  }

  /**
   * Replay a workflow run's jobs, then drop the cached views so the run, its
   * deployment and its logs are read again instead of showing the stale pre-run
   * state. Returns false when GitHub refused (the reason lands in `error`).
   */
  async rerunWorkflowRun(
    projectId: string,
    owner: string,
    repo: string,
    runId: number,
    mode: WorkflowRerunMode
  ): Promise<boolean> {
    this.markBusy('deployment-rerun', true)
    this.setError(null)
    this.setGitHubPermission(null)
    try {
      const result = await invoke('deployment:rerunRun', projectId, owner, repo, runId, mode)
      if (result.status === 'permission_required') {
        this.setGitHubPermission(result)
        return false
      }
      this.invalidateWorkflowRun(owner, repo, runId)
      return true
    } catch (reason) {
      this.setError(errorMessage(reason, 'The workflow run could not be re-run'))
      return false
    } finally {
      this.markBusy('deployment-rerun', false)
    }
  }

  /**
   * Cancel a queued or in-progress workflow run, then drop the cached views so
   * the run is read again as it settles into `cancelled` instead of showing the
   * stale active state. Returns false when GitHub refused (the reason lands in
   * `error`).
   */
  async cancelWorkflowRun(
    projectId: string,
    owner: string,
    repo: string,
    runId: number
  ): Promise<boolean> {
    this.markBusy('deployment-cancel', true)
    this.setError(null)
    this.setGitHubPermission(null)
    try {
      const result = await invoke('deployment:cancelRun', projectId, owner, repo, runId)
      if (result.status === 'permission_required') {
        this.setGitHubPermission(result)
        return false
      }
      this.invalidateWorkflowRun(owner, repo, runId)
      return true
    } catch (reason) {
      this.setError(errorMessage(reason, 'The workflow run could not be cancelled'))
      return false
    } finally {
      this.markBusy('deployment-cancel', false)
    }
  }

  /**
   * Forget everything a re-run invalidates for one run: the run detail, its job
   * logs (a re-run replaces them), the repositories' page caches that show its
   * state, and the deployment that owns it. The deployment is matched by dropping
   * the whole repository's deployment details, because a run id does not name one.
   */
  private invalidateWorkflowRun(owner: string, repo: string, runId: number): void {
    const runKey = workflowRunKey(owner, repo, runId)
    const jobIds = (this.runDetails[runKey]?.detail.jobs ?? []).map((job) => job.id)

    delete this.runDetails[runKey]

    for (const key of Object.keys(this.runPages)) {
      if (key.startsWith(`${deploymentKey(owner, repo)}#runs:`)) delete this.runPages[key]
    }
    for (const key of Object.keys(this.deploymentPages)) {
      if (key.startsWith(`${deploymentKey(owner, repo)}#deployments:`)) {
        delete this.deploymentPages[key]
      }
    }

    const detailKeys = Object.keys(this.details).filter((key) =>
      key.startsWith(`${deploymentKey(owner, repo)}#`)
    )
    for (const key of detailKeys) delete this.details[key]

    for (const jobId of jobIds) delete this.logs[deploymentLogKey(owner, repo, jobId)]
  }
}
