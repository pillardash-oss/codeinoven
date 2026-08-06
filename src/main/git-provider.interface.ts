import type {
  GitRepositoryIdentity,
  PrDraft,
  PrMergeMethod,
  PrState,
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

/**
 * Provider-agnostic pull request surface. GitLab, Bitbucket, or self-hosted
 * GitHub can plug in behind this interface with their own REST adapters; the
 * GitHub adapter is the reference implementation.
 */
export interface GitProvider {
  createPullRequest(draft: PrDraft): Promise<PullRequestReference>
  mergePullRequest(input: MergePullRequestInput): Promise<PullRequestReference>
  listPullRequests(input: ListPullRequestsInput): Promise<PullRequestReference[]>
  /**
   * Resolve `owner/repo` from a remote URL so PR calls can target the right
   * repository without asking the user for an extra identity.
   */
  resolveRepositoryIdentity(remoteUrl: string): GitRepositoryIdentity | null
}
