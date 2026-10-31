import type {
  GitHubDeployment,
  GitHubDeploymentDetail,
  GitHubDeploymentJob,
  GitHubDeploymentJobLog,
  GitHubDeploymentJobStep,
  GitHubDeploymentPage,
  GitHubDeploymentStatus,
  GitHubWorkflowRun,
  GitHubWorkflowRunDetail,
  GitHubWorkflowRunPage,
  WorkflowRerunMode
} from '../../../lib/types'
import { capJobLogText } from '../../../lib/github-job-log'
import type {
  ListWorkflowRunPageInput,
  ListDeploymentPageInput
} from '../../git/git-provider.interface'
import { MAX_JOB_LOG_BYTES, WORKFLOW_RUN_FILTER_STATUS } from '../github-provider'
import type { GitHubProvider } from '../github-provider'

/**  workflows */
export class GitHubProviderWorkflows {
  constructor(private readonly host: GitHubProvider) {}

  /**
   * One page of the repository's workflow runs, newest first.
   *
   * Asks for one row beyond the page on purpose: a page-numbered listing can read
   * that extra row without moving anything, so `hasMore` is the server's answer
   * rather than a guess from a page that came back exactly full.
   */
  async listWorkflowRunPage(input: ListWorkflowRunPageInput): Promise<GitHubWorkflowRunPage> {
    const perPage = Math.min(Math.max(input.perPage, 1), 50)
    const params = new URLSearchParams({
      per_page: String(perPage + 1),
      page: String(input.page)
    })
    const status = WORKFLOW_RUN_FILTER_STATUS[input.filter]
    if (status) params.set('status', status)
    const response = await this.host.request(
      `${this.host.repoPath(input)}/actions/runs?${params.toString()}`,
      { method: 'GET' }
    )
    const record = Array.isArray(response) ? {} : response
    const rawRuns = Array.isArray(record['workflow_runs']) ? record['workflow_runs'] : []
    const items = rawRuns.slice(0, perPage).flatMap((run): GitHubWorkflowRun[] => {
      const mapped = this.toWorkflowRun(run)
      return mapped ? [mapped] : []
    })
    return { items, page: input.page, hasMore: rawRuns.length > perPage }
  }

  /**
   * One page of the repository's deployments, newest first, each carrying the
   * latest status GitHub recorded for it.
   *
   * Statuses are fetched beside the page rather than in sequence, and a failed
   * status read leaves that deployment standing without one: a listing that loses
   * a row because its status timed out is worse than a row with no state yet.
   */

  /**
   * One page of the repository's deployments, newest first, each carrying the
   * latest status GitHub recorded for it.
   *
   * Statuses are fetched beside the page rather than in sequence, and a failed
   * status read leaves that deployment standing without one: a listing that loses
   * a row because its status timed out is worse than a row with no state yet.
   */
  async listDeploymentPage(input: ListDeploymentPageInput): Promise<GitHubDeploymentPage> {
    const perPage = Math.min(Math.max(input.perPage, 1), 50)
    const params = new URLSearchParams({
      per_page: String(perPage + 1),
      page: String(input.page)
    })
    const response = await this.host.request(
      `${this.host.repoPath(input)}/deployments?${params.toString()}`,
      {
        method: 'GET'
      }
    )
    const rawDeployments = (Array.isArray(response) ? response : []).slice(0, perPage)
    const items = await Promise.all(
      rawDeployments.flatMap((deployment): Array<Promise<GitHubDeployment>> => {
        const mapped = this.toDeployment(deployment)
        if (!mapped) return []
        return [
          this.host
            .request(`${this.host.repoPath(input)}/deployments/${mapped.id}/statuses?per_page=1`, {
              method: 'GET'
            })
            .then((statuses) => ({
              ...mapped,
              latestStatus: this.toDeploymentStatus(Array.isArray(statuses) ? statuses[0] : null)
            }))
            .catch(() => mapped)
        ]
      })
    )
    return {
      items,
      page: input.page,
      hasMore: Array.isArray(response) && response.length > perPage
    }
  }

  /**
   * Whether the repository has any Actions or Deployments activity at all.
   *
   * Two one-row reads answer the question the Deployments view is gated on, so the
   * panel never pays for a listing it is only asking about.
   */

