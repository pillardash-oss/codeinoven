import { ipcErrorMessage } from '$lib/ipc-errors'

/** Local alias so the many call sites keep their concise name. */
export const errorMessage = ipcErrorMessage

/** One in-flight git operation, tracked per project for busy/disabled UI. */
export type GitOperation =
  | 'refresh'
  | 'stage'
  | 'unstage'
  | 'commit'
  | 'amend'
  | 'reset'
  | 'delete-commit'
  | 'remove-commit-changes'
  | 'init'
  | 'checkout'
  | 'fetch'
  | 'pull'
  | 'sync'
  | 'push'
  | 'merge'
  | 'rebase'
  | 'stash'
  | 'ignore'
  | 'discard'
  | 'stash-pop'
  | 'stash-drop'
  | 'restore-files'
  | 'accept-conflicts'
  | 'abortMerge'
  | 'abortRebase'
  | 'rebase-action'
  | 'pr-create'
  | 'pr-merge'
  | 'pr-ready'
  | 'pr-comment'
  | 'pr-comment-edit'
  | 'pr-comment-delete'
  | 'pr-comment-reply'
  | 'pr-comment-hide'
  | 'pr-review'
  | 'pr-list'
  | 'pr-detail'
  | 'pr-reopen'
  | 'pr-close'
  | 'pr-update'
  | 'deployments'
  | 'deployment-detail'
  | 'deployment-run-detail'
  | 'deployment-log'
  | 'deployment-rerun'

/** How long a cached PR page or bundle is served without refetching. */
export const PR_CACHE_TTL_MS = 60_000
/**
 * How long a repository's @-mention candidate list stays fresh. Assignable
 * accounts change far more slowly than PR state, and the list is fetched only
 * when a user actually types `@`, so a long TTL costs nothing and keeps the
 * popover instant on every later mention.
 */
export const MENTION_USERS_TTL_MS = 10 * 60_000
/**
 * How long a failed mention-directory lookup is remembered. Short, because the
 * failure is usually a transient network blip, but long enough that a token
 * without the required permission does not re-request on every keystroke while
 * the user is still typing the handle.
 */
export const MENTION_USERS_RETRY_MS = 60_000

/** How long a cached deployment overview/detail is served without refetching. */
export const DEPLOYMENT_CACHE_TTL_MS = 60_000

/** Job logs change rarely and are heavy - hold them a little longer. */
export const DEPLOYMENT_LOG_CACHE_TTL_MS = 5 * 60_000

/**
 * How long a failed PR request is remembered before it may be tried again.
 *
 * A failure caches nothing, so without this the panel's periodic git refresh
 * would re-run the same doomed request on every tick - a 404 repeats forever
 * and GitHub answers with a secondary rate limit. Explicit refresh (`force`)
 * always ignores the cooldown, so the user is never locked out.
 */
export const PR_ERROR_COOLDOWN_MS = 120_000

/** How long a positive GitHub connection probe is trusted without re-probing. */
export const GITHUB_PROBE_TTL_MS = 30_000

/**
 * How long a failed hover warm-up is remembered before the same key may be
 * warmed again.
 *
 * Deliberately its own clock rather than `PR_ERROR_COOLDOWN_MS`: that one gates
 * the load the user asked for, and a warm-up must never arm it, or a hover that
 * happened to fail would leave the click behind it doing nothing. This only
 * stops a pointer parked on a broken row from re-requesting on every pass.
 */
export const PR_PRELOAD_RETRY_MS = 30_000

/**
 * Whether a `git push` failure was a non-fast-forward rejection (the remote
 * contains commits we don't have) rather than an actual error. Matches git's
 * standard stderr phrasing across versions.
 */
export function isPushRejected(message: string): boolean {
  return /non-fast-forward|fetch first|updates were rejected|failed to push some refs/iu.test(
    message
  )
}

export type GitPushResult =
  | { status: 'pushed' }
  | { status: 'rejected'; message: string }
  | { status: 'failed'; message: string }

export type DeleteBranchResult = 'deleted' | 'requires-force' | 'failed'

/** Git refuses `branch -d` when commits would become unreachable. */
export function isBranchNotFullyMerged(message: string): boolean {
  return /branch ['“"]?[^\n]+['”"]? is not fully merged/iu.test(message)
}

/**
 * `{ owner, repo }` parsed from a GitHub remote URL, or null when the URL does
 * not point at github.com. The single place the store and the panel both read
 * a repository identity out of a remote.
 */
export function parseGitHubRepo(url: string): { owner: string; repo: string } | null {
  const match = /(?:github\.com[:/])([^/]+)\/([^/.]+)(?:\.git)?\/?$/u.exec(url.trim())
  if (!match) return null
  const owner = match[1] ?? ''
  const repo = match[2] ?? ''
  return owner && repo ? { owner, repo } : null
}

/**
 * Cache key for one page of a repository's pull request list.
 *
 * The filter and sort are part of the key, not just the state: "open, authored by
 * me, newest first" and "open, everything, newest first" are different listings,
 * and a page cached under one must never be served for the other.
 */
export function prPageKey(
  owner: string,
  repo: string,
  state: string,
  filter: string,
  sort: string,
  page: number
): string {
  return `${owner}/${repo}:${state}:${filter}:${sort}:${page}`
}

/** Cache key for one pull request's detail bundle. */
export function prBundleKey(owner: string, repo: string, pullNumber: number): string {
  return `${owner}/${repo}#${pullNumber}`
}

/** Cache key for one repository's deployment overview. */
export function deploymentKey(owner: string, repo: string): string {
  return `${owner}/${repo}`
}

/** Cache key for one deployment's rich detail. */
export function deploymentDetailKey(owner: string, repo: string, deploymentId: number): string {
  return `${owner}/${repo}#${deploymentId}`
}

/** Cache key for one workflow run's rich detail. */
export function workflowRunKey(owner: string, repo: string, runId: number): string {
  return `${owner}/${repo}/runs/${runId}`
}

/** Cache key for one deployment job log. */
export function deploymentLogKey(owner: string, repo: string, jobId: number): string {
  return `${owner}/${repo}/jobs/${jobId}`
}
