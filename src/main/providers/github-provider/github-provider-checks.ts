import type {
  PullRequestCheck,
  PullRequestChecks,
  PullRequestChecksRollup
} from '../../../lib/types'
import type { PullRequestTarget } from '../../git/git-provider.interface'
import type { GitHubProvider } from '../github-provider'

/**  checks */
export class GitHubProviderChecks {
  constructor(private readonly host: GitHubProvider) {}

  /**
   * CI state for the PR head.
   *
   * GitHub exposes two independent systems   modern check runs and classic commit
   * statuses   and a repository can use either, so both are merged here.
   */
  async getPullRequestChecks(input: PullRequestTarget): Promise<PullRequestChecks> {
    const detail = await this.host.request(this.host.pullPath(input), { method: 'GET' })
    const head = Array.isArray(detail) ? null : this.host.readRecord(detail, 'head')
    const sha = head ? this.host.readString(head, 'sha') : null
    if (!sha) return { state: 'none', checks: [] }

    const [runsResponse, statusResponse] = await Promise.all([
      this.host
        .request(`${this.host.repoPath(input)}/commits/${sha}/check-runs?per_page=100`, {
          method: 'GET'
        })
        .catch(() => ({}) as Record<string, unknown>),
      this.host
        .request(`${this.host.repoPath(input)}/commits/${sha}/status`, { method: 'GET' })
        .catch(() => ({}) as Record<string, unknown>)
    ])

    const checks: PullRequestCheck[] = []
    const runsRecord = Array.isArray(runsResponse) ? {} : runsResponse
    const runs = runsRecord['check_runs']
    if (Array.isArray(runs)) {
      for (const run of runs) {
        if (typeof run !== 'object' || run === null) continue
        const record = run as Record<string, unknown>
        const detailsUrl = this.host.readString(record, 'details_url')
        const htmlUrl = this.host.readString(record, 'html_url')
        checks.push({
          name: this.host.readString(record, 'name') ?? 'check',
          status: this.toCheckStatus(this.host.readString(record, 'status')),
          conclusion: this.toCheckConclusion(this.host.readString(record, 'conclusion')),
          url: htmlUrl ?? detailsUrl,
          workflowRunId: this.host.workflowRunIdFromUrls(detailsUrl, htmlUrl),
          jobId: this.host.jobIdFromUrls(detailsUrl, htmlUrl)
        })
      }
    }

    const statusRecord = Array.isArray(statusResponse) ? {} : statusResponse
    const statuses = statusRecord['statuses']
    if (Array.isArray(statuses)) {
      for (const status of statuses) {
        if (typeof status !== 'object' || status === null) continue
        const record = status as Record<string, unknown>
        const state = this.host.readString(record, 'state')
        const targetUrl = this.host.readString(record, 'target_url')
        checks.push({
          name: this.host.readString(record, 'context') ?? 'status',
          status: state === 'pending' ? 'in_progress' : 'completed',
          conclusion:
            state === 'success' ? 'success' : state === 'pending' ? null : ('failure' as const),
          url: targetUrl,
          workflowRunId: this.host.workflowRunIdFromUrls(targetUrl),
          jobId: this.host.jobIdFromUrls(targetUrl)
        })
      }
    }

    return { state: this.rollUpChecks(checks), checks }
  }

  /** Files and patches for one commit   powers commit drill-down in the sidebar. */

  toCheckStatus(value: string | null): PullRequestCheck['status'] {
    return value === 'queued' || value === 'in_progress' || value === 'completed'
      ? value
      : 'unknown'
  }

  toCheckConclusion(value: string | null): PullRequestCheck['conclusion'] {
    switch (value) {
      case 'success':
      case 'failure':
      case 'neutral':
      case 'cancelled':
      case 'timed_out':
      case 'action_required':
      case 'skipped':
        return value
      default:
        return null
    }
  }

  /** Failure wins over pending, pending over success   the same order GitHub shows. */

  /** Failure wins over pending, pending over success   the same order GitHub shows. */
  rollUpChecks(checks: PullRequestCheck[]): PullRequestChecks['state'] {
    if (checks.length === 0) return 'none'
    const failing = checks.some(
      (check) =>
        check.conclusion === 'failure' ||
        check.conclusion === 'timed_out' ||
        check.conclusion === 'action_required'
    )
    if (failing) return 'failure'
    if (checks.some((check) => check.status !== 'completed')) return 'pending'
    return 'success'
  }

  /**
   * Roll up the head commit's checks, or undefined when the commit carries no
   * status rollup at all.
   *
   * Undefined rather than a `none` state on purpose: the list draws no check
   * signal for a repository that never ran anything, while `none` means the
   * rollup exists and is empty.
   */
  readChecksRollup(record: Record<string, unknown>): PullRequestChecksRollup | undefined {
    const commits = this.host.readRecord(record, 'commits')
    const commitNodes: unknown[] =
      commits && Array.isArray(commits['nodes']) ? commits['nodes'] : []
    const headNode = commitNodes[0]
    if (typeof headNode !== 'object' || headNode === null) return undefined
    const commit = this.host.readRecord(headNode as Record<string, unknown>, 'commit')
    const rollup = commit ? this.host.readRecord(commit, 'statusCheckRollup') : null
    if (!rollup) return undefined
    const rawState = this.host.readString(rollup, 'state')
    const state: PullRequestChecksRollup['state'] =
      rawState === 'SUCCESS'
        ? 'success'
        : rawState === 'FAILURE' || rawState === 'ERROR'
          ? 'failure'
          : rawState === 'PENDING' || rawState === 'EXPECTED'
            ? 'pending'
            : 'none'
    const contexts = this.host.readRecord(rollup, 'contexts')
    const contextNodes: unknown[] =
      contexts && Array.isArray(contexts['nodes']) ? contexts['nodes'] : []
    let passed = 0
    for (const context of contextNodes) {
      if (typeof context !== 'object' || context === null) continue
      const entry = context as Record<string, unknown>
      const typename = this.host.readString(entry, '__typename')
      const succeeded =
        (typename === 'CheckRun' &&
          this.host.readString(entry, 'status') === 'COMPLETED' &&
          this.host.readString(entry, 'conclusion') === 'SUCCESS') ||
        (typename === 'StatusContext' && this.host.readString(entry, 'state') === 'SUCCESS')
      if (succeeded) passed += 1
    }
    return {
      state,
      passed,
      total: contexts ? this.host.readNumber(contexts, 'totalCount') : 0
    }
  }
}
