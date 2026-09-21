import type {
  GitHubDeployment,
  GitHubDeploymentDetail,
  GitHubDeploymentJob,
  GitHubDeploymentJobLog,
  GitHubDeploymentJobStep,
  GitHubDeploymentOverview,
  GitHubDeploymentStatus,
  GitRepositoryIdentity,
  GitHubWorkflowRun,
  GitHubWorkflowRunDetail,
  PrCommentKind,
  PrDraft,
  PrListSort,
  PullRequestComment,
  PullRequestCommit,
  PullRequestCheck,
  PullRequestChecks,
  PullRequestChecksRollup,
  PullRequestCompare,
  PullRequestDetail,
  PullRequestFile,
  PullRequestLabel,
  PullRequestReview,
  PullRequestReviewComment,
  PullRequestPage,
  PullRequestReference,
  PullRequestSummary,
  RepositoryMentionUser,
  WorkflowRerunMode
} from '../../lib/types'
import { capJobLogText } from '../../lib/github-job-log'
import type {
  CreatePrCommentInput,
  CreatePrReviewInput,
  GitProvider,
  ListPullRequestPageInput,
  ListPullRequestsInput,
  MergePullRequestInput,
  MinimizePrCommentInput,
  PrCommentTarget,
  PullRequestTarget,
  ReplyPrReviewCommentInput,
  UpdatePrCommentInput
} from '../git/git-provider.interface'
import { Logger } from '../system/logger'

/** Default provider base URL   the public GitHub.com REST API the app already calls. */
export const GITHUB_API_BASE_URL = 'https://api.github.com'

/** Env var for self-hosted GitHub/GitLab API base URLs (deferred; must be explicit). */
export const PROVIDER_API_BASE_URL_ENV = 'CODEINOVEN_GIT_PROVIDER_API_BASE_URL'

/** Network timeout so a slow provider never hangs the UI. */
const PROVIDER_FETCH_TIMEOUT_MS = 15_000

/**
 * Cap on the raw job log text streamed into the app (roughly 200 KB). An oversized
 * log loses its middle, never its end: that is where the failing step is.
 */
const MAX_JOB_LOG_BYTES = 200_000

const GITHUB_API_ACCEPT = 'application/vnd.github+json'
const GITHUB_API_VERSION = '2022-11-28'
const USER_AGENT = 'CodeInOven'

/** Sanitized provider failure that preserves the HTTP status for IPC handling. */
export class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(`Provider returned HTTP ${status}${message ? `: ${message}` : ''}`)
    this.name = 'ProviderHttpError'
  }
}

/**
 * Sanitized GraphQL failure that keeps GitHub's own error `type`.
 *
 * GraphQL answers HTTP 200 even when it rejects a request, so the transport has
 * to raise its own error. The `type` (FORBIDDEN, NOT_FOUND, …) is what lets a
 * caller tell a permanent access failure from a transient one without parsing
 * the message.
 */
export class ProviderGraphqlError extends Error {
  constructor(
    message: string,
    readonly type: string | null
  ) {
    super(message)
    this.name = 'ProviderGraphqlError'
  }
}

/**
 * One GraphQL search for a page of pull requests.
 *
 * Search rather than the repository's `pullRequests` connection because
 * `author:@me` and `review-requested:@me` are questions only the search index can
 * answer, and because one response then carries the labels, comment count and
 * check rollup the sidebar list draws without a follow-up request per row.
 */
const PULL_REQUEST_LIST_QUERY = `query PullRequestList($q: String!, $first: Int!, $after: String) {
  search(query: $q, type: ISSUE, first: $first, after: $after) {
    pageInfo {
      hasNextPage
      endCursor
    }
    nodes {
      __typename
      ... on PullRequest {
        number
        title
        url
        state
        isDraft
        createdAt
        updatedAt
        mergeable
        mergeStateStatus
        headRefName
        baseRefName
        author {
          login
          avatarUrl
        }
        labels(first: 20) {
          nodes {
            name
            color
          }
        }
        totalCommentsCount
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                state
                contexts(first: 100) {
                  totalCount
                  nodes {
                    __typename
                    ... on CheckRun {
                      conclusion
                      status
                    }
                    ... on StatusContext {
                      state
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}`

/**
 * The `sort:` qualifier for each ordering the listing offers.
 *
 * A record keyed by the union rather than a chain of comparisons, so adding an
 * ordering to `PrListSort` without giving it a qualifier here fails to compile
 * instead of silently listing by something else.
 */
