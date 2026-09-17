import { invoke } from '$lib/ipc.svelte'
import type {
  GitHubDeploymentDetail,
  GitHubDeploymentJobLog,
  GitHubDeploymentOverviewResult,
  GitHubWorkflowRunDetail
} from '$shared/types'
import {
  DEPLOYMENT_CACHE_TTL_MS,
  DEPLOYMENT_LOG_CACHE_TTL_MS,
  PR_ERROR_COOLDOWN_MS,
  deploymentDetailKey,
  deploymentKey,
  deploymentLogKey,
  workflowRunKey,
  type GitOperation
} from './git-store-helpers'

/**
 * Cached deployment overviews, details, and job logs - the same
 * stale-while-revalidate pattern as the PR caches. The Deployments tab is
 * mounted/unmounted on every tab switch, so cached data renders instantly
 * and is revalidated in the background once it ages past the TTL.
 */
export class GitDeploymentCache {
  overviews: Record<string, { overview: GitHubDeploymentOverviewResult; fetchedAt: number }> =
    $state({})
  details: Record<string, { detail: GitHubDeploymentDetail; fetchedAt: number }> = $state({})
  runDetails: Record<string, { detail: GitHubWorkflowRunDetail; fetchedAt: number }> = $state({})
  logs: Record<string, { log: GitHubDeploymentJobLog; fetchedAt: number }> = $state({})

  /**
   * Epoch ms of the last failure per deployment cache key. Deliberately plain
   * (not `$state`) - it only gates fetching, and making it reactive would feed
   * the very effects that triggered the request.
   */
  private failures: Record<string, number> = {}

  /** One overview probe per repository, shared by tab discovery and the monitor. */
  private overviewRequests: Record<
    string,
    Promise<GitHubDeploymentOverviewResult | null> | undefined
  > = {}

  constructor(private readonly markBusy: (operation: GitOperation, busy: boolean) => void) {}

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
    const key = deploymentKey(owner, repo)
    const cached = this.overviews[key]
    if (!force && cached && Date.now() - cached.fetchedAt < DEPLOYMENT_CACHE_TTL_MS) {
      return cached.overview
    }
    if (!force && this.coolingDown(key)) return cached?.overview ?? null
    const existingRequest = this.overviewRequests[key]
    if (existingRequest) return existingRequest

    const request = this.loadDeploymentOverview(projectId, owner, repo, key)
    this.overviewRequests[key] = request
    try {
      return await request
    } finally {
      if (this.overviewRequests[key] === request) {
        delete this.overviewRequests[key]
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
      this.overviews = {
        ...this.overviews,
        [key]: { overview: result, fetchedAt: Date.now() }
      }
      delete this.failures[key]
      return result
    } catch (reason) {
      this.markFailure(key)
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
}
