import type {
  GitRepositoryIdentity,
  PrDraft,
  PullRequestComment,
  PullRequestCommit,
  PullRequestCheck,
  PullRequestChecks,
  PullRequestDetail,
  PullRequestFile,
  PullRequestReview,
  PullRequestReviewComment,
  PullRequestPage,
  PullRequestReference,
  PullRequestSummary
} from '../../lib/types'
import type {
  CreatePrCommentInput,
  CreatePrReviewInput,
  GitProvider,
  ListPullRequestPageInput,
  ListPullRequestsInput,
  MergePullRequestInput,
  PullRequestTarget
} from '../git-provider.interface'
import { Logger } from '../logger'

/** Default provider base URL — the public GitHub.com REST API the app already calls. */
export const GITHUB_API_BASE_URL = 'https://api.github.com'

/** Env var for self-hosted GitHub/GitLab API base URLs (deferred; must be explicit). */
export const PROVIDER_API_BASE_URL_ENV = 'CODEINOVEN_GIT_PROVIDER_API_BASE_URL'

/** Network timeout so a slow provider never hangs the UI. */
const PROVIDER_FETCH_TIMEOUT_MS = 15_000

const GITHUB_API_ACCEPT = 'application/vnd.github+json'
const GITHUB_API_VERSION = '2022-11-28'
const USER_AGENT = 'CodeInOven'

/**
 * GitHub-first REST adapter.
 *
 * The token is resolved from `SecretVault` in the main process only and is
 * never serialized into IPC payloads or logs. Error surfaces are sanitized so
 * the `Authorization` header can never leak.
 */
export class GitHubProvider implements GitProvider {
  constructor(
    private readonly token: string,
    private readonly baseUrl = resolveProviderBaseUrl()
  ) {}

  async createPullRequest(draft: PrDraft): Promise<PullRequestReference> {
    const body = {
      title: draft.title,
      head: draft.head,
      base: draft.base,
      ...(draft.body !== undefined ? { body: draft.body } : {}),
      ...(draft.draft !== undefined ? { draft: draft.draft } : {})
    }
    const response = await this.request(
      `/repos/${encodeURIComponent(draft.owner)}/${encodeURIComponent(draft.repo)}/pulls`,
      { method: 'POST', body: JSON.stringify(body) }
    )
    return this.toReference(response)
  }

  async mergePullRequest(input: MergePullRequestInput): Promise<PullRequestReference> {
    const response = await this.request(
      `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/pulls/${input.pullNumber}/merge`,
      { method: 'PUT', body: JSON.stringify({ merge_method: input.method }) }
    )
    const record = Array.isArray(response) ? {} : response
    return {
      number: input.pullNumber,
      url: `https://github.com/${input.owner}/${input.repo}/pull/${input.pullNumber}`,
      title: this.readString(record, 'title') ?? `Pull request #${input.pullNumber}`
    }
  }

  async listPullRequests(input: ListPullRequestsInput): Promise<PullRequestReference[]> {
    const query = input.state ? `?state=${encodeURIComponent(input.state)}` : ''
    const response = await this.request(
      `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/pulls${query}`,
      { method: 'GET' }
    )
    const items = Array.isArray(response) ? response : []
    return items.flatMap((item): PullRequestReference[] => {
      if (typeof item !== 'object' || item === null) return []
      const record = item as Record<string, unknown>
      const number = typeof record['number'] === 'number' ? record['number'] : 0
      if (number <= 0) return []
      return [
        {
          number,
          url: `https://github.com/${input.owner}/${input.repo}/pull/${number}`,
          title: typeof record['title'] === 'string' ? record['title'] : `Pull request #${number}`
        }
      ]
    })
  }