  /**
   * Whether the repository has any Actions or Deployments activity at all.
   *
   * Two one-row reads answer the question the Deployments view is gated on, so the
   * panel never pays for a listing it is only asking about.
   */
  async hasDeploymentActivity(input: { owner: string; repo: string }): Promise<boolean> {
    const base = this.host.repoPath(input)
    const [runsResponse, deploymentsResponse] = await Promise.all([
      this.host.request(`${base}/actions/runs?per_page=1`, { method: 'GET' }),
      this.host.request(`${base}/deployments?per_page=1`, { method: 'GET' })
    ])
    const runsRecord = Array.isArray(runsResponse) ? {} : runsResponse
    const runCount = typeof runsRecord['total_count'] === 'number' ? runsRecord['total_count'] : 0
    const rawRuns = Array.isArray(runsRecord['workflow_runs']) ? runsRecord['workflow_runs'] : []
    return (
      runCount > 0 ||
      rawRuns.length > 0 ||
      (Array.isArray(deploymentsResponse) && deploymentsResponse.length > 0)
    )
  }

  /**
   * Everything the in-app deployment detail view needs: the deployment itself,
   * its full status history, the Actions run that drove it, and that run's
   * job/step breakdown. Each sub-request degrades gracefully so a partial
   * picture still renders instead of failing the whole drill-down.
   */

  /**
   * Everything the in-app deployment detail view needs: the deployment itself,
   * its full status history, the Actions run that drove it, and that run's
   * job/step breakdown. Each sub-request degrades gracefully so a partial
   * picture still renders instead of failing the whole drill-down.
   */
  async getDeploymentDetail(input: {
    owner: string
    repo: string
    deploymentId: number
  }): Promise<GitHubDeploymentDetail> {
    const base = this.host.repoPath(input)
    const [deploymentPayload, statusesPayload] = await Promise.all([
      this.host
        .request(`${base}/deployments/${input.deploymentId}`, { method: 'GET' })
        .catch(() => null),
      this.host
        .request(`${base}/deployments/${input.deploymentId}/statuses?per_page=50`, {
          method: 'GET'
        })
        .catch(() => null)
    ])
    const deploymentRecord =
      !Array.isArray(deploymentPayload) && deploymentPayload !== null ? deploymentPayload : null
    const deploymentBase = (deploymentRecord ? this.toDeployment(deploymentRecord) : null) ?? {
      id: input.deploymentId,
      environment: 'Deployment',
      description: '',
      ref: '',
      sha: '',
      createdAt: '',
      updatedAt: '',
      latestStatus: null
    }
    const statuses = Array.isArray(statusesPayload)
      ? statusesPayload.flatMap((entry): GitHubDeploymentStatus[] => {
          const mapped = this.toDeploymentStatus(entry)
          return mapped ? [mapped] : []
        })
      : []
    const deployment: GitHubDeployment = {
      ...deploymentBase,
      latestStatus: statuses[0] ?? deploymentBase.latestStatus
    }
    const workflowRun = await this.resolveDeploymentRun(input, deployment, statuses)
    const jobs = workflowRun ? await this.getRunJobs(input, workflowRun.id) : []
    return { deployment, statuses, workflowRun, jobs, fetchedAt: Date.now() }
  }

  /** Everything the in-app workflow-run detail view needs (run + jobs). */

  /** Everything the in-app workflow-run detail view needs (run + jobs). */
  async getWorkflowRunDetail(input: {
    owner: string
    repo: string
    runId: number
  }): Promise<GitHubWorkflowRunDetail> {
    const base = this.host.repoPath(input)
    const [runPayload, jobs] = await Promise.all([
      this.host.request(`${base}/actions/runs/${input.runId}`, { method: 'GET' }).catch(() => null),
      this.getRunJobs(input, input.runId)
    ])
    const mapped =
      runPayload !== null && !Array.isArray(runPayload) ? this.toWorkflowRun(runPayload) : null
    const run: GitHubWorkflowRun = mapped ?? {
      id: input.runId,
      name: 'Workflow',
      displayTitle: `Workflow run #${input.runId}`,
      runNumber: input.runId,
      event: '',
      status: 'unknown',
      conclusion: null,
      branch: '',
      headSha: '',
      url: '',
      actorLogin: '',
      createdAt: '',
      updatedAt: ''
    }
    return { run, jobs, fetchedAt: Date.now() }
  }

  /** Raw log text for one workflow run job, capped and sectioned by the renderer. */

  /** Raw log text for one workflow run job, capped and sectioned by the renderer. */
  async getDeploymentJobLog(input: {
    owner: string
    repo: string
    jobId: number
  }): Promise<GitHubDeploymentJobLog> {
    const path = `${this.host.repoPath(input)}/actions/jobs/${input.jobId}/logs`
    const text = await this.host.requestText(path)
    const capped = capJobLogText(text, MAX_JOB_LOG_BYTES)
    return {
      jobId: input.jobId,
      log: capped.log,
      truncated: capped.truncated
    }
  }

  /**
   * Replay a workflow run. GitHub spells the two modes as separate endpoints and
   * answers both with 201 and no body.
   */

