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
import { buildGitHubProviderUnits } from './github-provider/github-provider-units'
import type {
  IssueLinkInput,
  SearchIssueCandidatesInput,
  SearchPullRequestsInput
} from '../git/git-provider.interface'
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
export const PROVIDER_FETCH_TIMEOUT_MS = 15_000

/**
 * Cap on the raw job log text streamed into the app (roughly 200 KB). An oversized
 * log loses its middle, never its end: that is where the failing step is.
 */
export const MAX_JOB_LOG_BYTES = 200_000

export const GITHUB_API_ACCEPT = 'application/vnd.github+json'
export const GITHUB_API_VERSION = '2022-11-28'
export const USER_AGENT = 'CodeInOven'

/**
 * How many subjects one batched reaction read addresses.
 *
 * `nodes(ids:)` accepts at most 100, and a conversation longer than that is
 * read in consecutive requests rather than by dropping the tail.
 */
export const REACTION_BATCH_SIZE = 100

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
export const REACTION_GROUP_SELECTION = `reactionGroups {
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
export const REACTION_GROUPS_QUERY = `query ReactionGroups($ids: [ID!]!) { nodes(ids: $ids) { id ... on Reactable { ${REACTION_GROUP_SELECTION} } } }`

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
export const PULL_REQUEST_LIST_QUERY = `query PullRequestList($q: String!, $first: Int!, $after: String) {
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
export const ISSUE_CANDIDATE_LIMIT = 20

/**
 * How many pull requests the panel's find offers.
 *
 * Bounded like the issue picker, and for the same reason: a find is one item out of
 * a list the reader is already looking at, and typing is how they narrow it.
 */
export const PR_SEARCH_LIMIT = 20

/**
 * The relationship mutations.
 *
 * Every one of them takes the two issues by GraphQL node id and answers with the
 * updated issue, which is why one document shape serves all four. Their input fields
 * were read off the schema rather than guessed: `addSubIssue` takes
 * `issueId`/`subIssueId`, and the dependency pair takes `issueId`/`blockingIssueId`.
 */
export const ADD_SUB_ISSUE_MUTATION = `mutation AddSubIssue($issueId: ID!, $subIssueId: ID!) {
  addSubIssue(input: { issueId: $issueId, subIssueId: $subIssueId }) {
    issue {
      id
    }
  }
}`

export const REMOVE_SUB_ISSUE_MUTATION = `mutation RemoveSubIssue($issueId: ID!, $subIssueId: ID!) {
  removeSubIssue(input: { issueId: $issueId, subIssueId: $subIssueId }) {
    issue {
      id
    }
  }
}`

export const ADD_BLOCKED_BY_MUTATION = `mutation AddBlockedBy($issueId: ID!, $blockingIssueId: ID!) {
  addBlockedBy(input: { issueId: $issueId, blockingIssueId: $blockingIssueId }) {
    issue {
      id
    }
  }
}`

export const REMOVE_BLOCKED_BY_MUTATION = `mutation RemoveBlockedBy($issueId: ID!, $blockingIssueId: ID!) {
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
export const ISSUE_LIST_QUERY = `query IssueList($q: String!, $first: Int!, $after: String) {
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
export const LIST_SORTS: Record<PrListSort, string> = {
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
export const WORKFLOW_RUN_FILTER_STATUS: Record<WorkflowRunFilter, string | null> = {
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
export function branchPath(input: { branch: string }): string {
  return input.branch.split('/').map(encodeURIComponent).join('/')
}

/**
 * Whether GitHub refused a branch delete because the ref is already gone.
 *
 * The refusal is a 422 carrying "Reference does not exist", which is the same
 * status a protected branch refusal uses, so the message is what separates a
 * branch that was already deleted from a write that was denied.
 */
export function isMissingRefRefusal(failure: ProviderHttpError): boolean {
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
  /**
   * One owner per concern. Each unit holds this engine and nothing else, so they
   * are safe to build first: none of them reads a field at construction.
   */
  private readonly units = buildGitHubProviderUnits(this)

  constructor(
    readonly token: string,
    readonly baseUrl = resolveProviderBaseUrl(),
    readonly refreshAccessToken?: () => Promise<string | null>
  ) {}

  async createPullRequest(draft: PrDraft): Promise<PullRequestReference> {
    return this.units['pull-requests'].createPullRequest(draft)
  }
  async mergePullRequest(input: MergePullRequestInput): Promise<PullRequestReference> {
    return this.units['pull-requests'].mergePullRequest(input)
  }
  async markPullRequestReadyForReview(input: PullRequestTarget): Promise<PullRequestReference> {
    return this.units['pull-requests'].markPullRequestReadyForReview(input)
  }
  async comparePullRequests(input: {
    owner: string
    repo: string
    base: string
    head: string
  }): Promise<PullRequestCompare> {
    return this.units['pull-requests'].comparePullRequests(input)
  }
  async reopenPullRequest(input: PullRequestTarget): Promise<PullRequestReference> {
    return this.units['pull-requests'].reopenPullRequest(input)
  }
  async closePullRequest(input: PullRequestTarget): Promise<PullRequestReference> {
    return this.units['pull-requests'].closePullRequest(input)
  }
  async readBranchDeletionState(input: BranchTarget): Promise<BranchDeletionState> {
    return this.units['branches'].readBranchDeletionState(input)
  }
  async deleteBranch(input: BranchTarget): Promise<BranchDeletionOutcome> {
    return this.units['branches'].deleteBranch(input)
  }
  async updatePullRequest(
    input: PullRequestTarget & {
      title?: string
      body?: string
    }
  ): Promise<PullRequestReference> {
    return this.units['pull-requests'].updatePullRequest(input)
  }
  async listPullRequests(input: ListPullRequestsInput): Promise<PullRequestReference[]> {
    return this.units['pull-requests'].listPullRequests(input)
  }
  async listPullRequestPage(input: ListPullRequestPageInput): Promise<PullRequestPage> {
    return this.units['pull-requests'].listPullRequestPage(input)
  }
  async searchPullRequests(input: SearchPullRequestsInput): Promise<PullRequestSummary[]> {
    return this.units['pull-requests'].searchPullRequests(input)
  }
  async getPullRequest(input: PullRequestTarget): Promise<PullRequestDetail> {
    return this.units['pull-requests'].getPullRequest(input)
  }
  async listIssuePage(input: ListIssuePageInput): Promise<IssuePage> {
    return this.units['issues'].listIssuePage(input)
  }
  async getIssue(input: IssueTarget): Promise<IssueDetail> {
    return this.units['issues'].getIssue(input)
  }
  async createIssue(input: CreateIssueInput): Promise<IssueReference> {
    return this.units['issues'].createIssue(input)
  }
  async updateIssue(input: UpdateIssueInput): Promise<IssueReference> {
    return this.units['issues'].updateIssue(input)
  }
  async setIssueState(input: SetIssueStateInput): Promise<IssueReference> {
    return this.units['issues'].setIssueState(input)
  }
  async listIssueComments(input: IssueTarget): Promise<PullRequestComment[]> {
    return this.units['issues'].listIssueComments(input)
  }
  async listIssueTimeline(input: IssueTarget): Promise<IssueTimelineEvent[]> {
    return this.units['issues'].listIssueTimeline(input)
  }
  dropClosedBesideMerge(events: IssueTimelineEvent[]): IssueTimelineEvent[] {
    return this.units['issues'].dropClosedBesideMerge(events)
  }
  async createIssueComment(input: CreateIssueCommentInput): Promise<PullRequestComment> {
    return this.units['issues'].createIssueComment(input)
  }
  async searchIssueCandidates(input: SearchIssueCandidatesInput): Promise<IssueSummary[]> {
    return this.units['issues'].searchIssueCandidates(input)
  }
  async addIssueSubIssue(input: IssueLinkInput): Promise<void> {
    return this.units['issue-relationships'].addIssueSubIssue(input)
  }
  async removeIssueSubIssue(input: IssueLinkInput): Promise<void> {
    return this.units['issue-relationships'].removeIssueSubIssue(input)
  }
  async addIssueBlockedBy(input: IssueLinkInput): Promise<void> {
    return this.units['issue-relationships'].addIssueBlockedBy(input)
  }
  async removeIssueBlockedBy(input: IssueLinkInput): Promise<void> {
    return this.units['issue-relationships'].removeIssueBlockedBy(input)
  }
  async runRelationshipMutation(
    document: string,
    variables: Record<string, string>
  ): Promise<void> {
    return this.units['issue-relationships'].runRelationshipMutation(document, variables)
  }
  issueCommentPath(input: IssueCommentTarget): string {
    return this.units['issues'].issueCommentPath(input)
  }
  async listIssueRelationships(input: IssueTarget): Promise<IssueRelationships> {
    return this.units['issue-relationships'].listIssueRelationships(input)
  }
  async readIssueParent(input: IssueTarget): Promise<IssueRelationshipItem | null> {
    return this.units['issue-relationships'].readIssueParent(input)
  }
  async listRelatedIssues(path: string, input: IssueTarget): Promise<IssueRelationshipItem[]> {
    return this.units['issue-relationships'].listRelatedIssues(path, input)
  }
  toRelationshipItem(payload: unknown, input: IssueTarget): IssueRelationshipItem | null {
    return this.units['issue-relationships'].toRelationshipItem(payload, input)
  }
  async updateIssueComment(input: UpdateIssueCommentInput): Promise<PullRequestComment> {
    return this.units['issues'].updateIssueComment(input)
  }
  async deleteIssueComment(input: IssueCommentTarget): Promise<void> {
    return this.units['issues'].deleteIssueComment(input)
  }
  async readCollection(path: string): Promise<unknown[]> {
    return this.units['api-core'].readCollection(path)
  }
  async listPullRequestStack(input: PullRequestTarget): Promise<PullRequestSummary[]> {
    return this.units['pull-requests'].listPullRequestStack(input)
  }
  async readPullRequestStacks(input: {
    owner: string
    repo: string
  }): Promise<Map<number, PullRequestSummary[]>> {
    return this.units['pull-requests'].readPullRequestStacks(input)
  }
  async listPullRequestCommits(input: PullRequestTarget): Promise<PullRequestCommit[]> {
    return this.units['pull-requests'].listPullRequestCommits(input)
  }
  async listPullRequestComments(input: PullRequestTarget): Promise<PullRequestComment[]> {
    return this.units['pull-request-comments'].listPullRequestComments(input)
  }
  async createPullRequestComment(input: CreatePrCommentInput): Promise<PullRequestComment> {
    return this.units['pull-request-comments'].createPullRequestComment(input)
  }
  commentCollectionPath(kind: PrCommentKind): string {
    return this.units['api-core'].commentCollectionPath(kind)
  }
  async updatePullRequestComment(input: UpdatePrCommentInput): Promise<PullRequestComment> {
    return this.units['pull-request-comments'].updatePullRequestComment(input)
  }
  async deletePullRequestComment(input: PrCommentTarget): Promise<void> {
    return this.units['pull-request-comments'].deletePullRequestComment(input)
  }
  async updatePullRequestReviewComment(
    input: UpdatePrCommentInput
  ): Promise<PullRequestReviewComment> {
    return this.units['pull-request-comments'].updatePullRequestReviewComment(input)
  }
  async deletePullRequestReviewComment(input: PrCommentTarget): Promise<void> {
    return this.units['pull-request-comments'].deletePullRequestReviewComment(input)
  }
  async replyToPullRequestReviewComment(
    input: ReplyPrReviewCommentInput
  ): Promise<PullRequestReviewComment> {
    return this.units['pull-request-comments'].replyToPullRequestReviewComment(input)
  }
  async minimizePullRequestComment(input: MinimizePrCommentInput): Promise<void> {
    return this.units['pull-request-comments'].minimizePullRequestComment(input)
  }
  async createPullRequestReview(input: CreatePrReviewInput): Promise<void> {
    return this.units['pull-request-comments'].createPullRequestReview(input)
  }
  async listPullRequestFiles(input: PullRequestTarget): Promise<PullRequestFile[]> {
    return this.units['pull-request-comments'].listPullRequestFiles(input)
  }
  async listPullRequestReviews(input: PullRequestTarget): Promise<PullRequestReview[]> {
    return this.units['pull-request-comments'].listPullRequestReviews(input)
  }
  async listPullRequestReviewComments(
    input: PullRequestTarget
  ): Promise<PullRequestReviewComment[]> {
    return this.units['pull-request-comments'].listPullRequestReviewComments(input)
  }
  async listPullRequestReviewThreads(input: PullRequestTarget): Promise<PullRequestReviewThread[]> {
    return this.units['pull-request-comments'].listPullRequestReviewThreads(input)
  }
  async setPullRequestReviewThreadResolved(input: ResolvePrReviewThreadInput): Promise<void> {
    return this.units['pull-request-comments'].setPullRequestReviewThreadResolved(input)
  }
  async listReactions(subjectNodeIds: string[]): Promise<PrReactionMap> {
    return this.units['reactions'].listReactions(subjectNodeIds)
  }
  async setReaction(input: SetPrReactionInput): Promise<PrReactionGroup[]> {
    return this.units['reactions'].setReaction(input)
  }
  toReactionGroups(record: Record<string, unknown>): PrReactionGroup[] {
    return this.units['reactions'].toReactionGroups(record)
  }
  toReactionActors(reactors: Record<string, unknown> | null): PrReactionActor[] {
    return this.units['reactions'].toReactionActors(reactors)
  }
  readDatabaseIds(thread: Record<string, unknown>): number[] {
    return this.units['api-core'].readDatabaseIds(thread)
  }
  pullPermalink(input: PullRequestTarget): string {
    return this.units['api-core'].pullPermalink(input)
  }
  toReviewComment(payload: unknown, input: PullRequestTarget): PullRequestReviewComment | null {
    return this.units['pull-request-comments'].toReviewComment(payload, input)
  }
  async getPullRequestChecks(input: PullRequestTarget): Promise<PullRequestChecks> {
    return this.units['checks'].getPullRequestChecks(input)
  }
  async getCommitFiles(
    input: { owner: string; repo: string },
    sha: string
  ): Promise<PullRequestFile[]> {
    return this.units['repository-metadata'].getCommitFiles(input, sha)
  }
  async listRepositoryMentionUsers(input: {
    owner: string
    repo: string
  }): Promise<RepositoryMentionUser[]> {
    return this.units['repository-metadata'].listRepositoryMentionUsers(input)
  }
  async setPullRequestLabels(
    input: PullRequestTarget & { labels: string[] }
  ): Promise<PullRequestLabel[]> {
    return this.units['repository-metadata'].setPullRequestLabels(input)
  }
  async setPullRequestAssignees(
    input: PullRequestTarget & { logins: string[] }
  ): Promise<RepositoryMentionUser[]> {
    return this.units['repository-metadata'].setPullRequestAssignees(input)
  }
  async setPullRequestMilestone(
    input: PullRequestTarget & { milestone: number | null }
  ): Promise<PullRequestMilestone | null> {
    return this.units['repository-metadata'].setPullRequestMilestone(input)
  }
  async listRepositoryLabels(input: { owner: string; repo: string }): Promise<PullRequestLabel[]> {
    return this.units['repository-metadata'].listRepositoryLabels(input)
  }
  async listRepositoryMilestones(input: {
    owner: string
    repo: string
  }): Promise<PullRequestMilestone[]> {
    return this.units['repository-metadata'].listRepositoryMilestones(input)
  }
  async listWorkflowRunPage(input: ListWorkflowRunPageInput): Promise<GitHubWorkflowRunPage> {
    return this.units['workflows'].listWorkflowRunPage(input)
  }
  async listDeploymentPage(input: ListDeploymentPageInput): Promise<GitHubDeploymentPage> {
    return this.units['workflows'].listDeploymentPage(input)
  }
  async hasDeploymentActivity(input: { owner: string; repo: string }): Promise<boolean> {
    return this.units['workflows'].hasDeploymentActivity(input)
  }
  async getDeploymentDetail(input: {
    owner: string
    repo: string
    deploymentId: number
  }): Promise<GitHubDeploymentDetail> {
    return this.units['workflows'].getDeploymentDetail(input)
  }
  async getWorkflowRunDetail(input: {
    owner: string
    repo: string
    runId: number
  }): Promise<GitHubWorkflowRunDetail> {
    return this.units['workflows'].getWorkflowRunDetail(input)
  }
  async getDeploymentJobLog(input: {
    owner: string
    repo: string
    jobId: number
  }): Promise<GitHubDeploymentJobLog> {
    return this.units['workflows'].getDeploymentJobLog(input)
  }
  async rerunWorkflowRun(input: {
    owner: string
    repo: string
    runId: number
    mode: WorkflowRerunMode
  }): Promise<void> {
    return this.units['workflows'].rerunWorkflowRun(input)
  }
  async cancelWorkflowRun(input: { owner: string; repo: string; runId: number }): Promise<void> {
    return this.units['workflows'].cancelWorkflowRun(input)
  }
  async resolveDeploymentRun(
    input: { owner: string; repo: string },
    deployment: GitHubDeployment,
    statuses: GitHubDeploymentStatus[]
  ): Promise<GitHubWorkflowRun | null> {
    return this.units['workflows'].resolveDeploymentRun(input, deployment, statuses)
  }
  runIdFromDeploymentStatuses(statuses: GitHubDeploymentStatus[]): number {
    return this.units['workflows'].runIdFromDeploymentStatuses(statuses)
  }
  workflowRunIdFromUrls(...urls: Array<string | null>): number | null {
    return this.units['workflows'].workflowRunIdFromUrls(...urls)
  }
  jobIdFromUrls(...urls: Array<string | null>): number | null {
    return this.units['workflows'].jobIdFromUrls(...urls)
  }
  async getRunJobs(
    input: { owner: string; repo: string },
    runId: number
  ): Promise<GitHubDeploymentJob[]> {
    return this.units['workflows'].getRunJobs(input, runId)
  }
  async requestText(path: string): Promise<string> {
    return this.units['api-core'].requestText(path)
  }
  resolveRepositoryIdentity(remoteUrl: string): GitRepositoryIdentity | null {
    return this.units['api-core'].resolveRepositoryIdentity(remoteUrl)
  }
  async request(path: string, init: RequestInit): Promise<Record<string, unknown> | unknown[]> {
    return this.units['api-core'].request(path, init)
  }
  fetch(
    path: string,
    init: RequestInit,
    token: string | null,
    signal: AbortSignal
  ): Promise<Response> {
    return this.units['api-core'].fetch(path, init, token, signal)
  }
  async readErrorMessage(response: Response): Promise<string> {
    return this.units['api-core'].readErrorMessage(response)
  }
  toReference(payload: Record<string, unknown> | unknown[]): PullRequestReference {
    return this.units['mappers'].toReference(payload)
  }
  toFiles(payload: unknown): PullRequestFile[] {
    return this.units['mappers'].toFiles(payload)
  }
  toWorkflowRun(payload: unknown): GitHubWorkflowRun | null {
    return this.units['workflows'].toWorkflowRun(payload)
  }
  toDeployment(payload: unknown): GitHubDeployment | null {
    return this.units['workflows'].toDeployment(payload)
  }
  toDeploymentStatus(payload: unknown): GitHubDeploymentStatus | null {
    return this.units['workflows'].toDeploymentStatus(payload)
  }
  toDeploymentJob(payload: unknown): GitHubDeploymentJob | null {
    return this.units['workflows'].toDeploymentJob(payload)
  }
  toDeploymentJobStep(payload: unknown): GitHubDeploymentJobStep | null {
    return this.units['workflows'].toDeploymentJobStep(payload)
  }
  toCheckStatus(value: string | null): PullRequestCheck['status'] {
    return this.units['checks'].toCheckStatus(value)
  }
  toCheckConclusion(value: string | null): PullRequestCheck['conclusion'] {
    return this.units['checks'].toCheckConclusion(value)
  }
  rollUpChecks(checks: PullRequestCheck[]): PullRequestChecks['state'] {
    return this.units['checks'].rollUpChecks(checks)
  }
  repoPath(input: { owner: string; repo: string }): string {
    return this.units['api-core'].repoPath(input)
  }
  async runGraphql(
    query: string,
    variables: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    return this.units['api-core'].runGraphql(query, variables)
  }
  toGraphqlSummary(payload: unknown, owner: string, repo: string): PullRequestSummary | null {
    return this.units['mappers'].toGraphqlSummary(payload, owner, repo)
  }
  readGraphqlAssignees(record: Record<string, unknown>): RepositoryMentionUser[] {
    return this.units['mappers'].readGraphqlAssignees(record)
  }
  readGraphqlMilestone(record: Record<string, unknown>): PullRequestMilestone | null {
    return this.units['mappers'].readGraphqlMilestone(record)
  }
  readMergeable(record: Record<string, unknown>): boolean | null {
    return this.units['mappers'].readMergeable(record)
  }
  readLabels(record: Record<string, unknown>): PullRequestLabel[] {
    return this.units['mappers'].readLabels(record)
  }
  toLabels(payload: unknown): PullRequestLabel[] {
    return this.units['mappers'].toLabels(payload)
  }
  toLabel(entry: unknown): PullRequestLabel | null {
    return this.units['mappers'].toLabel(entry)
  }
  toMilestone(payload: unknown): PullRequestMilestone | null {
    return this.units['mappers'].toMilestone(payload)
  }
  toAssignees(record: Record<string, unknown>): RepositoryMentionUser[] {
    return this.units['mappers'].toAssignees(record)
  }
  readChecksRollup(record: Record<string, unknown>): PullRequestChecksRollup | undefined {
    return this.units['checks'].readChecksRollup(record)
  }
  pullPath(input: PullRequestTarget): string {
    return this.units['api-core'].pullPath(input)
  }
  toSummary(payload: unknown, owner: string, repo: string): PullRequestSummary | null {
    return this.units['mappers'].toSummary(payload, owner, repo)
  }
  toGraphqlIssueSummary(payload: unknown, owner: string, repo: string): IssueSummary | null {
    return this.units['mappers'].toGraphqlIssueSummary(payload, owner, repo)
  }
  toIssueSummary(payload: unknown, owner: string, repo: string): IssueSummary | null {
    return this.units['mappers'].toIssueSummary(payload, owner, repo)
  }
  toStateReason(raw: string | null): IssueStateReason | null {
    return this.units['mappers'].toStateReason(raw)
  }
  toTimelineEvent(payload: unknown): IssueTimelineEvent | null {
    return this.units['mappers'].toTimelineEvent(payload)
  }
  readTimelineLabel(record: Record<string, unknown>): PullRequestLabel | null {
    return this.units['mappers'].readTimelineLabel(record)
  }
  toTimelineReference(record: Record<string, unknown>): IssueTimelineReference | null {
    return this.units['mappers'].toTimelineReference(record)
  }
  toTimelineKind(raw: string | null): IssueTimelineEventKind | null {
    return this.units['mappers'].toTimelineKind(raw)
  }
  issuePath(input: IssueTarget): string {
    return this.units['api-core'].issuePath(input)
  }
  toIssueReference(
    payload: unknown,
    input: { owner: string; repo: string }
  ): IssueReference | null {
    return this.units['mappers'].toIssueReference(payload, input)
  }
  toComment(payload: unknown): PullRequestComment | null {
    return this.units['mappers'].toComment(payload)
  }
  toAuthorAssociation(record: Record<string, unknown>): PrAuthorAssociation | null {
    return this.units['mappers'].toAuthorAssociation(record)
  }
  toAuthor(user: Record<string, unknown> | null): {
    authorLogin: string
    authorAvatarUrl: string | null
    authorIsBot: boolean
  } {
    return this.units['mappers'].toAuthor(user)
  }
  readRecord(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
    return this.units['mappers'].readRecord(record, key)
  }
  readString(record: Record<string, unknown>, key: string): string | null {
    return this.units['mappers'].readString(record, key)
  }
  readNumber(record: Record<string, unknown>, key: string): number {
    return this.units['mappers'].readNumber(record, key)
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
