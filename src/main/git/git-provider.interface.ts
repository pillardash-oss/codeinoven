import type {
  GitHubDeploymentDetail,
  GitHubDeploymentJobLog,
  GitHubDeploymentOverview,
  GitHubWorkflowRunDetail,
  GitRepositoryIdentity,
  PrDraft,
  PrMergeMethod,
  PrReviewEvent,
  PrState,
  PullRequestComment,
  PullRequestChecks,
  PullRequestCommit,
  PullRequestCompare,
  PullRequestDetail,
  PullRequestFile,
  PullRequestReview,
  PullRequestReviewComment,
  PullRequestPage,
  PullRequestReference
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
  createPullRequestReview(input: CreatePrReviewInput): Promise<void>
  listPullRequestFiles(input: PullRequestTarget): Promise<PullRequestFile[]>
  listPullRequestReviews(input: PullRequestTarget): Promise<PullRequestReview[]>
  listPullRequestReviewComments(input: PullRequestTarget): Promise<PullRequestReviewComment[]>
  getPullRequestChecks(input: PullRequestTarget): Promise<PullRequestChecks>
  getCommitFiles(input: { owner: string; repo: string }, sha: string): Promise<PullRequestFile[]>
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
   * Resolve `owner/repo` from a remote URL so PR calls can target the right
   * repository without asking the user for an extra identity.
   */
  resolveRepositoryIdentity(remoteUrl: string): GitRepositoryIdentity | null
}
