import type {
  GitHubDeploymentOverview,
  GitRepositoryIdentity,
  PrDraft,
  PrMergeMethod,
  PrReviewEvent,
  PrState,
  PullRequestComment,
  PullRequestChecks,
  PullRequestCommit,
  PullRequestDetail,
  PullRequestFile,
  PullRequestReview,
  PullRequestReviewComment,
  PullRequestPage,
  PullRequestReference
} from '../lib/types'

/** Merge a pull request with the given method. */
export interface MergePullRequestInput {
  owner: string
  repo: string
  pullNumber: number
  method: PrMergeMethod
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
  /**
   * Resolve `owner/repo` from a remote URL so PR calls can target the right
   * repository without asking the user for an extra identity.
   */
  resolveRepositoryIdentity(remoteUrl: string): GitRepositoryIdentity | null
}