const PULL_REQUEST_LIST_SORTS: Record<PrListSort, string> = {
  updated: 'sort:updated-desc',
  created: 'sort:created-desc',
  'comments-desc': 'sort:comments-desc',
  'updated-asc': 'sort:updated-asc',
  'created-asc': 'sort:created-asc',
  'comments-asc': 'sort:comments-asc'
}

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
    private readonly baseUrl = resolveProviderBaseUrl(),
    private readonly refreshAccessToken?: () => Promise<string | null>
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
    const body: Record<string, unknown> = { merge_method: input.method }
    // Rebase preserves the original commits, so GitHub ignores custom messages
    // there. For merge-commit and squash the title/message become the commit.
    if (input.method !== 'rebase') {
      if (input.commitTitle) body['commit_title'] = input.commitTitle
      if (input.commitMessage) body['commit_message'] = input.commitMessage
    }
    const response = await this.request(
      `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/pulls/${input.pullNumber}/merge`,
      { method: 'PUT', body: JSON.stringify(body) }
    )
    const record = Array.isArray(response) ? {} : response
    return {
      number: input.pullNumber,
      url: `https://github.com/${input.owner}/${input.repo}/pull/${input.pullNumber}`,
      title: this.readString(record, 'title') ?? `Pull request #${input.pullNumber}`
    }
  }

  /**
   * Promote a draft pull request to ready-for-review.
   *
   * GitHub exposes this lifecycle transition through GraphQL rather than the
   * REST update endpoint. Resolve the PR's global node ID first, then return the
   * same renderer-safe reference shape as every other PR mutation.
   */
  async markPullRequestReadyForReview(input: PullRequestTarget): Promise<PullRequestReference> {
    const detail = await this.request(this.pullPath(input), { method: 'GET' })
    const detailRecord = Array.isArray(detail) ? {} : detail
    if (detailRecord['draft'] !== true) return this.toReference(detailRecord)
    const pullRequestId = this.readString(detailRecord, 'node_id')
    if (!pullRequestId) {
      throw new Error(`Pull request #${input.pullNumber} has no provider node ID`)
    }

    const response = await this.runGraphql(
      'mutation MarkPullRequestReadyForReview($pullRequestId: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) { pullRequest { number title url } } }',
      { pullRequestId }
    )
    const mutation = this.readRecord(response, 'markPullRequestReadyForReview')
    const pullRequest = mutation ? this.readRecord(mutation, 'pullRequest') : null
    if (!pullRequest) {
      throw new Error(`Pull request #${input.pullNumber} was not marked ready for review`)
    }
    return {
      number: this.readNumber(pullRequest, 'number') || input.pullNumber,
      title:
        this.readString(pullRequest, 'title') ??
        this.readString(detailRecord, 'title') ??
        `Pull request #${input.pullNumber}`,
      url:
        this.readString(pullRequest, 'url') ??
        this.readString(detailRecord, 'html_url') ??
        `https://github.com/${input.owner}/${input.repo}/pull/${input.pullNumber}`
    }
  }

  /**
   * Compare two refs so the create-PR form can tell the user whether there is
   * anything to compare (GitHub's own "There isn't anything to compare" state).
   * A PR only makes sense when the head has commits the base lacks.
   */
  async comparePullRequests(input: {
    owner: string
    repo: string
    base: string
    head: string
  }): Promise<PullRequestCompare> {
    const response = await this.request(
      `${this.repoPath(input)}/compare/${encodeURIComponent(input.base)}...${encodeURIComponent(input.head)}`,
      { method: 'GET' }
    )
    const record = Array.isArray(response) ? {} : response
    const rawStatus = this.readString(record, 'status')
    const status: PullRequestCompare['status'] =
      rawStatus === 'ahead' || rawStatus === 'behind' || rawStatus === 'diverged'
        ? rawStatus
        : 'identical'
    const totalCommits = this.readNumber(record, 'total_commits')
    const rawFiles = record['files']
    const filesChanged = Array.isArray(rawFiles) ? rawFiles.length : 0
    return {
      source: 'remote',
      status,
      aheadBy: this.readNumber(record, 'ahead_by'),
      behindBy: this.readNumber(record, 'behind_by'),
      totalCommits,
      filesChanged,
      hasChanges: (status === 'ahead' || status === 'diverged') && totalCommits > 0
    }
  }

  /** Reopen a closed pull request, the same way GitHub does. */
  async reopenPullRequest(input: PullRequestTarget): Promise<PullRequestReference> {
    const response = await this.request(`${this.pullPath(input)}`, {
      method: 'PATCH',
      body: JSON.stringify({ state: 'open' })
    })
    return this.toReference(response)
  }

  /** Close an open pull request without merging, the same way GitHub does. */
  async closePullRequest(input: PullRequestTarget): Promise<PullRequestReference> {
    const response = await this.request(`${this.pullPath(input)}`, {
      method: 'PATCH',
      body: JSON.stringify({ state: 'closed' })
    })
    return this.toReference(response)
  }

  /** Update an open pull request's title and/or description, mirroring GitHub's edit. */
  async updatePullRequest(
    input: PullRequestTarget & {
      title?: string
      body?: string
    }
  ): Promise<PullRequestReference> {
    const patch: Record<string, unknown> = {}
    if (input.title !== undefined) patch['title'] = input.title
    if (input.body !== undefined) patch['body'] = input.body
    const response = await this.request(`${this.pullPath(input)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch)
    })
    return this.toReference(response)
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
    const qualifiers = ['is:pr', `repo:${input.owner}/${input.repo}`]
    if (state === 'open') qualifiers.push('is:open')
    else if (state === 'closed') qualifiers.push('is:closed')
    if (input.filter === 'authored') qualifiers.push('author:@me')
    else if (input.filter === 'assigned') qualifiers.push('assignee:@me')
    else if (input.filter === 'review-requested') qualifiers.push('review-requested:@me')
    else if (input.filter === 'involves') qualifiers.push('involves:@me')
    qualifiers.push(PULL_REQUEST_LIST_SORTS[input.sort])

    // Ask for exactly the page size. An over-fetch of one extra would move
    // `endCursor` past the first row of the next page, because the cursor is the
    // last node the search returned.
    const perPage = Math.min(Math.max(input.perPage, 1), 50)
    try {
      const data = await this.runGraphql(PULL_REQUEST_LIST_QUERY, {
        q: qualifiers.join(' '),
        first: perPage,
        after: input.cursor
      })
      const search = this.readRecord(data, 'search')
      const nodes: unknown[] = search && Array.isArray(search['nodes']) ? search['nodes'] : []
      const items = nodes.flatMap((node) => {
        const summary = this.toGraphqlSummary(node, input.owner, input.repo)
        return summary ? [summary] : []
      })
      const pageInfo = search ? this.readRecord(search, 'pageInfo') : null
      const hasMore = pageInfo?.['hasNextPage'] === true
      return {
        items,
        page: input.page,
        hasMore,
        // Only a finished page reports no cursor. GitHub returns the last node's
        // cursor on the final page too, where following it returns an empty set,
        // and a caller that walks from page one has no other way to tell that the
        // page it is about to ask for does not exist.
        nextCursor: hasMore && pageInfo ? this.readString(pageInfo, 'endCursor') : null
      }
    } catch (failure) {
      // The IPC handler tells a repository the App cannot see apart from a
      // transient outage by HTTP status, so a GraphQL access failure has to
      // arrive as the same `ProviderHttpError` the REST calls raise.
      if (failure instanceof ProviderGraphqlError) {
        if (failure.type === 'FORBIDDEN') throw new ProviderHttpError(403, failure.message)
        if (failure.type === 'NOT_FOUND') throw new ProviderHttpError(404, failure.message)
      }
      throw failure
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

  /**
   * Where GitHub files a comment of this kind.
   *
   * Both collections are repository-scoped   the pull number appears in neither
   * path   which is why the target still carries one: it keeps every comment
   * input the same shape as the one that creates them.
   */
  private commentCollectionPath(kind: PrCommentKind): string {
    return kind === 'review' ? '/pulls/comments' : '/issues/comments'
  }

  async updatePullRequestComment(input: UpdatePrCommentInput): Promise<PullRequestComment> {
    const response = await this.request(
      `${this.repoPath(input)}${this.commentCollectionPath(input.kind)}/${input.commentId}`,
      { method: 'PATCH', body: JSON.stringify({ body: input.body }) }
    )
    const comment = this.toComment(response)
    if (!comment) throw new Error('The comment was saved but could not be read back')
    return comment
  }

  async deletePullRequestComment(input: PrCommentTarget): Promise<void> {
    await this.request(
      `${this.repoPath(input)}${this.commentCollectionPath(input.kind)}/${input.commentId}`,
      { method: 'DELETE' }
    )
  }

  async updatePullRequestReviewComment(
    input: UpdatePrCommentInput
  ): Promise<PullRequestReviewComment> {
    const response = await this.request(
      `${this.repoPath(input)}${this.commentCollectionPath('review')}/${input.commentId}`,
      { method: 'PATCH', body: JSON.stringify({ body: input.body }) }
    )
    const comment = this.toReviewComment(response, {
      owner: input.owner,
      repo: input.repo,
      pullNumber: input.pullNumber
    })
    if (!comment) throw new Error('The comment was saved but could not be read back')
    return comment
  }

  async deletePullRequestReviewComment(input: PrCommentTarget): Promise<void> {
    await this.request(
      `${this.repoPath(input)}${this.commentCollectionPath('review')}/${input.commentId}`,
      { method: 'DELETE' }
    )
  }

  /**
   * Answer an inline comment inside its thread.
   *
   * The reply endpoint hangs off the comment being answered, not the pull
   * request, which is what puts the answer in that comment's thread rather than
   * starting a new one.
   */
  async replyToPullRequestReviewComment(
    input: ReplyPrReviewCommentInput
  ): Promise<PullRequestReviewComment> {
    const response = await this.request(
      `${this.pullPath(input)}/comments/${String(input.commentId)}/replies`,
      { method: 'POST', body: JSON.stringify({ body: input.body }) }
    )
    const comment = this.toReviewComment(response, input)
    if (!comment) throw new Error('The reply was posted but could not be read back')
    return comment
  }

  /**
   * Hide a comment behind GitHub's "minimised" treatment.
   *
   * GitHub exposes no REST endpoint for this, only the GraphQL mutation, and the
   * mutation addresses the comment by its global node id rather than its number.
   */
  async minimizePullRequestComment(input: MinimizePrCommentInput): Promise<void> {
    const data = await this.runGraphql(
      'mutation MinimizeComment($subjectId: ID!, $classifier: ReportedContentClassifiers!) { minimizeComment(input: { subjectId: $subjectId, classifier: $classifier }) { minimizedComment { isMinimized } } }',
      { subjectId: input.nodeId, classifier: input.reason }
    )
    const mutation = this.readRecord(data, 'minimizeComment')
    const comment = mutation ? this.readRecord(mutation, 'minimizedComment') : null
    if (!comment || comment['isMinimized'] !== true) {
      throw new Error('The provider did not hide the comment')
    }
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
      return [
        {
          id,
          ...this.toAuthor(this.readRecord(record, 'user')),
          state,
          body: this.readString(record, 'body') ?? '',
          submittedAt: this.readString(record, 'submitted_at') ?? '',
          url: `${this.pullPermalink(input)}#pullrequestreview-${String(id)}`,
          nodeId: this.readString(record, 'node_id')
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
      const comment = this.toReviewComment(item, input)
      return comment ? [comment] : []
    })
  }

  /** Build the permalink GitHub's own site uses for a pull request conversation. */
  private pullPermalink(input: PullRequestTarget): string {
    return `https://github.com/${input.owner}/${input.repo}/pull/${String(input.pullNumber)}`
  }

  /** Map an inline diff comment. GitHub's site links these with `#discussion_r<id>`. */
  private toReviewComment(
    payload: unknown,
    input: PullRequestTarget
  ): PullRequestReviewComment | null {
    if (typeof payload !== 'object' || payload === null) return null
    const record = payload as Record<string, unknown>
    const id = this.readNumber(record, 'id')
    if (id <= 0) return null
    const line = this.readNumber(record, 'line')
    const reviewId = this.readNumber(record, 'pull_request_review_id')
    const inReplyToId = this.readNumber(record, 'in_reply_to_id')
    return {
      id,
      ...this.toAuthor(this.readRecord(record, 'user')),
      body: this.readString(record, 'body') ?? '',
      path: this.readString(record, 'path') ?? '',
      line: line > 0 ? line : null,
      reviewId: reviewId > 0 ? reviewId : null,
      inReplyToId: inReplyToId > 0 ? inReplyToId : null,
      diffHunk: this.readString(record, 'diff_hunk'),
      createdAt: this.readString(record, 'created_at') ?? '',
      updatedAt: this.readString(record, 'updated_at'),
      nodeId: this.readString(record, 'node_id'),
      url: `${this.pullPermalink(input)}#discussion_r${String(id)}`
    }
  }

  /**
   * CI state for the PR head.
   *
   * GitHub exposes two independent systems   modern check runs and classic commit
   * statuses   and a repository can use either, so both are merged here.
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
        const detailsUrl = this.readString(record, 'details_url')
        const htmlUrl = this.readString(record, 'html_url')
        checks.push({
          name: this.readString(record, 'name') ?? 'check',
          status: this.toCheckStatus(this.readString(record, 'status')),
          conclusion: this.toCheckConclusion(this.readString(record, 'conclusion')),
          url: htmlUrl ?? detailsUrl,
          workflowRunId: this.workflowRunIdFromUrls(detailsUrl, htmlUrl),
          jobId: this.jobIdFromUrls(detailsUrl, htmlUrl)
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
        const targetUrl = this.readString(record, 'target_url')
        checks.push({
          name: this.readString(record, 'context') ?? 'status',
          status: state === 'pending' ? 'in_progress' : 'completed',
          conclusion:
            state === 'success' ? 'success' : state === 'pending' ? null : ('failure' as const),
          url: targetUrl,
          workflowRunId: this.workflowRunIdFromUrls(targetUrl),
          jobId: this.jobIdFromUrls(targetUrl)
        })
      }
    }

    return { state: this.rollUpChecks(checks), checks }
  }

  /** Files and patches for one commit   powers commit drill-down in the sidebar. */
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

  /**
   * Assignable repository accounts, for @-mention autocomplete in PR conversations.
   *
   * `/assignees` is deliberate: `/collaborators` requires push access and 403s for
   * a read-only contributor, while `/assignees` is readable with a read token and
   * is the same list GitHub's own assignee picker uses.
   */
  async listRepositoryMentionUsers(input: {
    owner: string
    repo: string
  }): Promise<RepositoryMentionUser[]> {
    const response = await this.request(`${this.repoPath(input)}/assignees?per_page=100`, {
      method: 'GET'
    })
    const items = Array.isArray(response) ? response : []
    const seen = new Set<string>()
    return items.flatMap((item): RepositoryMentionUser[] => {
      if (typeof item !== 'object' || item === null) return []
      const record = item as Record<string, unknown>
      const login = this.readString(record, 'login')?.trim()
      if (!login) return []
      const key = login.toLowerCase()
      if (seen.has(key)) return []
      seen.add(key)
      const name = this.readString(record, 'name')?.trim()
      return [
        {
          login,
          name: name ? name : null,
          avatarUrl: this.readString(record, 'avatar_url'),
          bot: this.readString(record, 'type') === 'Bot' || login.endsWith('[bot]')
        }
      ]
    })
  }

  async getDeploymentOverview(input: {
    owner: string
    repo: string
  }): Promise<GitHubDeploymentOverview> {
    const [runsResponse, deploymentsResponse] = await Promise.all([
      this.request(`${this.repoPath(input)}/actions/runs?per_page=20`, { method: 'GET' }),
      this.request(`${this.repoPath(input)}/deployments?per_page=12`, { method: 'GET' })
    ])
    const runsRecord = Array.isArray(runsResponse) ? {} : runsResponse
    const rawRuns = Array.isArray(runsRecord['workflow_runs']) ? runsRecord['workflow_runs'] : []
    const workflowRuns = rawRuns.flatMap((run): GitHubWorkflowRun[] => {
      const mapped = this.toWorkflowRun(run)
      return mapped ? [mapped] : []
    })
    const rawDeployments = Array.isArray(deploymentsResponse) ? deploymentsResponse : []
    const deployments = await Promise.all(
      rawDeployments.flatMap((deployment): Array<Promise<GitHubDeployment>> => {
        const mapped = this.toDeployment(deployment)
        if (!mapped) return []
        return [
          this.request(`${this.repoPath(input)}/deployments/${mapped.id}/statuses?per_page=1`, {
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
    return { workflowRuns, deployments, fetchedAt: Date.now() }
  }

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
    const base = this.repoPath(input)
    const [deploymentPayload, statusesPayload] = await Promise.all([
      this.request(`${base}/deployments/${input.deploymentId}`, { method: 'GET' }).catch(
        () => null
      ),
      this.request(`${base}/deployments/${input.deploymentId}/statuses?per_page=50`, {
        method: 'GET'
      }).catch(() => null)
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
  async getWorkflowRunDetail(input: {
    owner: string
    repo: string
    runId: number
  }): Promise<GitHubWorkflowRunDetail> {
    const base = this.repoPath(input)
    const [runPayload, jobs] = await Promise.all([
      this.request(`${base}/actions/runs/${input.runId}`, { method: 'GET' }).catch(() => null),
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
  async getDeploymentJobLog(input: {
    owner: string
    repo: string
    jobId: number
  }): Promise<GitHubDeploymentJobLog> {
    const path = `${this.repoPath(input)}/actions/jobs/${input.jobId}/logs`
    const text = await this.requestText(path)
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
  async rerunWorkflowRun(input: {
    owner: string
    repo: string
    runId: number
    mode: WorkflowRerunMode
  }): Promise<void> {
    const suffix = input.mode === 'failed' ? '/rerun-failed-jobs' : '/rerun'
    await this.request(`${this.repoPath(input)}/actions/runs/${input.runId}${suffix}`, {
      method: 'POST'
    })
  }

  /** Resolve the Actions run behind a deployment: from a status URL first, then by head sha. */
  private async resolveDeploymentRun(
    input: { owner: string; repo: string },
    deployment: GitHubDeployment,
    statuses: GitHubDeploymentStatus[]
  ): Promise<GitHubWorkflowRun | null> {
    const linkedRunId = this.runIdFromDeploymentStatuses(statuses)
    if (linkedRunId > 0) {
      const runPayload = await this.request(`${this.repoPath(input)}/actions/runs/${linkedRunId}`, {
        method: 'GET'
      }).catch(() => null)
      if (runPayload !== null && !Array.isArray(runPayload)) {
        const mapped = this.toWorkflowRun(runPayload)
        if (mapped) return mapped
      }
    }
    if (!deployment.sha) return null
    const runsPayload = await this.request(
      `${this.repoPath(input)}/actions/runs?head_sha=${encodeURIComponent(deployment.sha)}&per_page=5`,
      { method: 'GET' }
    ).catch(() => null)
    const record = Array.isArray(runsPayload) ? {} : (runsPayload ?? {})
    const rawRuns = Array.isArray(record['workflow_runs']) ? record['workflow_runs'] : []
    for (const entry of rawRuns) {
      const mapped = this.toWorkflowRun(entry)
      if (mapped) return mapped
    }
    return null
  }

  /** Deployment statuses created by Actions carry the run id in their log/env URLs. */
  private runIdFromDeploymentStatuses(statuses: GitHubDeploymentStatus[]): number {
    for (const status of statuses) {
      const id = this.workflowRunIdFromUrls(status.logUrl, status.environmentUrl)
      if (id !== null) return id
    }
    return 0
  }

  /** Extract an Actions workflow-run id without adding another provider request. */
  private workflowRunIdFromUrls(...urls: Array<string | null>): number | null {
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
  private jobIdFromUrls(...urls: Array<string | null>): number | null {
    for (const url of urls) {
      if (!url) continue
      const match = /\/job\/(\d+)/u.exec(url)
      if (!match) continue
      const id = Number.parseInt(match[1] ?? '', 10)
      if (Number.isSafeInteger(id) && id > 0) return id
    }
    return null
  }

  private async getRunJobs(
    input: { owner: string; repo: string },
    runId: number
  ): Promise<GitHubDeploymentJob[]> {
    const response = await this.request(
      `${this.repoPath(input)}/actions/runs/${runId}/jobs?per_page=50`,
      { method: 'GET' }
    ).catch(() => null)
    const record = Array.isArray(response) ? {} : (response ?? {})
    const rawJobs = Array.isArray(record['jobs']) ? record['jobs'] : []
    return rawJobs.flatMap((job): GitHubDeploymentJob[] => {
      const mapped = this.toDeploymentJob(job)
      return mapped ? [mapped] : []
    })
  }

  /** Download redirected raw content while using GitHub's required JSON media type. */
  private async requestText(path: string): Promise<string> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PROVIDER_FETCH_TIMEOUT_MS)
    const init: RequestInit = { method: 'GET' }
    try {
      let token = this.token
      let response = await this.fetch(path, init, token, controller.signal)
      if (response.status === 401 && this.refreshAccessToken) {
        const refreshedToken = await this.refreshAccessToken()
        if (refreshedToken && refreshedToken !== token) {
          token = refreshedToken
          response = await this.fetch(path, init, token, controller.signal)
        }
      }
      // A GitHub App user token can deliberately hide a public repository with
      // 404 when the app is not installed there. Public GET endpoints remain
      // readable without credentials, so retry those reads anonymously. Never
      // do this for mutations or a configured self-hosted provider.
      if (
        response.status === 404 &&
        (init.method ?? 'GET').toUpperCase() === 'GET' &&
        this.baseUrl === GITHUB_API_BASE_URL
      ) {
        const anonymousResponse = await this.fetch(path, init, null, controller.signal)
        // Only prefer the anonymous retry when it actually succeeds or still reports
        // "not found". An anonymous 403 just means the resource requires auth (e.g. a
        // private repo's job logs)   that must not clobber the original 404, which is
        // usually the accurate "not available yet" status (e.g. logs not generated yet).
        if (anonymousResponse.ok || anonymousResponse.status === 404) {
          response = anonymousResponse
        }
      }
      if (!response.ok) {
        const message = await this.readErrorMessage(response)
        throw new ProviderHttpError(response.status, message)
      }
      return await response.text()
    } catch (failure) {
      if (failure instanceof Error && failure.name === 'AbortError') {
        throw new Error('Provider request timed out', { cause: failure })
      }
      throw failure
    } finally {
      clearTimeout(timer)
    }
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
      let token = this.token
      let response = await this.fetch(path, init, token, controller.signal)
      if (response.status === 401 && this.refreshAccessToken) {
        const refreshedToken = await this.refreshAccessToken()
        if (refreshedToken && refreshedToken !== token) {
          token = refreshedToken
          response = await this.fetch(path, init, token, controller.signal)
        }
      }
      if (
        response.status === 404 &&
        (init.method ?? 'GET').toUpperCase() === 'GET' &&
        this.baseUrl === GITHUB_API_BASE_URL
      ) {
        const anonymousResponse = await this.fetch(path, init, null, controller.signal)
        // Only prefer the anonymous retry when it actually succeeds or still reports
        // "not found". An anonymous 403 just means the resource requires auth (e.g. a
        // private repo's job logs)   that must not clobber the original 404, which is
        // usually the accurate "not available yet" status (e.g. logs not generated yet).
        if (anonymousResponse.ok || anonymousResponse.status === 404) {
          response = anonymousResponse
        }
      }
      if (!response.ok) {
        const message = await this.readErrorMessage(response)
        throw new ProviderHttpError(response.status, message)
      }
      if (response.status === 204) return {}
      // A re-run answers 201 with an empty body, which `json()` cannot parse; a
      // body-less success is a value-less success, not a malformed response.
      const text = await response.text()
      if (!text.trim()) return {}
      return JSON.parse(text) as Record<string, unknown> | unknown[]
    } catch (failure) {
      if (failure instanceof Error && failure.name === 'AbortError') {
        throw new Error('Provider request timed out', { cause: failure })
      }
      throw failure
    } finally {
      clearTimeout(timer)
    }
  }

  private fetch(
    path: string,
    init: RequestInit,
    token: string | null,
    signal: AbortSignal
  ): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Accept: GITHUB_API_ACCEPT,
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
        'User-Agent': USER_AGENT,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init.headers
      },
      signal
    })
  }

  /**
   * Read a provider error body's message without touching headers. GitHub wraps
   * the actionable reason in `errors[0].message` (e.g. "A pull request already
   * exists for …") while the top-level `message` stays the generic
   * "Validation Failed", so the specific reason is preferred when present.
   */
  private async readErrorMessage(response: Response): Promise<string> {
    try {
      const body = (await response.json()) as Record<string, unknown>
      if (Array.isArray(body['errors'])) {
        for (const entry of body['errors']) {
          if (typeof entry !== 'object' || entry === null) continue
          const detail = (entry as Record<string, unknown>)['message']
          if (typeof detail === 'string' && detail.trim()) return detail.slice(0, 500)
        }
      }
      if (typeof body['message'] === 'string') return body['message'].slice(0, 500)
    } catch {
      // Non-JSON error body   fall through to the status-only message.
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

  private toWorkflowRun(payload: unknown): GitHubWorkflowRun | null {
    if (typeof payload !== 'object' || payload === null) return null
    const record = payload as Record<string, unknown>
    const id = this.readNumber(record, 'id')
    if (id <= 0) return null
    const actor = this.readRecord(record, 'actor')
    const rawStatus = this.readString(record, 'status')
    const status =
      rawStatus === 'queued' || rawStatus === 'in_progress' || rawStatus === 'completed'
        ? rawStatus
        : 'unknown'
    return {
      id,
      name: this.readString(record, 'name') ?? 'Workflow',
      displayTitle: this.readString(record, 'display_title') ?? 'Workflow run',
      runNumber: this.readNumber(record, 'run_number'),
      event: this.readString(record, 'event') ?? '',
      status,
      conclusion: this.readString(record, 'conclusion'),
      branch: this.readString(record, 'head_branch') ?? '',
      headSha: this.readString(record, 'head_sha') ?? '',
      url: this.readString(record, 'html_url') ?? '',
      actorLogin: actor ? (this.readString(actor, 'login') ?? '') : '',
      createdAt: this.readString(record, 'created_at') ?? '',
      updatedAt: this.readString(record, 'updated_at') ?? ''
    }
  }

  private toDeployment(payload: unknown): GitHubDeployment | null {
    if (typeof payload !== 'object' || payload === null) return null
    const record = payload as Record<string, unknown>
    const id = this.readNumber(record, 'id')
    if (id <= 0) return null
    return {
      id,
      environment: this.readString(record, 'environment') ?? 'Deployment',
      description: this.readString(record, 'description') ?? '',
      ref: this.readString(record, 'ref') ?? '',
      sha: this.readString(record, 'sha') ?? '',
      createdAt: this.readString(record, 'created_at') ?? '',
      updatedAt: this.readString(record, 'updated_at') ?? '',
      latestStatus: null
    }
  }

  private toDeploymentStatus(payload: unknown): GitHubDeploymentStatus | null {
    if (typeof payload !== 'object' || payload === null) return null
    const record = payload as Record<string, unknown>
    const state = this.readString(record, 'state')
    if (!state) return null
    return {
      state,
      description: this.readString(record, 'description') ?? '',
      environmentUrl: this.readString(record, 'environment_url'),
      logUrl: this.readString(record, 'log_url'),
      createdAt: this.readString(record, 'created_at') ?? ''
    }
  }

  private toDeploymentJob(payload: unknown): GitHubDeploymentJob | null {
    if (typeof payload !== 'object' || payload === null) return null
    const record = payload as Record<string, unknown>
    const id = this.readNumber(record, 'id')
    if (id <= 0) return null
    const rawSteps = Array.isArray(record['steps']) ? record['steps'] : []
    const steps = rawSteps.flatMap((step): GitHubDeploymentJobStep[] => {
      const mapped = this.toDeploymentJobStep(step)
      return mapped ? [mapped] : []
    })
    return {
      id,
      name: this.readString(record, 'name') ?? 'Job',
      status: this.readString(record, 'status') ?? 'unknown',
      conclusion: this.readString(record, 'conclusion'),
      startedAt: this.readString(record, 'started_at') ?? '',
      completedAt: this.readString(record, 'completed_at'),
      url: this.readString(record, 'html_url') ?? '',
      steps
    }
  }

  private toDeploymentJobStep(payload: unknown): GitHubDeploymentJobStep | null {
    if (typeof payload !== 'object' || payload === null) return null
    const record = payload as Record<string, unknown>
    const number = this.readNumber(record, 'number')
    if (number <= 0) return null
    const rawStatus = this.readString(record, 'status')
    const status =
      rawStatus === 'queued' || rawStatus === 'in_progress' || rawStatus === 'completed'
        ? rawStatus
        : 'unknown'
    return {
      number,
      name: this.readString(record, 'name') ?? 'Step',
      status,
      conclusion: this.readString(record, 'conclusion')
    }
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

  /** Failure wins over pending, pending over success   the same order GitHub shows. */
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

  /**
   * Run one GraphQL query or mutation and return its `data` record.
   *
   * Some GitHub operations exist only on GraphQL, so the transport and its error
   * unwrapping live here once rather than in each caller. The unwrapping matters:
   * GraphQL answers HTTP 200 with an `errors` array when a request is rejected,
   * so without this a failure would read as success.
   */
  private async runGraphql(
    query: string,
    variables: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const response = await this.request('/graphql', {
      method: 'POST',
      body: JSON.stringify({ query, variables })
    })
    const responseRecord = Array.isArray(response) ? {} : response
    const errors = responseRecord['errors']
    if (Array.isArray(errors)) {
      const first = errors.find(
        (entry): entry is Record<string, unknown> =>
          typeof entry === 'object' && entry !== null && !Array.isArray(entry)
      )
      const message = first ? this.readString(first, 'message') : null
      const type = first ? this.readString(first, 'type') : null
      throw new ProviderGraphqlError(
        message?.slice(0, 500) ?? 'The provider rejected the request',
        type
      )
    }
    return this.readRecord(responseRecord, 'data') ?? {}
  }

  /**
   * Map one GraphQL search node to the renderer-safe summary, or null when it is
   * not a pull request (an issue search returns both kinds of node) or has no
   * usable number.
   */
  private toGraphqlSummary(
    payload: unknown,
    owner: string,
    repo: string
  ): PullRequestSummary | null {
    if (typeof payload !== 'object' || payload === null) return null
    const record = payload as Record<string, unknown>
    if (this.readString(record, '__typename') !== 'PullRequest') return null
    const number = this.readNumber(record, 'number')
    if (number <= 0) return null
    const author = this.readRecord(record, 'author')
    const login = author ? (this.readString(author, 'login') ?? 'unknown') : 'unknown'
    const rawState = this.readString(record, 'state')
    const state: PullRequestSummary['state'] =
      rawState === 'MERGED' ? 'merged' : rawState === 'CLOSED' ? 'closed' : 'open'
    const checks = this.readChecksRollup(record)
    const mergeStateStatus = this.readString(record, 'mergeStateStatus')
    return {
      number,
      title: this.readString(record, 'title') ?? `Pull request #${number}`,
      url: this.readString(record, 'url') ?? `https://github.com/${owner}/${repo}/pull/${number}`,
      state,
      draft: record['isDraft'] === true,
      authorLogin: login,
      authorAvatarUrl: author ? this.readString(author, 'avatarUrl') : null,
      authorIsBot: login.endsWith('[bot]'),
      headRef: this.readString(record, 'headRefName') ?? '',
      baseRef: this.readString(record, 'baseRefName') ?? '',
      createdAt: this.readString(record, 'createdAt') ?? '',
      updatedAt: this.readString(record, 'updatedAt') ?? '',
      comments: this.readNumber(record, 'totalCommentsCount'),
      labels: this.readLabels(record),
      ...(checks ? { checks } : {}),
      mergeable: this.readMergeable(record),
      mergeableState: mergeStateStatus ? mergeStateStatus.toLowerCase() : null
    }
  }

  /** GitHub's tri-state mergeability as a listing reports it; UNKNOWN stays null. */
  private readMergeable(record: Record<string, unknown>): boolean | null {
    const value = this.readString(record, 'mergeable')
    if (value === 'MERGEABLE') return true
    if (value === 'CONFLICTING') return false
    return null
  }

  /** Labels in GitHub's own order, dropping entries a chip cannot draw. */
  private readLabels(record: Record<string, unknown>): PullRequestLabel[] {
    const labels = this.readRecord(record, 'labels')
    const nodes: unknown[] = labels && Array.isArray(labels['nodes']) ? labels['nodes'] : []
    return nodes.flatMap((node): PullRequestLabel[] => {
      if (typeof node !== 'object' || node === null) return []
      const entry = node as Record<string, unknown>
      const name = this.readString(entry, 'name')
      if (!name) return []
      return [{ name, color: this.readString(entry, 'color') ?? '' }]
    })
  }

  /**
   * Roll up the head commit's checks, or undefined when the commit carries no
   * status rollup at all.
   *
   * Undefined rather than a `none` state on purpose: the list draws no check
   * signal for a repository that never ran anything, while `none` means the
   * rollup exists and is empty.
   */
  private readChecksRollup(record: Record<string, unknown>): PullRequestChecksRollup | undefined {
    const commits = this.readRecord(record, 'commits')
    const commitNodes: unknown[] =
      commits && Array.isArray(commits['nodes']) ? commits['nodes'] : []
    const headNode = commitNodes[0]
    if (typeof headNode !== 'object' || headNode === null) return undefined
    const commit = this.readRecord(headNode as Record<string, unknown>, 'commit')
    const rollup = commit ? this.readRecord(commit, 'statusCheckRollup') : null
    if (!rollup) return undefined
    const rawState = this.readString(rollup, 'state')
    const state: PullRequestChecksRollup['state'] =
      rawState === 'SUCCESS'
        ? 'success'
        : rawState === 'FAILURE' || rawState === 'ERROR'
          ? 'failure'
          : rawState === 'PENDING' || rawState === 'EXPECTED'
            ? 'pending'
            : 'none'
    const contexts = this.readRecord(rollup, 'contexts')
    const contextNodes: unknown[] =
      contexts && Array.isArray(contexts['nodes']) ? contexts['nodes'] : []
    let passed = 0
    for (const context of contextNodes) {
      if (typeof context !== 'object' || context === null) continue
      const entry = context as Record<string, unknown>
      const typename = this.readString(entry, '__typename')
      const succeeded =
        (typename === 'CheckRun' &&
          this.readString(entry, 'status') === 'COMPLETED' &&
          this.readString(entry, 'conclusion') === 'SUCCESS') ||
        (typename === 'StatusContext' && this.readString(entry, 'state') === 'SUCCESS')
      if (succeeded) passed += 1
    }
    return {
      state,
      passed,
      total: contexts ? this.readNumber(contexts, 'totalCount') : 0
    }
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
    const mergeableRaw = record['mergeable']
    const mergeableStateRaw = this.readString(record, 'mergeable_state')
    const state = merged ? 'merged' : rawState === 'closed' ? 'closed' : 'open'
    return {
      number,
      title: this.readString(record, 'title') ?? `Pull request #${number}`,
      url:
        this.readString(record, 'html_url') ?? `https://github.com/${owner}/${repo}/pull/${number}`,
      state,
      draft: record['draft'] === true,
      ...this.toAuthor(user),
      headRef: head ? (this.readString(head, 'ref') ?? '') : '',
      baseRef: base ? (this.readString(base, 'ref') ?? '') : '',
      createdAt: this.readString(record, 'created_at') ?? '',
      updatedAt: this.readString(record, 'updated_at') ?? '',
      comments: this.readNumber(record, 'comments'),
      mergeable: typeof mergeableRaw === 'boolean' ? mergeableRaw : null,
      mergeableState: mergeableStateRaw || null
    }
  }

  private toComment(payload: unknown): PullRequestComment | null {
    if (typeof payload !== 'object' || payload === null) return null
    const record = payload as Record<string, unknown>
    const id = this.readNumber(record, 'id')
    if (id <= 0) return null
    return {
      id,
      ...this.toAuthor(this.readRecord(record, 'user')),
      body: this.readString(record, 'body') ?? '',
      createdAt: this.readString(record, 'created_at') ?? '',
      updatedAt: this.readString(record, 'updated_at'),
      nodeId: this.readString(record, 'node_id'),
      url: this.readString(record, 'html_url') ?? ''
    }
  }

  /**
   * The author fields every conversation row renders.
   *
   * The declared `avatar_url` is what makes an app account's picture correct.
   * Asking the avatar CDN for a login alone answers with GitHub's meaningless
   * generated identicon for a `[bot]` account, while this URL is the picture the
   * app itself published   the one github.com shows next to the same comment.
   */
  private toAuthor(user: Record<string, unknown> | null): {
    authorLogin: string
    authorAvatarUrl: string | null
    authorIsBot: boolean
  } {
    if (!user) return { authorLogin: 'unknown', authorAvatarUrl: null, authorIsBot: false }
    const login = this.readString(user, 'login') ?? 'unknown'
    return {
      authorLogin: login,
      authorAvatarUrl: this.readString(user, 'avatar_url'),
      // `type` is the authoritative signal; the `[bot]` suffix is a fallback for
      // payloads that omit the user object's type.
      authorIsBot: this.readString(user, 'type') === 'Bot' || login.endsWith('[bot]')
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