  /**
   * Replay a workflow run. GitHub spells the two modes as separate endpoints and
   * answers both with 201 and no body.
   */
  async rerunWorkflowRun(input: {
    owner: string
    repo: string
    runId: number
    mode: WorkflowRerunMode
  }): Promise<void> {
    const suffix = input.mode === 'failed' ? '/rerun-failed-jobs' : '/rerun'
    await this.host.request(`${this.host.repoPath(input)}/actions/runs/${input.runId}${suffix}`, {
      method: 'POST'
    })
  }

  /**
   * Cancel a queued or in-progress workflow run. GitHub accepts the request and
   * answers with 202; the run settles into `cancelled` asynchronously, so callers
   * re-read the run rather than trusting the mutation's return.
   */

  /**
   * Cancel a queued or in-progress workflow run. GitHub accepts the request and
   * answers with 202; the run settles into `cancelled` asynchronously, so callers
   * re-read the run rather than trusting the mutation's return.
   */
  async cancelWorkflowRun(input: { owner: string; repo: string; runId: number }): Promise<void> {
    await this.host.request(`${this.host.repoPath(input)}/actions/runs/${input.runId}/cancel`, {
      method: 'POST'
    })
  }

  /** Resolve the Actions run behind a deployment: from a status URL first, then by head sha. */

  /** Resolve the Actions run behind a deployment: from a status URL first, then by head sha. */
  async resolveDeploymentRun(
    input: { owner: string; repo: string },
    deployment: GitHubDeployment,
    statuses: GitHubDeploymentStatus[]
  ): Promise<GitHubWorkflowRun | null> {
    const linkedRunId = this.runIdFromDeploymentStatuses(statuses)
    if (linkedRunId > 0) {
      const runPayload = await this.host
        .request(`${this.host.repoPath(input)}/actions/runs/${linkedRunId}`, {
          method: 'GET'
        })
        .catch(() => null)
      if (runPayload !== null && !Array.isArray(runPayload)) {
        const mapped = this.toWorkflowRun(runPayload)
        if (mapped) return mapped
      }
    }
    if (!deployment.sha) return null
    const runsPayload = await this.host
      .request(
        `${this.host.repoPath(input)}/actions/runs?head_sha=${encodeURIComponent(deployment.sha)}&per_page=5`,
        { method: 'GET' }
      )
      .catch(() => null)
    const record = Array.isArray(runsPayload) ? {} : (runsPayload ?? {})
    const rawRuns = Array.isArray(record['workflow_runs']) ? record['workflow_runs'] : []
    for (const entry of rawRuns) {
      const mapped = this.toWorkflowRun(entry)
      if (mapped) return mapped
    }
    return null
  }

  /** Deployment statuses created by Actions carry the run id in their log/env URLs. */

  /** Deployment statuses created by Actions carry the run id in their log/env URLs. */
  runIdFromDeploymentStatuses(statuses: GitHubDeploymentStatus[]): number {
    for (const status of statuses) {
      const id = this.workflowRunIdFromUrls(status.logUrl, status.environmentUrl)
      if (id !== null) return id
    }
    return 0
  }

  /** Extract an Actions workflow-run id without adding another provider request. */

  /** Extract an Actions workflow-run id without adding another provider request. */
  workflowRunIdFromUrls(...urls: Array<string | null>): number | null {
    for (const url of urls) {
      if (!url) continue
      const match = /\/actions\/runs\/(\d+)/u.exec(url)
      if (!match) continue
      const id = Number.parseInt(match[1] ?? '', 10)
      if (Number.isSafeInteger(id) && id > 0) return id
    }
    return null
  }

  /**
   * Extract the Actions job id a check points at. Actions puts
   * `/actions/runs/{runId}/job/{jobId}` in `details_url`, which is the only place
   * that identifies the individual matrix leg the check represents.
   */

  /**
   * Extract the Actions job id a check points at. Actions puts
   * `/actions/runs/{runId}/job/{jobId}` in `details_url`, which is the only place
   * that identifies the individual matrix leg the check represents.
   */
  jobIdFromUrls(...urls: Array<string | null>): number | null {
    for (const url of urls) {
      if (!url) continue
      const match = /\/job\/(\d+)/u.exec(url)
      if (!match) continue
      const id = Number.parseInt(match[1] ?? '', 10)
      if (Number.isSafeInteger(id) && id > 0) return id
    }
    return null
  }