  async listPullRequestPage(input: ListPullRequestPageInput): Promise<PullRequestPage> {
    const state = input.state ?? 'open'
    // Ask for one extra item so `hasMore` needs no extra round trip.
    const perPage = Math.min(Math.max(input.perPage, 1), 50)
    const query = `?state=${encodeURIComponent(state)}&per_page=${perPage + 1}&page=${input.page}&sort=updated&direction=desc`
    const response = await this.request(`${this.repoPath(input)}/pulls${query}`, { method: 'GET' })
    const items = Array.isArray(response) ? response : []
    const summaries = items.flatMap((item) => {
      const summary = this.toSummary(item, input.owner, input.repo)
      return summary ? [summary] : []
    })
    return {
      items: summaries.slice(0, perPage),
      page: input.page,
      hasMore: summaries.length > perPage
    }
  }

  async getPullRequest(input: PullRequestTarget): Promise<PullRequestDetail> {
    const response = await this.request(`${this.pullPath(input)}`, { method: 'GET' })
    const record = Array.isArray(response) ? {} : response
    const summary = this.toSummary(record, input.owner, input.repo)
    if (!summary) throw new Error(`Pull request #${input.pullNumber} could not be read`)
    const mergeableRaw = record['mergeable']
    return {
      ...summary,
      body: this.readString(record, 'body') ?? '',
      mergeable: typeof mergeableRaw === 'boolean' ? mergeableRaw : null,
      merged: record['merged'] === true,
      additions: this.readNumber(record, 'additions'),
      deletions: this.readNumber(record, 'deletions'),
      changedFiles: this.readNumber(record, 'changed_files'),
      commitCount: this.readNumber(record, 'commits')
    }
  }

  async listPullRequestCommits(input: PullRequestTarget): Promise<PullRequestCommit[]> {
    const response = await this.request(`${this.pullPath(input)}/commits?per_page=100`, {
      method: 'GET'
    })
    const items = Array.isArray(response) ? response : []
    return items.flatMap((item): PullRequestCommit[] => {
      if (typeof item !== 'object' || item === null) return []
      const record = item as Record<string, unknown>
      const sha = this.readString(record, 'sha')
      if (!sha) return []
      const commit = this.readRecord(record, 'commit')
      const author = commit ? this.readRecord(commit, 'author') : null
      return [
        {
          sha,
          shortSha: sha.slice(0, 7),
          message: (commit ? (this.readString(commit, 'message') ?? '') : '').split('\n')[0] ?? '',
          authorName: author ? (this.readString(author, 'name') ?? 'unknown') : 'unknown',
          date: author ? (this.readString(author, 'date') ?? '') : ''
        }
      ]
    })
  }

  async listPullRequestComments(input: PullRequestTarget): Promise<PullRequestComment[]> {
    // PR conversation comments live on the issues endpoint in the GitHub API.
    const response = await this.request(
      `${this.repoPath(input)}/issues/${input.pullNumber}/comments?per_page=100`,
      { method: 'GET' }
    )
    const items = Array.isArray(response) ? response : []
    return items.flatMap((item): PullRequestComment[] => {
      const comment = this.toComment(item)
      return comment ? [comment] : []
    })
  }

  async createPullRequestComment(input: CreatePrCommentInput): Promise<PullRequestComment> {
    const response = await this.request(
      `${this.repoPath(input)}/issues/${input.pullNumber}/comments`,
      { method: 'POST', body: JSON.stringify({ body: input.body }) }
    )
    const comment = this.toComment(response)
    if (!comment) throw new Error('The comment was posted but could not be read back')
    return comment
  }

  async createPullRequestReview(input: CreatePrReviewInput): Promise<void> {
    await this.request(`${this.pullPath(input)}/reviews`, {
      method: 'POST',
      body: JSON.stringify({
        event: input.event,
        ...(input.body ? { body: input.body } : {})
      })
    })
  }

  async listPullRequestFiles(input: PullRequestTarget): Promise<PullRequestFile[]> {
    const response = await this.request(`${this.pullPath(input)}/files?per_page=100`, {
      method: 'GET'
    })
    return this.toFiles(response)
  }

