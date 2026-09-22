import type {
  GitHubDeploymentDetail,
  GitHubDeploymentJobLog,
  GitHubDeploymentOverview,
  GitHubWorkflowRunDetail,
  GitRepositoryIdentity,
  PrCommentKind,
  PrDraft,
  PrListFilter,
  PrListSort,
  PrMergeMethod,
  PrMinimizeReason,
  PrReviewEvent,
  PrState,
  PullRequestComment,
  PullRequestChecks,
  PullRequestCommit,
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
  RepositoryMentionUser,
  WorkflowRerunMode
} from '../../lib/types'

/** Merge a pull request with the given method. */
export interface MergePullRequestInput {
  owner: string
  repo: string
  pullNumber: number
  method: PrMergeMethod
  /** Optional custom commit title; only used for merge-commit and squash. */
  commitTitle?: string
  /** Optional custom commit message (the "comment" on the merge). */
  commitMessage?: string
}

/** List pull requests for a repository, optionally filtered by state. */
export interface ListPullRequestsInput {
  owner: string
  repo: string
  state?: PrState
}

/** One page of a pull request listing. */
export interface ListPullRequestPageInput extends ListPullRequestsInput {
  /** 1-based page number. */
  page: number
  /** Items per page; providers cap this. */
  perPage: number
  /** Which of the viewer's relationships to the pull request to keep. */
  filter: PrListFilter
  /** Newest-first ordering. */
  sort: PrListSort
  /**
   * Where to continue from, as the previous page reported it. Null asks for the
   * first page; a provider that pages by number instead ignores it.
   */
  cursor: string | null
}

/** Address one pull request in a repository. */
export interface PullRequestTarget {
  owner: string
  repo: string
  pullNumber: number
}

/** Post an issue comment on a pull request. */
export interface CreatePrCommentInput extends PullRequestTarget {
  body: string
}

/**
 * Address one already-posted comment. `kind` matters because GitHub stores
 * conversation comments and inline diff comments in two unrelated collections
 * with independent id sequences, so an id alone is ambiguous.
 */
export interface PrCommentTarget extends PullRequestTarget {
  kind: PrCommentKind
  commentId: number
}

/** Rewrite an already-posted comment's body. */
export interface UpdatePrCommentInput extends PrCommentTarget {
  body: string
}

/**
 * Answer an inline review comment inside that comment's thread.
 *
 * A reply is not a new thread: GitHub files it under the comment it answers, so
 * the id is the comment being replied to   and GitHub only accepts the id of the
 * comment that opened a thread, never one of its replies, so a reply to a reply
 * belongs to the same thread as the reply it answers and is posted against that
 * thread's opening comment. Conversation comments have no threading on GitHub at
 * all, which is why this only exists for the inline collection.
 */
export interface ReplyPrReviewCommentInput extends PullRequestTarget {
  /** The top-level comment whose thread receives the reply. */
  commentId: number
  body: string
}

/**
 * Hide a comment behind GitHub's "minimised" treatment. GraphQL-only, so the
 * caller supplies the node id rather than the numeric one.
 */
export interface MinimizePrCommentInput {
  nodeId: string
  reason: PrMinimizeReason
}

/**
 * Settle or reopen one inline thread.
 *
 * Resolution belongs to the thread rather than to any comment in it, and GitHub
 * exposes the transition only through GraphQL, so the caller supplies the
 * thread's node id as the read reported it.
 */
export interface ResolvePrReviewThreadInput {
  nodeId: string
  resolved: boolean
}

/** Submit a review verdict on a pull request. */
export interface CreatePrReviewInput extends PullRequestTarget {
  event: PrReviewEvent
  body: string
}

/**
 * Provider-agnostic pull request surface. GitLab, Bitbucket, or self-hosted
 * GitHub can plug in behind this interface with their own REST adapters; the
 * GitHub adapter is the reference implementation.
 */
