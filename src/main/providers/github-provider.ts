import type {
  BranchDeletionOutcome,
  BranchDeletionState,
  GitHubDeployment,
  GitHubDeploymentDetail,
  GitHubDeploymentJob,
  GitHubDeploymentJobLog,
  GitHubDeploymentJobStep,
  GitHubDeploymentPage,
  GitHubDeploymentStatus,
  GitRepositoryIdentity,
  GitHubWorkflowRun,
  GitHubWorkflowRunDetail,
  GitHubWorkflowRunPage,
  IssueDetail,
  IssuePage,
  IssueReference,
  IssueRelationshipItem,
  IssueRelationships,
  IssueStateReason,
  IssueSummary,
  IssueTimelineEvent,
  IssueTimelineEventKind,
  IssueTimelineReference,
  PrAuthorAssociation,
  PrCommentKind,
  PrDraft,
  PrListSort,
  PrReactionActor,
  PrReactionGroup,
  PrReactionMap,
  PullRequestComment,
  PullRequestCommit,
  PullRequestCheck,
  PullRequestChecks,
  PullRequestChecksRollup,
  PullRequestCompare,
  PullRequestDetail,
  PullRequestFile,
  PullRequestLabel,
  PullRequestMilestone,
  PullRequestReview,
  PullRequestReviewComment,
  PullRequestReviewThread,
  PullRequestPage,
  PullRequestReference,
  PullRequestSummary,
  RepositoryMentionUser,
  SetPrReactionInput,
  WorkflowRerunMode,
  WorkflowRunFilter
} from '../../lib/types'
import type {
  IssueLinkInput,
  SearchIssueCandidatesInput,
  SearchPullRequestsInput
} from '../git/git-provider.interface'
import { capJobLogText } from '../../lib/github-job-log'
import { isReactionContent } from '../../lib/github-reactions'
import type {
  BranchTarget,
  CreateIssueCommentInput,
  CreateIssueInput,
  CreatePrCommentInput,
  CreatePrReviewInput,
  GitProvider,
  IssueCommentTarget,
  IssueTarget,
  ListIssuePageInput,
  ListPullRequestPageInput,
  ListPullRequestsInput,
  ListWorkflowRunPageInput,
  ListDeploymentPageInput,
  MergePullRequestInput,
  MinimizePrCommentInput,
  PrCommentTarget,
  PullRequestTarget,
  ReplyPrReviewCommentInput,
  ResolvePrReviewThreadInput,
  SetIssueStateInput,
  UpdateIssueCommentInput,
  UpdateIssueInput,
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

/**
 * How many subjects one batched reaction read addresses.
 *
 * `nodes(ids:)` accepts at most 100, and a conversation longer than that is
 * read in consecutive requests rather than by dropping the tail.
 */
const REACTION_BATCH_SIZE = 100

/**
 * How many reactors one reaction group carries.
 *
 * The count is the number the chip draws; this list is only what a hover can
 * name, so it is capped rather than paid for in full on a popular comment.
 */
const REACTION_ACTOR_LIMIT = 10

/**
 * The reaction fields, selected identically everywhere a subject is read.
 *
 * `reactors.nodes` is a union (`User`, `Bot`, `Mannequin`, `Organization`), so
 * each member is asked for the two fields the app draws. A Mannequin has no
 * picture, which is why the picture is read as nullable rather than assumed.
 */
const REACTION_GROUP_SELECTION = `reactionGroups {
        content
        viewerHasReacted
        reactors(first: ${String(REACTION_ACTOR_LIMIT)}) {
          totalCount
          nodes {
            __typename
            ... on User { login avatarUrl }
            ... on Bot { login avatarUrl }
            ... on Mannequin { login avatarUrl }
            ... on Organization { login avatarUrl }
          }
        }
      }`

/** The batched reaction read: every subject's groups, addressed by node id. */
const REACTION_GROUPS_QUERY = `query ReactionGroups($ids: [ID!]!) { nodes(ids: $ids) { id ... on Reactable { ${REACTION_GROUP_SELECTION} } } }`

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
        assignees(first: 10) {
          nodes {
            login
            name
            avatarUrl
          }
        }
        milestone {
          number
          title
          state
          description
          dueOn
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
 * One GraphQL search for a page of issues.
 *
 * Search rather than the repository's `issues` connection, for the same reason
 * the pull request listing uses it: `author:@me` and `mentions:@me` are questions
 * only the search index can answer. `type: ISSUE` returns both kinds of node, so
 * the `is:issue` qualifier is what keeps pull requests out of the answer, and the
 * `... on Issue` fragment is what keeps a stray `PullRequest` node from being read
 * as an issue.
 */
/**
 * How many candidates the relationship picker offers.
 *
 * Smaller than a listing page on purpose: a picker is a choice from what is in front
 * of the reader, and the search field is how they reach anything further.
 */
const ISSUE_CANDIDATE_LIMIT = 20

/**
 * How many pull requests the panel's find offers.
 *
 * Bounded like the issue picker, and for the same reason: a find is one item out of
 * a list the reader is already looking at, and typing is how they narrow it.
 */
const PR_SEARCH_LIMIT = 20

/**
 * The relationship mutations.
 *
 * Every one of them takes the two issues by GraphQL node id and answers with the
 * updated issue, which is why one document shape serves all four. Their input fields
 * were read off the schema rather than guessed: `addSubIssue` takes
 * `issueId`/`subIssueId`, and the dependency pair takes `issueId`/`blockingIssueId`.
 */
const ADD_SUB_ISSUE_MUTATION = `mutation AddSubIssue($issueId: ID!, $subIssueId: ID!) {
  addSubIssue(input: { issueId: $issueId, subIssueId: $subIssueId }) {
    issue {
      id
    }
  }
}`

const REMOVE_SUB_ISSUE_MUTATION = `mutation RemoveSubIssue($issueId: ID!, $subIssueId: ID!) {
  removeSubIssue(input: { issueId: $issueId, subIssueId: $subIssueId }) {
    issue {
      id
    }
  }
}`

const ADD_BLOCKED_BY_MUTATION = `mutation AddBlockedBy($issueId: ID!, $blockingIssueId: ID!) {
  addBlockedBy(input: { issueId: $issueId, blockingIssueId: $blockingIssueId }) {
    issue {
      id
    }
  }
}`

const REMOVE_BLOCKED_BY_MUTATION = `mutation RemoveBlockedBy($issueId: ID!, $blockingIssueId: ID!) {
  removeBlockedBy(input: { issueId: $issueId, blockingIssueId: $blockingIssueId }) {
    issue {
      id
    }
  }
}`

/**
 * One GraphQL search for a page of issues.
 *
 * Search rather than the repository's `issues` connection for the same reason the
 * pull request listing uses it: only the search index can answer the viewer
 * relationships and the orderings the listing offers. The `id` it selects is the
 * GraphQL node id, which is the only handle the relationship mutations accept, so a
 * candidate the picker offers already carries what the write needs. Punctuation here
 * is GraphQL's, not this file's: comments inside the document have to be `#`.
 */
const ISSUE_LIST_QUERY = `query IssueList($q: String!, $first: Int!, $after: String) {
  search(query: $q, type: ISSUE, first: $first, after: $after) {
    pageInfo {
      hasNextPage
      endCursor
    }
    nodes {
      __typename
      ... on Issue {
        number
        title
        url
        state
        stateReason
        createdAt
        updatedAt
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
        assignees(first: 10) {
          nodes {
            login
            name
            avatarUrl
          }
        }
        milestone {
          number
          title
          state
          description
          dueOn
        }
        id
        comments {
          totalCount
        }
      }
    }
  }
}`

/**
 * The `sort:` qualifier for each ordering the listings offer.
 *
 * A record keyed by the union rather than a chain of comparisons, so adding an
 * ordering to `PrListSort` without giving it a qualifier here fails to compile
 * instead of silently listing by something else. The same table orders issues and
 * pull requests, which is why `IssueListSort` is an alias of `PrListSort`.
 */
const LIST_SORTS: Record<PrListSort, string> = {
  updated: 'sort:updated-desc',
  created: 'sort:created-desc',
  'comments-desc': 'sort:comments-desc',
  'updated-asc': 'sort:updated-asc',
  'created-asc': 'sort:created-asc',
  'comments-asc': 'sort:comments-asc'
}

/**
 * The `status` qualifier each workflow run filter asks GitHub for.
 *
 * GitHub's runs endpoint takes claims and conclusions in one parameter, so a
 * settled filter names its conclusion and `all` sends nothing at all.
 */
const WORKFLOW_RUN_FILTER_STATUS: Record<WorkflowRunFilter, string | null> = {
  all: null,
  failed: 'failure',
  succeeded: 'success'
}

/**
 * A branch name as a URL path, keeping its slashes as separators.
 *
 * A branch is spelled in a URL the way it is spelled in git (`feature/thing`),
 * so each segment is encoded on its own: encoding the whole name turns the
 * separators into `%2F`, which GitHub's router does not read back as a branch.
 */
function branchPath(input: { branch: string }): string {
  return input.branch.split('/').map(encodeURIComponent).join('/')
}

/**
 * Whether GitHub refused a branch delete because the ref is already gone.
 *
 * The refusal is a 422 carrying "Reference does not exist", which is the same
 * status a protected branch refusal uses, so the message is what separates a
 * branch that was already deleted from a write that was denied.
 */
function isMissingRefRefusal(failure: ProviderHttpError): boolean {
  return failure.status === 422 && /Reference does not exist/iu.test(failure.message)
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

  /**
   * What a branch is as far as deleting it goes.
   *
   * The branch endpoint reports protection beside the commit it points at, and a
   * branch GitHub cannot find comes back 404. The three answers are kept apart
   * rather than collapsed into "may delete": a missing branch reading as
   * deletable is exactly the race that offers an action which cannot land.
   */
  async readBranchDeletionState(input: BranchTarget): Promise<BranchDeletionState> {
    try {
      const response = await this.request(`${this.repoPath(input)}/branches/${branchPath(input)}`, {
        method: 'GET'
      })
      const record = Array.isArray(response) ? {} : response
      return record['protected'] === true ? 'protected' : 'deletable'
    } catch (failure) {
      if (failure instanceof ProviderHttpError && failure.status === 404) return 'missing'
      throw failure
    }
  }

  /**
   * Delete a branch from the repository.
   *
   * A branch that is already gone reports `missing`: GitHub answers a delete for
   * an absent ref with a 422 "Reference does not exist", and that is the outcome
   * the caller asked for, not a failure to report. A protected branch answers
   * with a different 422, which stays an error, so the refusal is never mistaken
   * for success.
   */
  async deleteBranch(input: BranchTarget): Promise<BranchDeletionOutcome> {
    try {
      await this.request(`${this.repoPath(input)}/git/refs/heads/${branchPath(input)}`, {
        method: 'DELETE'
      })
      return 'deleted'
    } catch (failure) {
      if (failure instanceof ProviderHttpError && isMissingRefRefusal(failure)) return 'missing'
      throw failure
    }
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
    qualifiers.push(LIST_SORTS[input.sort])

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
      if (items.length > 0) {
        const stacks = await this.readPullRequestStacks(input).catch(
          () => new Map<number, PullRequestSummary[]>()
        )
        for (const item of items) item.stackCount = stacks.get(item.number)?.length ?? 0
      }
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

  /**
   * Search the repository's pull requests for the panel's find.
   *
   * Shares `PULL_REQUEST_LIST_QUERY` and its mapper with the listing, so a result is
   * a row the PR list itself would have drawn and opening it needs no second read.
   * Stack counts are left unset on purpose: a find is a jump to one pull request, and
   * the reader reads the stack when it opens.
   */
  async searchPullRequests(input: SearchPullRequestsInput): Promise<PullRequestSummary[]> {
    const qualifiers = ['is:pr', `repo:${input.owner}/${input.repo}`]
    if (input.state === 'open') qualifiers.push('is:open')
    else if (input.state === 'closed') qualifiers.push('is:closed')
    const text = input.text.trim()
    if (text) qualifiers.push(text)
    qualifiers.push(LIST_SORTS['updated'])
    try {
      const data = await this.runGraphql(PULL_REQUEST_LIST_QUERY, {
        q: qualifiers.join(' '),
        first: PR_SEARCH_LIMIT,
        after: null
      })
      const search = this.readRecord(data, 'search')
      const nodes: unknown[] = search && Array.isArray(search['nodes']) ? search['nodes'] : []
      return nodes.flatMap((node) => {
        const summary = this.toGraphqlSummary(node, input.owner, input.repo)
        return summary ? [summary] : []
      })
    } catch (failure) {
      // Same translation as the listing: the handler tells a repository this App
      // cannot see apart from a transient outage by HTTP status.
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
      authorAssociation: this.toAuthorAssociation(record),
      body: this.readString(record, 'body') ?? '',
      nodeId: this.readString(record, 'node_id'),
      mergeable: typeof mergeableRaw === 'boolean' ? mergeableRaw : null,
      merged: record['merged'] === true,
      additions: this.readNumber(record, 'additions'),
      deletions: this.readNumber(record, 'deletions'),
      changedFiles: this.readNumber(record, 'changed_files'),
      commitCount: this.readNumber(record, 'commits')
    }
  }

  async listIssuePage(input: ListIssuePageInput): Promise<IssuePage> {
    const state = input.state ?? 'open'
    const qualifiers = ['is:issue', `repo:${input.owner}/${input.repo}`]
    if (state === 'open') qualifiers.push('is:open')
    else if (state === 'closed') qualifiers.push('is:closed')
    if (input.filter === 'created') qualifiers.push('author:@me')
    else if (input.filter === 'assigned') qualifiers.push('assignee:@me')
    else if (input.filter === 'mentioned') qualifiers.push('mentions:@me')
    else if (input.filter === 'involves') qualifiers.push('involves:@me')
    qualifiers.push(LIST_SORTS[input.sort])

    // Ask for exactly the page size. An over-fetch of one extra would move
    // `endCursor` past the first row of the next page, because the cursor is the
    // last node the search returned.
    const perPage = Math.min(Math.max(input.perPage, 1), 50)
    try {
      const data = await this.runGraphql(ISSUE_LIST_QUERY, {
        q: qualifiers.join(' '),
        first: perPage,
        after: input.cursor
      })
      const search = this.readRecord(data, 'search')
      const nodes: unknown[] = search && Array.isArray(search['nodes']) ? search['nodes'] : []
      const items = nodes.flatMap((node) => {
        const summary = this.toGraphqlIssueSummary(node, input.owner, input.repo)
        return summary ? [summary] : []
      })
      const pageInfo = search ? this.readRecord(search, 'pageInfo') : null
      const hasMore = pageInfo?.['hasNextPage'] === true
      return {
        items,
        page: input.page,
        hasMore,
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

  async getIssue(input: IssueTarget): Promise<IssueDetail> {
    const response = await this.request(this.issuePath(input), { method: 'GET' })
    const record = Array.isArray(response) ? {} : response
    // A pull request is an issue carrying a `pull_request` link. The GitHub
    // issues endpoints answer with both kinds, so the issue reader refuses the
    // other one rather than opening onto something it cannot represent.
    if (this.readRecord(record, 'pull_request')) {
      throw new Error(`#${input.issueNumber} is a pull request, not an issue`)
    }
    const summary = this.toIssueSummary(record, input.owner, input.repo)
    if (!summary) throw new Error(`Issue #${input.issueNumber} could not be read`)
    return {
      ...summary,
      body: this.readString(record, 'body') ?? '',
      nodeId: this.readString(record, 'node_id'),
      authorAssociation: this.toAuthorAssociation(record),
      closedAt: this.readString(record, 'closed_at')
    }
  }

  async createIssue(input: CreateIssueInput): Promise<IssueReference> {
    const payload: Record<string, unknown> = { title: input.title }
    if (input.body !== undefined) payload['body'] = input.body
    if (input.labels && input.labels.length > 0) payload['labels'] = input.labels
    if (input.assignees && input.assignees.length > 0) payload['assignees'] = input.assignees
    const response = await this.request(`${this.repoPath(input)}/issues`, {
      method: 'POST',
      body: JSON.stringify(payload)
    })
    const reference = this.toIssueReference(response, input)
    if (!reference) throw new Error('The issue was created but could not be read back')
    return reference
  }

  async updateIssue(input: UpdateIssueInput): Promise<IssueReference> {
    const payload: Record<string, unknown> = {}
    if (input.title !== undefined) payload['title'] = input.title
    if (input.body !== undefined) payload['body'] = input.body
    const response = await this.request(this.issuePath(input), {
      method: 'PATCH',
      body: JSON.stringify(payload)
    })
    const reference = this.toIssueReference(response, input)
    if (!reference) throw new Error('The issue was saved but could not be read back')
    return reference
  }

  async setIssueState(input: SetIssueStateInput): Promise<IssueReference> {
    const payload: Record<string, unknown> = { state: input.state }
    // GitHub records why an issue was closed, and clears the reason itself on
    // reopen, so a reason is only ever sent with a close.
    if (input.state === 'closed' && input.stateReason) payload['state_reason'] = input.stateReason
    const response = await this.request(this.issuePath(input), {
      method: 'PATCH',
      body: JSON.stringify(payload)
    })
    const reference = this.toIssueReference(response, input)
    if (!reference) throw new Error('The issue state change was not confirmed')
    return reference
  }

  async listIssueComments(input: IssueTarget): Promise<PullRequestComment[]> {
    const response = await this.request(`${this.issuePath(input)}/comments?per_page=100`, {
      method: 'GET'
    })
    const items = Array.isArray(response) ? response : []
    return items.flatMap((item): PullRequestComment[] => {
      const comment = this.toComment(item)
      return comment ? [comment] : []
    })
  }

  /**
   * One conversation's history, from the timeline endpoint.
   *
   * A hundred events is one request, which covers a conversation of any ordinary
   * length. The endpoint is `/issues/{number}/timeline` for a pull request too,
   * because a pull request is an issue to this API and a repository's numbers are
   * one space, so the issue reader and the pull request conversation read the same
   * way through the same mapper.
   *
   * The events another part of the reader already draws are dropped here rather
   * than filtered by the renderer: `commented` because the comments arrive from
   * `listIssueComments` with the fields a comment row draws, `reviewed` because the
   * bundle's reviews carry the body and the inline threads the event does not, and
   * `committed` because a commit arrives once per commit (123 of them across a
   * dozen ordinary pull requests) and would drown the story the history tells. An
   * event type this provider does not map is dropped too, so an event GitHub adds
   * later is simply absent rather than rendered as a row saying nothing.
   */
  async listIssueTimeline(input: IssueTarget): Promise<IssueTimelineEvent[]> {
    const response = await this.readCollection(`${this.issuePath(input)}/timeline?per_page=100`)
    const items = Array.isArray(response) ? response : []
    const events = items.flatMap((item): IssueTimelineEvent[] => {
      const event = this.toTimelineEvent(item)
      return event ? [event] : []
    })
    return this.dropClosedBesideMerge(events)
  }

  /**
   * Drop the `closed` event that a merge carries.
   *
   * A merged pull request reports `merged` and `closed` with the identical
   * `created_at`, and github.com draws one row for the pair. Removing the close it
   * shares with the merge leaves the merge as the single row the site shows. The
   * rule matches on the timestamp rather than on the presence of a merge, so a pull
   * request closed, reopened and later merged still shows the close that happened on
   * its own, and a payload without the shared timestamp shows both rows rather than
   * losing one.
   */
  private dropClosedBesideMerge(events: IssueTimelineEvent[]): IssueTimelineEvent[] {
    const mergeTimes = new Set(
      events.filter((event) => event.kind === 'merged').map((event) => event.createdAt)
    )
    if (mergeTimes.size === 0) return events
    return events.filter((event) => event.kind !== 'closed' || !mergeTimes.has(event.createdAt))
  }

  async createIssueComment(input: CreateIssueCommentInput): Promise<PullRequestComment> {
    const response = await this.request(`${this.issuePath(input)}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body: input.body })
    })
    const comment = this.toComment(response)
    if (!comment) throw new Error('The comment was posted but could not be read back')
    return comment
  }

  /**
   * Search the repository's issues, for a relationship picker.
   *
   * The same query and the same mapper the listing uses, so a candidate reads
   * exactly like a listed issue, including the node id the relationship writes need.
   * Sorted by most recently updated, because a picker is usually used on something
   * that moved lately.
   */
  async searchIssueCandidates(input: SearchIssueCandidatesInput): Promise<IssueSummary[]> {
    const qualifiers = ['is:issue', `repo:${input.owner}/${input.repo}`]
    const text = input.text.trim()
    if (text) qualifiers.push(text)
    qualifiers.push(LIST_SORTS['updated'])
    const data = await this.runGraphql(ISSUE_LIST_QUERY, {
      q: qualifiers.join(' '),
      first: ISSUE_CANDIDATE_LIMIT,
      after: null
    })
    const search = this.readRecord(data, 'search')
    const nodes: unknown[] = search && Array.isArray(search['nodes']) ? search['nodes'] : []
    return nodes.flatMap((node): IssueSummary[] => {
      const summary = this.toGraphqlIssueSummary(node, input.owner, input.repo)
      return summary ? [summary] : []
    })
  }

  /**
   * Make one issue a sub-issue of another.
   *
   * GraphQL rather than REST because that is where the mutation exists, and it takes
   * the two issues by node id. The payload returns the updated issue; the caller
   * re-reads the relationship list instead of trusting a partial answer, since the
   * reader draws the parent and the children together.
   */
  async addIssueSubIssue(input: IssueLinkInput): Promise<void> {
    await this.runRelationshipMutation(ADD_SUB_ISSUE_MUTATION, {
      issueId: input.issueNodeId,
      subIssueId: input.relatedNodeId
    })
  }

  /** Detach a sub-issue from its parent. */
  async removeIssueSubIssue(input: IssueLinkInput): Promise<void> {
    await this.runRelationshipMutation(REMOVE_SUB_ISSUE_MUTATION, {
      issueId: input.issueNodeId,
      subIssueId: input.relatedNodeId
    })
  }

  /** Record that `relatedNodeId` blocks `issueNodeId`. */
  async addIssueBlockedBy(input: IssueLinkInput): Promise<void> {
    await this.runRelationshipMutation(ADD_BLOCKED_BY_MUTATION, {
      issueId: input.issueNodeId,
      blockingIssueId: input.relatedNodeId
    })
  }

  /** Remove a blocking relationship between two issues. */
  async removeIssueBlockedBy(input: IssueLinkInput): Promise<void> {
    await this.runRelationshipMutation(REMOVE_BLOCKED_BY_MUTATION, {
      issueId: input.issueNodeId,
      blockingIssueId: input.relatedNodeId
    })
  }

  /**
   * Run one relationship mutation, discarding the payload.
   *
   * The payload carries the issue and its new counterpart, which the caller does not
   * use: the relationship list is re-read afterwards, so this only has to fail loudly
   * when GitHub refuses.
   */
  private async runRelationshipMutation(
    document: string,
    variables: Record<string, string>
  ): Promise<void> {
    await this.runGraphql(document, variables)
  }

  /**
   * Where GitHub files an issue comment.
   *
   * Repository-scoped, with the issue number appearing nowhere in the path: a
   * comment is addressed by its own id, the same as the pull request conversation
   * comments that share this collection.
   */
  private issueCommentPath(input: IssueCommentTarget): string {
    return `${this.repoPath(input)}/issues/comments/${input.commentId}`
  }

  /**
   * An issue's relationships, as four reads that answer together.
   *
   * GitHub splits them across endpoints that share no shape: the parent is one
   * object that 404s when there is none, and the three lists are collections of
   * full issue objects. They are read together because the reader draws one block,
   * and because a partial answer would be shown as "none yet" for a relationship
   * that merely could not be read.
   */
  async listIssueRelationships(input: IssueTarget): Promise<IssueRelationships> {
    const [parent, subIssues, blockedBy, blocking] = await Promise.all([
      this.readIssueParent(input),
      this.listRelatedIssues(`${this.issuePath(input)}/sub_issues`, input),
      this.listRelatedIssues(`${this.issuePath(input)}/dependencies/blocked_by`, input),
      this.listRelatedIssues(`${this.issuePath(input)}/dependencies/blocking`, input)
    ])
    return { parent, subIssues, blockedBy, blocking }
  }

  /**
   * The issue this one is a sub-issue of, or null when it has no parent.
   *
   * A missing parent is a 404 rather than an empty answer, so it is translated here
   * instead of being left to read as a failure. Every other error still reaches the
   * caller, which is what keeps a timeout from looking like "no parent".
   */
  private async readIssueParent(input: IssueTarget): Promise<IssueRelationshipItem | null> {
    try {
      const payload = await this.request(`${this.issuePath(input)}/parent`, { method: 'GET' })
      return this.toRelationshipItem(payload, input)
    } catch (failure) {
      if (failure instanceof ProviderHttpError && failure.status === 404) return null
      throw failure
    }
  }

  /**
   * One collection of related issues, each mapped, or dropped when unusable.
   *
   * A hundred items is GitHub's ceiling for these collections and one request, the
   * same bound the comment reads use. A parent with more sub-issues than that shows
   * the first hundred rather than the first thirty, which is what GitHub's own
   * default page would silently do.
   */
  private async listRelatedIssues(
    path: string,
    input: IssueTarget
  ): Promise<IssueRelationshipItem[]> {
    const response = await this.request(`${path}?per_page=100`, { method: 'GET' })
    const items = Array.isArray(response) ? response : []
    return items.flatMap((item): IssueRelationshipItem[] => {
      const related = this.toRelationshipItem(item, input)
      return related ? [related] : []
    })
  }

  /**
   * One related issue, or null when the payload has no usable number.
   *
   * The item's repository is read from the payload and only falls back to this
   * issue's own. That is not cosmetic: a dependency may live in another repository,
   * and labelling it with the wrong one is how a reader ends up clicking a link they
   * cannot place.
   */
  private toRelationshipItem(payload: unknown, input: IssueTarget): IssueRelationshipItem | null {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
    const record = payload as Record<string, unknown>
    const number = this.readNumber(record, 'number')
    if (number <= 0) return null
    const repository = this.readRecord(record, 'repository')
    return {
      number,
      title: this.readString(record, 'title') ?? `Issue #${number}`,
      url:
        this.readString(record, 'html_url') ??
        `https://github.com/${input.owner}/${input.repo}/issues/${number}`,
      state: this.readString(record, 'state') === 'closed' ? 'closed' : 'open',
      stateReason: this.toStateReason(this.readString(record, 'state_reason')),
      repository:
        (repository ? this.readString(repository, 'full_name') : null) ??
        `${input.owner}/${input.repo}`,
      nodeId: this.readString(record, 'node_id')
    }
  }

  async updateIssueComment(input: UpdateIssueCommentInput): Promise<PullRequestComment> {
    const response = await this.request(this.issueCommentPath(input), {
      method: 'PATCH',
      body: JSON.stringify({ body: input.body })
    })
    const comment = this.toComment(response)
    if (!comment) throw new Error('The comment was saved but could not be read back')
    return comment
  }

  async deleteIssueComment(input: IssueCommentTarget): Promise<void> {
    await this.request(this.issueCommentPath(input), { method: 'DELETE' })
  }

  /** Read pages sequentially so long conversations do not fan out requests. */
  private async readCollection(path: string): Promise<unknown[]> {
    const items: unknown[] = []
    for (let page = 1; page <= 100; page += 1) {
      const response = await this.request(`${path}${page === 1 ? '' : `&page=${page}`}`, {
        method: 'GET'
      })
      if (!Array.isArray(response)) throw new Error('GitHub returned an invalid collection')
      items.push(...response)
      if (response.length < 100) return items
    }
    throw new Error('GitHub history exceeds the supported page limit')
  }

  async listPullRequestStack(input: PullRequestTarget): Promise<PullRequestSummary[]> {
    return (await this.readPullRequestStacks(input)).get(input.pullNumber) ?? []
  }

  private async readPullRequestStacks(input: {
    owner: string
    repo: string
  }): Promise<Map<number, PullRequestSummary[]>> {
    const items = await this.readCollection(`${this.repoPath(input)}/pulls?state=open&per_page=100`)
    const prs = items.flatMap((item) => {
      const summary = this.toSummary(item, input.owner, input.repo)
      return summary ? [summary] : []
    })
    const headKey = (pr: PullRequestSummary): string | null =>
      pr.headRepository && pr.headRef ? `${pr.headRepository.toLowerCase()}:${pr.headRef}` : null
    const baseKey = (pr: PullRequestSummary): string | null =>
      pr.baseRepository && pr.baseRef ? `${pr.baseRepository.toLowerCase()}:${pr.baseRef}` : null
    const byHead = new Map<string, PullRequestSummary[]>()
    const byBase = new Map<string, PullRequestSummary[]>()
    for (const pr of prs) {
      const head = headKey(pr)
      const base = baseKey(pr)
      if (head) {
        const rows = byHead.get(head)
        if (rows) rows.push(pr)
        else byHead.set(head, [pr])
      }
      if (base) {
        const rows = byBase.get(base)
        if (rows) rows.push(pr)
        else byBase.set(base, [pr])
      }
    }
    const stacks = new Map<number, PullRequestSummary[]>()
    const visited = new Set<number>()
    for (const current of prs) {
      if (visited.has(current.number)) continue
      const depths = new Map<number, number>([[current.number, 0]])
      const queue = [current]
      const expandedParents = new Set<string>()
      const expandedChildren = new Set<string>()
      for (let index = 0; index < queue.length; index += 1) {
        const pr = queue[index]
        const depth = depths.get(pr.number) ?? 0
        const base = baseKey(pr) ?? ''
        const head = headKey(pr) ?? ''
        const parents = expandedParents.has(base) ? [] : (byHead.get(base) ?? [])
        const children = expandedChildren.has(head) ? [] : (byBase.get(head) ?? [])
        expandedParents.add(base)
        expandedChildren.add(head)
        for (const [neighbors, offset] of [
          [parents, -1],
          [children, 1]
        ] as const) {
          for (const next of neighbors) {
            if (depths.has(next.number)) continue
            depths.set(next.number, depth + offset)
            queue.push(next)
          }
        }
      }
      for (const pr of queue) visited.add(pr.number)
      if (queue.length < 2) continue
      queue.sort(
        (a, b) => (depths.get(a.number) ?? 0) - (depths.get(b.number) ?? 0) || a.number - b.number
      )
      for (const pr of queue) stacks.set(pr.number, queue)
    }
    return stacks
  }

  async listPullRequestCommits(input: PullRequestTarget): Promise<PullRequestCommit[]> {
    const response = await this.readCollection(`${this.pullPath(input)}/commits?per_page=100`)
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
    const response = await this.readCollection(
      `${this.repoPath(input)}/issues/${input.pullNumber}/comments?per_page=100`
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
    const response = await this.readCollection(`${this.pullPath(input)}/files?per_page=100`)
    return this.toFiles(response)
  }

  async listPullRequestReviews(input: PullRequestTarget): Promise<PullRequestReview[]> {
    const response = await this.readCollection(`${this.pullPath(input)}/reviews?per_page=100`)
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
          authorAssociation: this.toAuthorAssociation(record),
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
    const response = await this.readCollection(`${this.pullPath(input)}/comments?per_page=100`)
    const items = Array.isArray(response) ? response : []
    return items.flatMap((item): PullRequestReviewComment[] => {
      const comment = this.toReviewComment(item, input)
      return comment ? [comment] : []
    })
  }

  /**
   * Resolution state for each inline thread.
   *
   * The comments themselves are REST, but GitHub keeps whether a thread is
   * settled on the GraphQL thread node, so this reads through the pull
   * request's `reviewThreads` connection instead. A failure here must not cost
   * the reader the comments they can still see, which is why the caller treats
   * it as optional.
   */
  async listPullRequestReviewThreads(input: PullRequestTarget): Promise<PullRequestReviewThread[]> {
    const data = await this.runGraphql(
      'query ReviewThreads($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewThreads(first: 100) { nodes { id isResolved isOutdated comments(first: 100) { nodes { databaseId } } } } } } }',
      { owner: input.owner, name: input.repo, number: input.pullNumber }
    )
    const repository = this.readRecord(data, 'repository')
    const pullRequest = repository ? this.readRecord(repository, 'pullRequest') : null
    const connection = pullRequest ? this.readRecord(pullRequest, 'reviewThreads') : null
    const nodes = connection ? connection['nodes'] : null
    if (!Array.isArray(nodes)) return []
    return nodes.flatMap((node): PullRequestReviewThread[] => {
      if (typeof node !== 'object' || node === null) return []
      const record = node as Record<string, unknown>
      const nodeId = this.readString(record, 'id')
      if (!nodeId) return []
      return [
        {
          nodeId,
          isResolved: record['isResolved'] === true,
          isOutdated: record['isOutdated'] === true,
          commentIds: this.readDatabaseIds(record)
        }
      ]
    })
  }

  /** Settle or reopen one thread through the mutation GraphQL keeps it behind. */
  async setPullRequestReviewThreadResolved(input: ResolvePrReviewThreadInput): Promise<void> {
    await this.runGraphql(
      input.resolved
        ? 'mutation ResolveReviewThread($threadId: ID!) { resolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } } }'
        : 'mutation UnresolveReviewThread($threadId: ID!) { unresolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } } }',
      { threadId: input.nodeId }
    )
  }

  /**
   * Read the reactions on many subjects at once.
   *
   * Reactions hang off the subject rather than off a comment list, and GitHub
   * answers `nodes(ids:)` for up to a hundred subjects per request, so a whole
   * conversation is one round trip instead of one per comment. The answer is
   * keyed by node id rather than positional: a subject that could not be
   * resolved comes back as a null entry, and the id it was asked under is what
   * keeps the rest of the batch placeable.
   */
  async listReactions(subjectNodeIds: string[]): Promise<PrReactionMap> {
    const unique = [...new Set(subjectNodeIds.filter((id) => id.length > 0))]
    if (unique.length === 0) return {}
    const batches: string[][] = []
    for (let index = 0; index < unique.length; index += REACTION_BATCH_SIZE) {
      batches.push(unique.slice(index, index + REACTION_BATCH_SIZE))
    }
    const answers = await Promise.all(
      batches.map((ids) => this.runGraphql(REACTION_GROUPS_QUERY, { ids }))
    )
    const reactions: PrReactionMap = {}
    for (const data of answers) {
      const nodes = data['nodes']
      if (!Array.isArray(nodes)) continue
      for (const node of nodes) {
        if (typeof node !== 'object' || node === null) continue
        const record = node as Record<string, unknown>
        const nodeId = this.readString(record, 'id')
        const groups = this.toReactionGroups(record)
        // A subject nobody has reacted to is left out rather than carried as an
        // empty list: GitHub answers all eight groups for every subject, and
        // seven of them saying nothing is noise the reader would filter anyway.
        if (!nodeId || groups.length === 0) continue
        reactions[nodeId] = groups
      }
    }
    return reactions
  }

  /**
   * Add or take back the signed-in account's reaction on one subject.
   *
   * GitHub has one mutation per direction and both answer with the subject, so
   * the write and the read are the same round trip: the caller corrects the
   * comment it is showing from the server's answer instead of refetching a
   * conversation that is already on screen.
   */
  async setReaction(input: SetPrReactionInput): Promise<PrReactionGroup[]> {
    const field = input.add ? 'addReaction' : 'removeReaction'
    const data = await this.runGraphql(
      `mutation SetReaction($subjectId: ID!, $content: ReactionContent!) { ${field}(input: { subjectId: $subjectId, content: $content }) { subject { ... on Reactable { ${REACTION_GROUP_SELECTION} } } } }`,
      { subjectId: input.nodeId, content: input.content }
    )
    const mutation = this.readRecord(data, field)
    const subject = mutation ? this.readRecord(mutation, 'subject') : null
    if (!subject) {
      throw new Error('The provider did not answer with the subject that was reacted to')
    }
    return this.toReactionGroups(subject)
  }

  /**
   * The reaction groups on one subject that actually carry a reaction.
   *
   * `count` is GitHub's own total, which is authoritative: the actor list is
   * capped by the query, so a popular reaction names its first few reactors and
   * still reports every one of them.
   */
  private toReactionGroups(record: Record<string, unknown>): PrReactionGroup[] {
    const groups = record['reactionGroups']
    if (!Array.isArray(groups)) return []
    return groups.flatMap((entry): PrReactionGroup[] => {
      if (typeof entry !== 'object' || entry === null) return []
      const group = entry as Record<string, unknown>
      const content = this.readString(group, 'content')
      if (!content || !isReactionContent(content)) return []
      const reactors = this.readRecord(group, 'reactors')
      const count = reactors ? this.readNumber(reactors, 'totalCount') : 0
      if (count <= 0) return []
      return [
        {
          content,
          viewerHasReacted: group['viewerHasReacted'] === true,
          count,
          actors: this.toReactionActors(reactors)
        }
      ]
    })
  }

  /** The reactors a reaction group carries, skipping any without a login. */
  private toReactionActors(reactors: Record<string, unknown> | null): PrReactionActor[] {
    const nodes = reactors ? reactors['nodes'] : null
    if (!Array.isArray(nodes)) return []
    return nodes.flatMap((node): PrReactionActor[] => {
      if (typeof node !== 'object' || node === null) return []
      const record = node as Record<string, unknown>
      const login = this.readString(record, 'login')
      if (!login) return []
      return [{ login, avatarUrl: this.readString(record, 'avatarUrl') }]
    })
  }

  /** The numeric comment ids a GraphQL thread node holds, in thread order. */
  private readDatabaseIds(thread: Record<string, unknown>): number[] {
    const comments = this.readRecord(thread, 'comments')
    const nodes = comments ? comments['nodes'] : null
    if (!Array.isArray(nodes)) return []
    return nodes.flatMap((node): number[] => {
      if (typeof node !== 'object' || node === null) return []
      const id = this.readNumber(node as Record<string, unknown>, 'databaseId')
      return id > 0 ? [id] : []
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
    const side = this.readString(record, 'side')
    return {
      id,
      ...this.toAuthor(this.readRecord(record, 'user')),
      authorAssociation: this.toAuthorAssociation(record),
      body: this.readString(record, 'body') ?? '',
      path: this.readString(record, 'path') ?? '',
      line: line > 0 ? line : null,
      // GitHub spells these `LEFT`/`RIGHT`; the app names the file they number.
      side: side === 'LEFT' ? 'left' : side === 'RIGHT' ? 'right' : null,
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

  /** Replace the labels a pull request carries, answering with the labels it now has. */
  async setPullRequestLabels(
    input: PullRequestTarget & { labels: string[] }
  ): Promise<PullRequestLabel[]> {
    const response = await this.request(
      `${this.repoPath(input)}/issues/${input.pullNumber}/labels`,
      { method: 'PUT', body: JSON.stringify({ labels: input.labels }) }
    )
    return this.toLabels(response)
  }

  /**
   * Replace a pull request's assignees.
   *
   * The issues endpoint rather than the pulls one: assignees are an issue field,
   * and it is also the only shape that answers with the resulting accounts, so the
   * caller never has to reconstruct what the provider decided.
   */
  async setPullRequestAssignees(
    input: PullRequestTarget & { logins: string[] }
  ): Promise<RepositoryMentionUser[]> {
    const response = await this.request(`${this.repoPath(input)}/issues/${input.pullNumber}`, {
      method: 'PATCH',
      body: JSON.stringify({ assignees: input.logins })
    })
    const record = Array.isArray(response) ? {} : response
    return this.toAssignees(record)
  }

  /** Attach or clear a pull request's milestone. An explicit null detaches it. */
  async setPullRequestMilestone(
    input: PullRequestTarget & { milestone: number | null }
  ): Promise<PullRequestMilestone | null> {
    const response = await this.request(`${this.repoPath(input)}/issues/${input.pullNumber}`, {
      method: 'PATCH',
      body: JSON.stringify({ milestone: input.milestone })
    })
    const record = Array.isArray(response) ? {} : response
    return this.toMilestone(record['milestone'])
  }

  /** The repository's own label catalog, which a label picker draws its chips from. */
  async listRepositoryLabels(input: { owner: string; repo: string }): Promise<PullRequestLabel[]> {
    const response = await this.request(`${this.repoPath(input)}/labels?per_page=100`, {
      method: 'GET'
    })
    return this.toLabels(response)
  }

  /** The repository's open milestones. Closed ones are history, not a choice. */
  async listRepositoryMilestones(input: {
    owner: string
    repo: string
  }): Promise<PullRequestMilestone[]> {
    const response = await this.request(
      `${this.repoPath(input)}/milestones?state=open&per_page=100`,
      {
        method: 'GET'
      }
    )
    const items = Array.isArray(response) ? response : []
    return items.flatMap((item): PullRequestMilestone[] => {
      const milestone = this.toMilestone(item)
      return milestone ? [milestone] : []
    })
  }

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
    const response = await this.request(
      `${this.repoPath(input)}/actions/runs?${params.toString()}`,
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
  async listDeploymentPage(input: ListDeploymentPageInput): Promise<GitHubDeploymentPage> {
    const perPage = Math.min(Math.max(input.perPage, 1), 50)
    const params = new URLSearchParams({
      per_page: String(perPage + 1),
      page: String(input.page)
    })
    const response = await this.request(
      `${this.repoPath(input)}/deployments?${params.toString()}`,
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
  async hasDeploymentActivity(input: { owner: string; repo: string }): Promise<boolean> {
    const base = this.repoPath(input)
    const [runsResponse, deploymentsResponse] = await Promise.all([
      this.request(`${base}/actions/runs?per_page=1`, { method: 'GET' }),
      this.request(`${base}/deployments?per_page=1`, { method: 'GET' })
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

  /**
   * Cancel a queued or in-progress workflow run. GitHub accepts the request and
   * answers with 202; the run settles into `cancelled` asynchronously, so callers
   * re-read the run rather than trusting the mutation's return.
   */
  async cancelWorkflowRun(input: { owner: string; repo: string; runId: number }): Promise<void> {
    await this.request(`${this.repoPath(input)}/actions/runs/${input.runId}/cancel`, {
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
      // A signed-in token can still get a 404 for a public repository it cannot
      // reach. Public GET endpoints remain readable without credentials, so
      // retry those reads anonymously. Never do this for mutations or a
      // configured self-hosted provider.
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
      assignees: this.readGraphqlAssignees(record),
      milestone: this.readGraphqlMilestone(record),
      ...(checks ? { checks } : {}),
      mergeable: this.readMergeable(record),
      mergeableState: mergeStateStatus ? mergeStateStatus.toLowerCase() : null
    }
  }

  /**
   * Assigned accounts from the GraphQL listing.
   *
   * The listing's `assignees` connection is typed as users, so the app-account
   * signal is the `[bot]` login suffix here rather than the user `type` REST
   * exposes.
   */
  private readGraphqlAssignees(record: Record<string, unknown>): RepositoryMentionUser[] {
    const connection = this.readRecord(record, 'assignees')
    const nodes: unknown[] =
      connection && Array.isArray(connection['nodes']) ? connection['nodes'] : []
    return nodes.flatMap((node): RepositoryMentionUser[] => {
      if (typeof node !== 'object' || node === null) return []
      const entry = node as Record<string, unknown>
      const login = this.readString(entry, 'login')?.trim()
      if (!login) return []
      return [
        {
          login,
          name: this.readString(entry, 'name'),
          avatarUrl: this.readString(entry, 'avatarUrl'),
          bot: login.endsWith('[bot]')
        }
      ]
    })
  }

  /** The milestone a GraphQL listing node reports, or null when it has none. */
  private readGraphqlMilestone(record: Record<string, unknown>): PullRequestMilestone | null {
    const milestone = this.readRecord(record, 'milestone')
    if (!milestone) return null
    const number = this.readNumber(milestone, 'number')
    if (number <= 0) return null
    return {
      number,
      title: this.readString(milestone, 'title') ?? `Milestone ${number}`,
      state: this.readString(milestone, 'state') === 'CLOSED' ? 'closed' : 'open',
      description: this.readString(milestone, 'description'),
      dueOn: this.readString(milestone, 'dueOn')
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
   * Map a label list from either REST shape.
   *
   * The label endpoints answer with label objects while older payloads answer
   * with the bare names, so both are read here and a name that is not a usable
   * chip is dropped rather than drawn as an empty one.
   */
  private toLabels(payload: unknown): PullRequestLabel[] {
    if (!Array.isArray(payload)) return []
    const seen = new Set<string>()
    const labels: PullRequestLabel[] = []
    for (const entry of payload) {
      const label = this.toLabel(entry)
      if (!label) continue
      const key = label.name.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      labels.push(label)
    }
    return labels
  }

  /** One label from either REST shape, or null when it carries no usable name. */
  private toLabel(entry: unknown): PullRequestLabel | null {
    if (typeof entry === 'string') {
      const name = entry.trim()
      return name ? { name, color: '', description: null } : null
    }
    if (typeof entry !== 'object' || entry === null) return null
    const record = entry as Record<string, unknown>
    const name = this.readString(record, 'name')?.trim()
    if (!name) return null
    return {
      name,
      color: this.readString(record, 'color') ?? '',
      description: this.readString(record, 'description')
    }
  }

  /** Map one milestone payload, or null when it is not a usable milestone. */
  private toMilestone(payload: unknown): PullRequestMilestone | null {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
    const record = payload as Record<string, unknown>
    const number = this.readNumber(record, 'number')
    if (number <= 0) return null
    return {
      number,
      title: this.readString(record, 'title') ?? `Milestone ${number}`,
      state: this.readString(record, 'state') === 'closed' ? 'closed' : 'open',
      description: this.readString(record, 'description'),
      dueOn: this.readString(record, 'due_on')
    }
  }

  /** Assigned accounts from an issue payload, deduplicated by login. */
  private toAssignees(record: Record<string, unknown>): RepositoryMentionUser[] {
    const raw: unknown[] = Array.isArray(record['assignees'])
      ? (record['assignees'] as unknown[])
      : []
    const seen = new Set<string>()
    return raw.flatMap((entry): RepositoryMentionUser[] => {
      if (typeof entry !== 'object' || entry === null) return []
      const user = entry as Record<string, unknown>
      const login = this.readString(user, 'login')?.trim()
      if (!login) return []
      const key = login.toLowerCase()
      if (seen.has(key)) return []
      seen.add(key)
      const name = this.readString(user, 'name')?.trim()
      return [
        {
          login,
          name: name ? name : null,
          avatarUrl: this.readString(user, 'avatar_url'),
          bot: this.readString(user, 'type') === 'Bot' || login.endsWith('[bot]')
        }
      ]
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
      headRepository: this.readString(this.readRecord(head ?? {}, 'repo') ?? {}, 'full_name'),
      baseRepository: this.readString(this.readRecord(base ?? {}, 'repo') ?? {}, 'full_name'),
      createdAt: this.readString(record, 'created_at') ?? '',
      updatedAt: this.readString(record, 'updated_at') ?? '',
      comments: this.readNumber(record, 'comments'),
      labels: this.toLabels(record['labels']),
      assignees: this.toAssignees(record),
      milestone: this.toMilestone(record['milestone']),
      mergeable: typeof mergeableRaw === 'boolean' ? mergeableRaw : null,
      mergeableState: mergeableStateRaw || null
    }
  }

  /**
   * Map one GraphQL search node to the renderer-safe issue summary, or null when
   * it is not an issue or has no usable number.
   *
   * The `Issue` typename check is what keeps a pull request out of an issue
   * listing even if the search qualifiers ever let one through; the row must never
   * draw something the reader cannot open.
   */
  private toGraphqlIssueSummary(
    payload: unknown,
    owner: string,
    repo: string
  ): IssueSummary | null {
    if (typeof payload !== 'object' || payload === null) return null
    const record = payload as Record<string, unknown>
    if (this.readString(record, '__typename') !== 'Issue') return null
    const number = this.readNumber(record, 'number')
    if (number <= 0) return null
    const author = this.readRecord(record, 'author')
    const login = author ? (this.readString(author, 'login') ?? 'unknown') : 'unknown'
    const comments = this.readRecord(record, 'comments')
    return {
      number,
      title: this.readString(record, 'title') ?? `Issue #${number}`,
      url: this.readString(record, 'url') ?? `https://github.com/${owner}/${repo}/issues/${number}`,
      state: this.readString(record, 'state') === 'CLOSED' ? 'closed' : 'open',
      stateReason: this.toStateReason(this.readString(record, 'stateReason')),
      authorLogin: login,
      authorAvatarUrl: author ? this.readString(author, 'avatarUrl') : null,
      authorIsBot: login.endsWith('[bot]'),
      createdAt: this.readString(record, 'createdAt') ?? '',
      updatedAt: this.readString(record, 'updatedAt') ?? '',
      comments: comments ? this.readNumber(comments, 'totalCount') : 0,
      labels: this.readLabels(record),
      assignees: this.readGraphqlAssignees(record),
      milestone: this.readGraphqlMilestone(record),
      nodeId: this.readString(record, 'id')
    }
  }

  /** Map a GitHub issue payload to the renderer-safe summary, or null if unusable. */
  private toIssueSummary(payload: unknown, owner: string, repo: string): IssueSummary | null {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
    const record = payload as Record<string, unknown>
    const number = this.readNumber(record, 'number')
    if (number <= 0) return null
    return {
      number,
      title: this.readString(record, 'title') ?? `Issue #${number}`,
      url:
        this.readString(record, 'html_url') ??
        `https://github.com/${owner}/${repo}/issues/${number}`,
      state: this.readString(record, 'state') === 'closed' ? 'closed' : 'open',
      stateReason: this.toStateReason(this.readString(record, 'state_reason')),
      ...this.toAuthor(this.readRecord(record, 'user')),
      createdAt: this.readString(record, 'created_at') ?? '',
      updatedAt: this.readString(record, 'updated_at') ?? '',
      comments: this.readNumber(record, 'comments'),
      labels: this.toLabels(record['labels']),
      assignees: this.toAssignees(record),
      milestone: this.toMilestone(record['milestone']),
      nodeId: this.readString(record, 'node_id')
    }
  }

  /**
   * GitHub's closure reason, spelled once for both transports.
   *
   * The search vocabulary uppercases the enum (`NOT_PLANNED`) while the REST field
   * lowercases it (`not_planned`), so the two are folded together here and an
   * undocumented value is dropped rather than passed through as a word the row
   * cannot place.
   */
  private toStateReason(raw: string | null): IssueStateReason | null {
    switch ((raw ?? '').toUpperCase()) {
      case 'COMPLETED':
        return 'completed'
      case 'NOT_PLANNED':
        return 'not_planned'
      case 'DUPLICATE':
        return 'duplicate'
      case 'REOPENED':
        return 'reopened'
      default:
        return null
    }
  }

  /**
   * One timeline event, or null when it is not one the reader renders.
   *
   * The endpoint is GitHub's own event log, which includes notification plumbing
   * github.com itself hides (`subscribed`, `mentioned`) alongside the comment
   * events the conversation already covers. Those are filtered here rather than in
   * the renderer, so the renderer's history is exactly the issue's own story. An
   * event type with no case below is likewise dropped: showing a row that cannot
   * say what happened would be worse than the omission.
   */
  private toTimelineEvent(payload: unknown): IssueTimelineEvent | null {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
    const record = payload as Record<string, unknown>
    const kind = this.toTimelineKind(this.readString(record, 'event'))
    if (!kind) return null
    const id = this.readNumber(record, 'id')
    const actor = this.toAuthor(this.readRecord(record, 'actor'))
    const event: IssueTimelineEvent = {
      id: id > 0 ? String(id) : `${kind}:${this.readString(record, 'created_at') ?? ''}`,
      kind,
      actorLogin: actor.authorLogin,
      actorAvatarUrl: actor.authorAvatarUrl,
      actorIsBot: actor.authorIsBot,
      createdAt: this.readString(record, 'created_at') ?? ''
    }
    switch (kind) {
      case 'labeled':
      case 'unlabeled':
        return { ...event, label: this.readTimelineLabel(record) }
      case 'assigned':
      case 'unassigned':
        return {
          ...event,
          assigneeLogin: this.readString(this.readRecord(record, 'assignee') ?? {}, 'login')
        }
      case 'closed':
        return {
          ...event,
          closeReason: this.toStateReason(this.readString(record, 'state_reason'))
        }
      case 'renamed': {
        const rename = this.readRecord(record, 'rename')
        return {
          ...event,
          rename: rename
            ? {
                from: this.readString(rename, 'from') ?? '',
                to: this.readString(rename, 'to') ?? ''
              }
            : null
        }
      }
      case 'milestoned':
      case 'demilestoned':
        return {
          ...event,
          milestoneTitle: this.readString(this.readRecord(record, 'milestone') ?? {}, 'title')
        }
      case 'locked':
        return { ...event, lockReason: this.readString(record, 'lock_reason') }
      case 'head_ref_force_pushed':
      case 'base_ref_force_pushed':
      case 'referenced':
      case 'merged':
        return { ...event, commitId: this.readString(record, 'commit_id') }
      case 'cross-referenced':
        return { ...event, reference: this.toTimelineReference(record) }
      case 'review_requested':
      case 'review_request_removed':
        return {
          ...event,
          reviewerLogin: this.readString(
            this.readRecord(record, 'requested_reviewer') ?? {},
            'login'
          ),
          reviewerTeamName: this.readString(this.readRecord(record, 'requested_team') ?? {}, 'name')
        }
      default:
        return event
    }
  }

  /**
   * The label a labeling event carried, or null when the payload omitted it.
   *
   * The event carries the label's own colour, so the chip the reader draws is the
   * same colour github.com draws without a catalog read.
   */
  private readTimelineLabel(record: Record<string, unknown>): PullRequestLabel | null {
    const label = this.readRecord(record, 'label')
    if (!label) return null
    const name = this.readString(label, 'name')
    if (!name) return null
    return { name, color: this.readString(label, 'color') ?? '' }
  }

  /**
   * What a cross-reference pointed at.
   *
   * GitHub nests the subject under `source.issue` for both kinds of link, with
   * `pull_request` present only when the subject is a pull request. The repository
   * is read from the subject itself, so a link that came from another repository
   * is labelled with the repository it lives in rather than with the issue's own.
   */
  private toTimelineReference(record: Record<string, unknown>): IssueTimelineReference | null {
    const source = this.readRecord(record, 'source')
    const issue = source ? this.readRecord(source, 'issue') : null
    if (!issue) return null
    const number = this.readNumber(issue, 'number')
    const url = this.readString(issue, 'html_url')
    if (number <= 0 || !url) return null
    return {
      url,
      number,
      title: this.readString(issue, 'title') ?? `#${number}`,
      repository: this.readString(this.readRecord(issue, 'repository') ?? {}, 'full_name') ?? '',
      isPullRequest: this.readRecord(issue, 'pull_request') !== null
    }
  }

  /**
   * The event kind the reader knows, or null for one it does not render.
   *
   * `issue_field_added` is GitHub's own opaque report of a change to an issue's
   * custom fields: the payload names neither the field nor its value, so it is
   * mapped to a field event that says a field changed without pretending to know
   * which one.
   *
   * Comments and reviews arrive from their richer collection endpoints. Commits
   * are added by the PR conversation builder so their author, message and date
   * remain available without duplicating timeline records.
   */
  private toTimelineKind(raw: string | null): IssueTimelineEventKind | null {
    switch (raw) {
      case 'labeled':
      case 'unlabeled':
      case 'assigned':
      case 'unassigned':
      case 'closed':
      case 'reopened':
      case 'renamed':
      case 'milestoned':
      case 'demilestoned':
      case 'locked':
      case 'unlocked':
      case 'pinned':
      case 'unpinned':
      case 'referenced':
      case 'cross-referenced':
      case 'marked_as_duplicate':
      case 'connected':
      case 'merged':
      case 'review_requested':
      case 'review_request_removed':
      case 'ready_for_review':
      case 'head_ref_deleted':
      case 'head_ref_force_pushed':
      case 'base_ref_changed':
      case 'base_ref_force_pushed':
      case 'head_ref_restored':
      case 'review_dismissed':
        return raw
      case 'issue_field_added':
        return 'fields'
      // github.com draws the draft transition, and the event arrives under both
      // spellings depending on which endpoint reported it, so both land on one kind
      // rather than the row going missing for whichever spelling this build met.
      case 'convert_to_draft':
      case 'converted_to_draft':
        return 'converted_to_draft'
      default:
        return null
    }
  }

  /** Address one issue's REST resource. */
  private issuePath(input: IssueTarget): string {
    return `${this.repoPath(input)}/issues/${input.issueNumber}`
  }

  /** Map a GitHub issue payload to the reference a create or state change returns. */
  private toIssueReference(
    payload: unknown,
    input: { owner: string; repo: string }
  ): IssueReference | null {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
    const record = payload as Record<string, unknown>
    const number = this.readNumber(record, 'number')
    if (number <= 0) return null
    return {
      number,
      url:
        this.readString(record, 'html_url') ??
        `https://github.com/${input.owner}/${input.repo}/issues/${number}`,
      title: this.readString(record, 'title') ?? `Issue #${number}`
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
      authorAssociation: this.toAuthorAssociation(record),
      body: this.readString(record, 'body') ?? '',
      createdAt: this.readString(record, 'created_at') ?? '',
      updatedAt: this.readString(record, 'updated_at'),
      nodeId: this.readString(record, 'node_id'),
      url: this.readString(record, 'html_url') ?? ''
    }
  }

  /**
   * What the commenter is to the repository.
   *
   * GitHub reports this on every REST comment payload as `author_association`,
   * and the conversation labels the commenter with it. A value GitHub has not
   * documented is dropped rather than passed through: the row draws the word,
   * and a word the reader cannot place is worse than no label at all.
   */
  private toAuthorAssociation(record: Record<string, unknown>): PrAuthorAssociation | null {
    const raw = this.readString(record, 'author_association')
    switch (raw) {
      case 'OWNER':
      case 'MEMBER':
      case 'COLLABORATOR':
      case 'CONTRIBUTOR':
      case 'FIRST_TIMER':
      case 'FIRST_TIME_CONTRIBUTOR':
      case 'MANNEQUIN':
      case 'NONE':
        return raw
      default:
        return null
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