  async listPullRequestReviews(input: PullRequestTarget): Promise<PullRequestReview[]> {
    const response = await this.request(`${this.pullPath(input)}/reviews?per_page=100`, {
      method: 'GET'
    })
    const items = Array.isArray(response) ? response : []
    return items.flatMap((item): PullRequestReview[] => {
      if (typeof item !== 'object' || item === null) return []
      const record = item as Record<string, unknown>
      const id = this.readNumber(record, 'id')
      const state = this.readString(record, 'state') ?? ''
      // A "PENDING" review has not been submitted and is invisible to others.
      if (id <= 0 || state === 'PENDING') return []
      const user = this.readRecord(record, 'user')
      return [
        {
          id,
          authorLogin: user ? (this.readString(user, 'login') ?? 'unknown') : 'unknown',
          state,
          body: this.readString(record, 'body') ?? '',
          submittedAt: this.readString(record, 'submitted_at') ?? ''
        }
      ]
    })
  }

  async listPullRequestReviewComments(
    input: PullRequestTarget
  ): Promise<PullRequestReviewComment[]> {
    const response = await this.request(`${this.pullPath(input)}/comments?per_page=100`, {
      method: 'GET'
    })
    const items = Array.isArray(response) ? response : []
    return items.flatMap((item): PullRequestReviewComment[] => {
      if (typeof item !== 'object' || item === null) return []
      const record = item as Record<string, unknown>
      const id = this.readNumber(record, 'id')
      if (id <= 0) return []
      const user = this.readRecord(record, 'user')
      const line = this.readNumber(record, 'line')
      return [
        {
          id,
          authorLogin: user ? (this.readString(user, 'login') ?? 'unknown') : 'unknown',
          body: this.readString(record, 'body') ?? '',
          path: this.readString(record, 'path') ?? '',
          line: line > 0 ? line : null,
          createdAt: this.readString(record, 'created_at') ?? ''
        }
      ]
    })
  }

  /**
   * CI state for the PR head.
   *
   * GitHub exposes two independent systems — modern check runs and legacy commit
   * statuses — and a repository can use either, so both are merged here.
   */
  async getPullRequestChecks(input: PullRequestTarget): Promise<PullRequestChecks> {
    const detail = await this.request(this.pullPath(input), { method: 'GET' })
    const head = Array.isArray(detail) ? null : this.readRecord(detail, 'head')
    const sha = head ? this.readString(head, 'sha') : null
    if (!sha) return { state: 'none', checks: [] }

    const [runsResponse, statusResponse] = await Promise.all([
      this.request(`${this.repoPath(input)}/commits/${sha}/check-runs?per_page=100`, {
        method: 'GET'
      }).catch(() => ({}) as Record<string, unknown>),
      this.request(`${this.repoPath(input)}/commits/${sha}/status`, { method: 'GET' }).catch(
        () => ({}) as Record<string, unknown>
      )
    ])

    const checks: PullRequestCheck[] = []
    const runsRecord = Array.isArray(runsResponse) ? {} : runsResponse
    const runs = runsRecord['check_runs']
    if (Array.isArray(runs)) {
      for (const run of runs) {
        if (typeof run !== 'object' || run === null) continue
        const record = run as Record<string, unknown>
        checks.push({
          name: this.readString(record, 'name') ?? 'check',
          status: this.toCheckStatus(this.readString(record, 'status')),
          conclusion: this.toCheckConclusion(this.readString(record, 'conclusion')),
          url: this.readString(record, 'html_url')
        })
      }
    }

    const statusRecord = Array.isArray(statusResponse) ? {} : statusResponse
    const statuses = statusRecord['statuses']
    if (Array.isArray(statuses)) {
      for (const status of statuses) {
        if (typeof status !== 'object' || status === null) continue
        const record = status as Record<string, unknown>
        const state = this.readString(record, 'state')
        checks.push({
          name: this.readString(record, 'context') ?? 'status',
          status: state === 'pending' ? 'in_progress' : 'completed',
          conclusion:
            state === 'success' ? 'success' : state === 'pending' ? null : ('failure' as const),
          url: this.readString(record, 'target_url')
        })
      }
    }

    return { state: this.rollUpChecks(checks), checks }
  }