  async getRunJobs(
    input: { owner: string; repo: string },
    runId: number
  ): Promise<GitHubDeploymentJob[]> {
    const response = await this.host
      .request(`${this.host.repoPath(input)}/actions/runs/${runId}/jobs?per_page=50`, {
        method: 'GET'
      })
      .catch(() => null)
    const record = Array.isArray(response) ? {} : (response ?? {})
    const rawJobs = Array.isArray(record['jobs']) ? record['jobs'] : []
    return rawJobs.flatMap((job): GitHubDeploymentJob[] => {
      const mapped = this.toDeploymentJob(job)
      return mapped ? [mapped] : []
    })
  }

  /** Download redirected raw content while using GitHub's required JSON media type. */

  toWorkflowRun(payload: unknown): GitHubWorkflowRun | null {
    if (typeof payload !== 'object' || payload === null) return null
    const record = payload as Record<string, unknown>
    const id = this.host.readNumber(record, 'id')
    if (id <= 0) return null
    const actor = this.host.readRecord(record, 'actor')
    const rawStatus = this.host.readString(record, 'status')
    const status =
      rawStatus === 'queued' || rawStatus === 'in_progress' || rawStatus === 'completed'
        ? rawStatus
        : 'unknown'
    return {
      id,
      name: this.host.readString(record, 'name') ?? 'Workflow',
      displayTitle: this.host.readString(record, 'display_title') ?? 'Workflow run',
      runNumber: this.host.readNumber(record, 'run_number'),
      event: this.host.readString(record, 'event') ?? '',
      status,
      conclusion: this.host.readString(record, 'conclusion'),
      branch: this.host.readString(record, 'head_branch') ?? '',
      headSha: this.host.readString(record, 'head_sha') ?? '',
      url: this.host.readString(record, 'html_url') ?? '',
      actorLogin: actor ? (this.host.readString(actor, 'login') ?? '') : '',
      createdAt: this.host.readString(record, 'created_at') ?? '',
      updatedAt: this.host.readString(record, 'updated_at') ?? ''
    }
  }

  toDeployment(payload: unknown): GitHubDeployment | null {
    if (typeof payload !== 'object' || payload === null) return null
    const record = payload as Record<string, unknown>
    const id = this.host.readNumber(record, 'id')
    if (id <= 0) return null
    return {
      id,
      environment: this.host.readString(record, 'environment') ?? 'Deployment',
      description: this.host.readString(record, 'description') ?? '',
      ref: this.host.readString(record, 'ref') ?? '',
      sha: this.host.readString(record, 'sha') ?? '',
      createdAt: this.host.readString(record, 'created_at') ?? '',
      updatedAt: this.host.readString(record, 'updated_at') ?? '',
      latestStatus: null
    }
  }

  toDeploymentStatus(payload: unknown): GitHubDeploymentStatus | null {
    if (typeof payload !== 'object' || payload === null) return null
    const record = payload as Record<string, unknown>
    const state = this.host.readString(record, 'state')
    if (!state) return null
    return {
      state,
      description: this.host.readString(record, 'description') ?? '',
      environmentUrl: this.host.readString(record, 'environment_url'),
      logUrl: this.host.readString(record, 'log_url'),
      createdAt: this.host.readString(record, 'created_at') ?? ''
    }
  }

  toDeploymentJob(payload: unknown): GitHubDeploymentJob | null {
    if (typeof payload !== 'object' || payload === null) return null
    const record = payload as Record<string, unknown>
    const id = this.host.readNumber(record, 'id')
    if (id <= 0) return null
    const rawSteps = Array.isArray(record['steps']) ? record['steps'] : []
    const steps = rawSteps.flatMap((step): GitHubDeploymentJobStep[] => {
      const mapped = this.toDeploymentJobStep(step)
      return mapped ? [mapped] : []
    })
    return {
      id,
      name: this.host.readString(record, 'name') ?? 'Job',
      status: this.host.readString(record, 'status') ?? 'unknown',
      conclusion: this.host.readString(record, 'conclusion'),
      startedAt: this.host.readString(record, 'started_at') ?? '',
      completedAt: this.host.readString(record, 'completed_at'),
      url: this.host.readString(record, 'html_url') ?? '',
      steps
    }
  }

  toDeploymentJobStep(payload: unknown): GitHubDeploymentJobStep | null {
    if (typeof payload !== 'object' || payload === null) return null
    const record = payload as Record<string, unknown>
    const number = this.host.readNumber(record, 'number')
    if (number <= 0) return null
    const rawStatus = this.host.readString(record, 'status')
    const status =
      rawStatus === 'queued' || rawStatus === 'in_progress' || rawStatus === 'completed'
        ? rawStatus
        : 'unknown'
    return {
      number,
      name: this.host.readString(record, 'name') ?? 'Step',
      status,
      conclusion: this.host.readString(record, 'conclusion')
    }
  }
}