export interface GitProvider {
  createPullRequest(draft: PrDraft): Promise<PullRequestReference>
  mergePullRequest(input: MergePullRequestInput): Promise<PullRequestReference>
  /** Promote a draft pull request to the reviewable state required before merge. */
  markPullRequestReadyForReview(input: PullRequestTarget): Promise<PullRequestReference>
  /** Compare two refs so the create-PR form can gate on there being a real change. */
  comparePullRequests(input: {
    owner: string
    repo: string
    base: string
    head: string
  }): Promise<PullRequestCompare>
  /** Reopen a closed pull request. */
  reopenPullRequest(input: PullRequestTarget): Promise<PullRequestReference>
  /** Close an open pull request without merging. */
  closePullRequest(input: PullRequestTarget): Promise<PullRequestReference>
  /** Update an open pull request's title and/or description. */
  updatePullRequest(
    input: PullRequestTarget & { title?: string; body?: string }
  ): Promise<PullRequestReference>
  listPullRequests(input: ListPullRequestsInput): Promise<PullRequestReference[]>
  /** Paginated listing with the detail the sidebar list needs. */
  listPullRequestPage(input: ListPullRequestPageInput): Promise<PullRequestPage>
  getPullRequest(input: PullRequestTarget): Promise<PullRequestDetail>
  listPullRequestCommits(input: PullRequestTarget): Promise<PullRequestCommit[]>
  listPullRequestComments(input: PullRequestTarget): Promise<PullRequestComment[]>
  createPullRequestComment(input: CreatePrCommentInput): Promise<PullRequestComment>
  /** Rewrite a conversation comment's body. Only the author may do this. */
  updatePullRequestComment(input: UpdatePrCommentInput): Promise<PullRequestComment>
  /** Permanently delete a conversation comment. Only the author may do this. */
  deletePullRequestComment(input: PrCommentTarget): Promise<void>
  /** Rewrite an inline diff comment's body. Only the author may do this. */
  updatePullRequestReviewComment(input: UpdatePrCommentInput): Promise<PullRequestReviewComment>
  /** Permanently delete an inline diff comment. Only the author may do this. */
  deletePullRequestReviewComment(input: PrCommentTarget): Promise<void>
  /** Answer an inline diff comment inside its thread. */
  replyToPullRequestReviewComment(
    input: ReplyPrReviewCommentInput
  ): Promise<PullRequestReviewComment>
  /**
   * Hide a comment behind GitHub's minimised treatment. There is no equivalent
   * REST endpoint   only the GraphQL `minimizeComment` mutation.
   */
  minimizePullRequestComment(input: MinimizePrCommentInput): Promise<void>
  createPullRequestReview(input: CreatePrReviewInput): Promise<void>
  /**
   * Resolution state for each inline thread on the pull request.
   *
   * Kept apart from `listPullRequestReviewComments` because GitHub splits them:
   * the comments are REST and the threads they hang in are GraphQL-only.
   */
  listPullRequestReviewThreads(input: PullRequestTarget): Promise<PullRequestReviewThread[]>
  /** Settle or reopen one thread. GraphQL only, addressed by thread node id. */
  setPullRequestReviewThreadResolved(input: ResolvePrReviewThreadInput): Promise<void>
  listPullRequestFiles(input: PullRequestTarget): Promise<PullRequestFile[]>
  listPullRequestReviews(input: PullRequestTarget): Promise<PullRequestReview[]>
  listPullRequestReviewComments(input: PullRequestTarget): Promise<PullRequestReviewComment[]>
  getPullRequestChecks(input: PullRequestTarget): Promise<PullRequestChecks>
  getCommitFiles(input: { owner: string; repo: string }, sha: string): Promise<PullRequestFile[]>
  /** Assignable repository accounts, for @-mention autocomplete in PR conversations. */
  listRepositoryMentionUsers(input: {
    owner: string
    repo: string
  }): Promise<RepositoryMentionUser[]>
  /**
   * Replace the labels a pull request carries, returning the labels it now has.
   * One write for the whole set rather than an add or a remove per label, so a
   * picker that toggles several chips costs one round trip and the result is the
   * provider's own answer instead of a locally reconstructed guess.
   */
  setPullRequestLabels(input: PullRequestTarget & { labels: string[] }): Promise<PullRequestLabel[]>
  /** Replace a pull request's assignees, returning the accounts it now has. */
  setPullRequestAssignees(
    input: PullRequestTarget & { logins: string[] }
  ): Promise<RepositoryMentionUser[]>
  /**
   * Attach or clear a pull request's milestone. A milestone is an issue field on
   * GitHub rather than a pull request field, which is why both the catalog and the
   * assignment travel through the issues endpoints.
   */
  setPullRequestMilestone(
    input: PullRequestTarget & { milestone: number | null }
  ): Promise<PullRequestMilestone | null>
  /** The repository's own label catalog, for a label picker. */
  listRepositoryLabels(input: { owner: string; repo: string }): Promise<PullRequestLabel[]>
  /** The repository's open milestones, for a milestone picker. */
  listRepositoryMilestones(input: { owner: string; repo: string }): Promise<PullRequestMilestone[]>
  /** Recent workflow runs and deployments for read-only repository monitoring. */
  getDeploymentOverview(input: { owner: string; repo: string }): Promise<GitHubDeploymentOverview>
  /** Rich in-app deployment detail: status history, linked run, jobs/steps. */
  getDeploymentDetail(input: {
    owner: string
    repo: string
    deploymentId: number
  }): Promise<GitHubDeploymentDetail>
  /** Rich in-app workflow-run detail: the run itself plus its jobs/steps. */
  getWorkflowRunDetail(input: {
    owner: string
    repo: string
    runId: number
  }): Promise<GitHubWorkflowRunDetail>
  /** Capped raw log text for one workflow run job, for the in-app log viewer. */
  getDeploymentJobLog(input: {
    owner: string
    repo: string
    jobId: number
  }): Promise<GitHubDeploymentJobLog>
  /**
   * Replay a workflow run's jobs, either every job or only the failed ones.
   * Needs `actions: write`, so a read-only grant answers 403 rather than a result.
   */
  rerunWorkflowRun(input: {
    owner: string
    repo: string
    runId: number
    mode: WorkflowRerunMode
  }): Promise<void>
  /**
   * Resolve `owner/repo` from a remote URL so PR calls can target the right
   * repository without asking the user for an extra identity.
   */
  resolveRepositoryIdentity(remoteUrl: string): GitRepositoryIdentity | null
}