  /** Files and patches for one commit — powers commit drill-down in the sidebar. */
  async getCommitFiles(
    input: { owner: string; repo: string },
    sha: string
  ): Promise<PullRequestFile[]> {
    const response = await this.request(
      `${this.repoPath(input)}/commits/${encodeURIComponent(sha)}`,
      {
        method: 'GET'
      }
    )
    const record = Array.isArray(response) ? {} : response
    return this.toFiles(record['files'])
  }

  resolveRepositoryIdentity(remoteUrl: string): GitRepositoryIdentity | null {
    const url = remoteUrl.trim()
    if (!url) return null
    const match = /(?:github\.com[:/])([^/]+)\/([^/.]+)(?:\.git)?\/?$/u.exec(url)
    if (!match) return null
    const owner = match[1] ?? ''
    const repo = match[2] ?? ''
    if (!owner || !repo) return null
    return { owner, repo }
  }

  /** Perform a JSON fetch against the provider, sanitizing errors. */
  private async request(
    path: string,
    init: RequestInit
  ): Promise<Record<string, unknown> | unknown[]> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PROVIDER_FETCH_TIMEOUT_MS)
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          Accept: GITHUB_API_ACCEPT,
          'X-GitHub-Api-Version': GITHUB_API_VERSION,
          'User-Agent': USER_AGENT,
          Authorization: `Bearer ${this.token}`,
          ...init.headers
        },
        signal: controller.signal
      })
      if (!response.ok) {
        const message = await this.readErrorMessage(response)
        throw new Error(`Provider returned HTTP ${response.status}${message ? `: ${message}` : ''}`)
      }
      if (response.status === 204) return {}
      return (await response.json()) as Record<string, unknown> | unknown[]
    } catch (failure) {
      if (failure instanceof Error && failure.name === 'AbortError') {
        throw new Error('Provider request timed out', { cause: failure })
      }
      throw failure
    } finally {
      clearTimeout(timer)
    }
  }

  /** Read a provider error body's `message` field without touching headers. */
  private async readErrorMessage(response: Response): Promise<string> {
    try {
      const body = (await response.json()) as Record<string, unknown>
      if (typeof body['message'] === 'string') return body['message'].slice(0, 500)
    } catch {
      // Non-JSON error body — fall through to the status-only message.
    }
    return ''
  }

  private toReference(payload: Record<string, unknown> | unknown[]): PullRequestReference {
    const record = Array.isArray(payload) ? {} : (payload as Record<string, unknown>)
    const number = this.readNumber(record, 'number')
    const htmlUrl = this.readString(record, 'html_url')
    const url =
      htmlUrl ??
      (number > 0
        ? `https://github.com/${this.readString(record, 'owner') ?? ''}/${this.readString(record, 'repo') ?? ''}/pull/${number}`
        : '')
    return {
      number,
      url,
      title: this.readString(record, 'title') ?? (number > 0 ? `Pull request #${number}` : '')
    }
  }

  private toFiles(payload: unknown): PullRequestFile[] {
    const items = Array.isArray(payload) ? payload : []
    return items.flatMap((item): PullRequestFile[] => {
      if (typeof item !== 'object' || item === null) return []
      const record = item as Record<string, unknown>
      const path = this.readString(record, 'filename')
      if (!path) return []
      return [
        {
          path,
          status: this.readString(record, 'status') ?? 'modified',
          additions: this.readNumber(record, 'additions'),
          deletions: this.readNumber(record, 'deletions'),
          patch: this.readString(record, 'patch')
        }
      ]
    })
  }

  private toCheckStatus(value: string | null): PullRequestCheck['status'] {
    return value === 'queued' || value === 'in_progress' || value === 'completed'
      ? value
      : 'unknown'
  }

  private toCheckConclusion(value: string | null): PullRequestCheck['conclusion'] {
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

  /** Failure wins over pending, pending over success — the same order GitHub shows. */
  private rollUpChecks(checks: PullRequestCheck[]): PullRequestChecks['state'] {
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

  private repoPath(input: { owner: string; repo: string }): string {
    return `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`
  }

  private pullPath(input: PullRequestTarget): string {
    return `${this.repoPath(input)}/pulls/${input.pullNumber}`
  }

  /** Map a GitHub pull payload to the renderer-safe summary, or null if unusable. */
  private toSummary(payload: unknown, owner: string, repo: string): PullRequestSummary | null {
    if (typeof payload !== 'object' || payload === null) return null
    const record = payload as Record<string, unknown>
    const number = this.readNumber(record, 'number')
    if (number <= 0) return null
    const head = this.readRecord(record, 'head')
    const base = this.readRecord(record, 'base')
    const user = this.readRecord(record, 'user')
    const rawState = this.readString(record, 'state') ?? 'open'
    const merged = record['merged'] === true || this.readString(record, 'merged_at') !== null
    return {
      number,
      title: this.readString(record, 'title') ?? `Pull request #${number}`,
      url:
        this.readString(record, 'html_url') ?? `https://github.com/${owner}/${repo}/pull/${number}`,
      state: merged ? 'merged' : rawState === 'closed' ? 'closed' : 'open',
      draft: record['draft'] === true,
      authorLogin: user ? (this.readString(user, 'login') ?? 'unknown') : 'unknown',
      headRef: head ? (this.readString(head, 'ref') ?? '') : '',
      baseRef: base ? (this.readString(base, 'ref') ?? '') : '',
      createdAt: this.readString(record, 'created_at') ?? '',
      updatedAt: this.readString(record, 'updated_at') ?? '',
      comments: this.readNumber(record, 'comments')
    }
  }

  private toComment(payload: unknown): PullRequestComment | null {
    if (typeof payload !== 'object' || payload === null) return null
    const record = payload as Record<string, unknown>
    const id = this.readNumber(record, 'id')
    if (id <= 0) return null
    const user = this.readRecord(record, 'user')
    return {
      id,
      authorLogin: user ? (this.readString(user, 'login') ?? 'unknown') : 'unknown',
      body: this.readString(record, 'body') ?? '',
      createdAt: this.readString(record, 'created_at') ?? '',
      url: this.readString(record, 'html_url') ?? ''
    }
  }

  private readRecord(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
    const value = record[key]
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  }

  private readString(record: Record<string, unknown>, key: string): string | null {
    const value = record[key]
    return typeof value === 'string' ? value : null
  }

  private readNumber(record: Record<string, unknown>, key: string): number {
    const value = record[key]
    return typeof value === 'number' && Number.isSafeInteger(value) ? value : 0
  }
}

/** Resolve the provider base URL, honoring the env contract with GitHub.com default. */
export function resolveProviderBaseUrl(): string {
  const configured = process.env[PROVIDER_API_BASE_URL_ENV]?.trim()
  if (!configured) return GITHUB_API_BASE_URL
  const normalized = configured.replace(/\/+$/u, '')
  if (/^https?:\/\/localhost(:\d+)?$/u.test(normalized)) {
    return normalized
  }
  if (/^https:\/\/[^/\s]+$/u.test(normalized)) {
    return normalized
  }
  Logger.error(
    `${PROVIDER_API_BASE_URL_ENV} is not an explicit verified HTTPS host; ignoring "${configured}"`
  )
  return GITHUB_API_BASE_URL
}
