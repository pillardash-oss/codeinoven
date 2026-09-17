import { invoke } from '$lib/ipc.svelte'
import type {
  PrAgentReport,
  PrListQuery,
  PrState,
  PullRequestBundle,
  PullRequestFile,
  PullRequestPage,
  RepositoryMentionUser
} from '$shared/types'
import {
  MENTION_USERS_RETRY_MS,
  MENTION_USERS_TTL_MS,
  PR_CACHE_TTL_MS,
  PR_ERROR_COOLDOWN_MS,
  errorMessage,
  prBundleKey,
  prPageKey,
  type GitOperation
} from './git-store-helpers'

/**
 * Cached PR listings and detail bundles.
 *
 * The sidebar tab is mounted and unmounted every time the user switches tabs,
 * so without a store-level cache every visit would re-fetch and re-show a
 * spinner. Cached data renders immediately and is revalidated in the
 * background when it is older than `PR_CACHE_TTL_MS`.
 */
export class GitPullRequestCache {
  pages: Record<string, { page: PullRequestPage; fetchedAt: number }> = $state({})
  bundles: Record<string, PullRequestBundle> = $state({})
  agentReports: Record<string, PrAgentReport> = $state({})

  /**
   * @-mention candidates per `owner/repo`, keyed so two repositories never share
   * a list. `mentionUsersInFlight` is deliberately not reactive: it only
   * de-duplicates concurrent requests and nothing renders from it.
   */
  mentionUsers: Record<string, { users: RepositoryMentionUser[]; fetchedAt: number }> = $state({})
  /**
   * In-flight requests and recent failures, keyed the same way. Plain records
   * rather than Maps because nothing renders from them: they only de-duplicate
   * concurrent lookups and back off a failed one, so making them reactive would
   * cost work to publish state no view reads.
   */
  private mentionUsersInFlight: Record<string, Promise<RepositoryMentionUser[]>> = {}
  private mentionUsersFailedAt: Record<string, number> = {}

  /** Epoch ms of the last failure per PR cache key. Deliberately plain (not
   *  `$state`) - it only gates fetching, and making it reactive would feed the
   *  very effects that triggered the request.
   */
  private failures: Record<string, number> = {}

  /** One request per page key, preventing duplicate IPC calls from concurrent mounts/effects. */
  private pageRequests: Record<string, Promise<void> | undefined> = {}

  constructor(
    private readonly markBusy: (operation: GitOperation, busy: boolean) => void,
    private readonly setError: (message: string | null) => void
  ) {}

  /** True while a key is inside its post-failure cooldown. */
  private coolingDown(key: string): boolean {
    const failedAt = this.failures[key]
    if (failedAt === undefined) return false
    if (Date.now() - failedAt < PR_ERROR_COOLDOWN_MS) return true
    delete this.failures[key]
    return false
  }

  private markFailure(key: string): void {
    this.failures[key] = Date.now()
  }

  /** Keep list/detail caches coherent after a PR lifecycle mutation. */
  updateDraftState(owner: string, repo: string, pullNumber: number, draft: boolean): void {
    const pagePrefix = `${owner}/${repo}:`
    this.pages = Object.fromEntries(
      Object.entries(this.pages).map(([key, cached]) => [
        key,
        key.startsWith(pagePrefix)
          ? {
              ...cached,
              page: {
                ...cached.page,
                items: cached.page.items.map((item) =>
                  item.number === pullNumber ? { ...item, draft } : item
                )
              }
            }
          : cached
      ])
    )
    const bundleKey = prBundleKey(owner, repo, pullNumber)
    const bundle = this.bundles[bundleKey]
    if (bundle) {
      this.bundles = {
        ...this.bundles,
        [bundleKey]: { ...bundle, detail: { ...bundle.detail, draft } }
      }
    }
  }

  /**
   * Load a page of pull requests, serving cache first.
   *
   * Returns immediately when fresh cache exists; otherwise fetches. Pass
   * `force` for the explicit refresh button.
   *
   * The provider pages by cursor, so page N is only reachable through page N-1's
   * cursor. Walking from the first page fills in whichever earlier pages are
   * missing; on the usual Previous/Next path the walk stops at the first
   * iteration because the page before is already cached.
   */
  async ensurePullRequestPage(
    projectId: string,
    owner: string,
    repo: string,
    state: PrState,
    page: number,
    query: PrListQuery,
    force = false
  ): Promise<void> {
    for (let index = 1; index <= page; index += 1) {
      const key = prPageKey(owner, repo, state, query.filter, query.sort, index)
      const cached = this.pages[key]
      if (!force && cached && Date.now() - cached.fetchedAt < PR_CACHE_TTL_MS) continue
      if (!force && this.coolingDown(key)) return
      // A pagination cursor is the only way into a later page, and the provider
      // hands one out only while the listing has more. Absent one, this page
      // does not exist and asking for it would return the first page's rows.
      const cursor = index > 1 ? this.cursorBefore(owner, repo, state, query, index) : null
      if (index > 1 && !cursor) return
      const existingRequest = this.pageRequests[key]
      if (existingRequest) {
        await existingRequest
        continue
      }

      const request = this.loadPullRequestPage(
        projectId,
        owner,
        repo,
        state,
        index,
        query,
        cursor,
        key
      )
      this.pageRequests[key] = request
      try {
        await request
      } finally {
        if (this.pageRequests[key] === request) delete this.pageRequests[key]
      }
      // A failed page leaves nothing for the next iteration to continue from.
      if (!this.pages[key]) return
    }
  }

  /** The cursor that opens a page: the one the page before it reported. */
  private cursorBefore(
    owner: string,
    repo: string,
    state: PrState,
    query: PrListQuery,
    page: number
  ): string | null {
    const previous = this.pages[prPageKey(owner, repo, state, query.filter, query.sort, page - 1)]
    return previous?.page.nextCursor ?? null
  }

  private async loadPullRequestPage(
    projectId: string,
    owner: string,
    repo: string,
    state: PrState,
    page: number,
    query: PrListQuery,
    cursor: string | null,
    key: string
  ): Promise<void> {
    this.markBusy('pr-list', true)
    try {
      const result = await invoke('pr:page', projectId, owner, repo, state, page, {
        filter: query.filter,
        sort: query.sort,
        cursor
      })
      this.pages = { ...this.pages, [key]: { page: result, fetchedAt: Date.now() } }
      delete this.failures[key]
    } catch (reason) {
      this.markFailure(key)
      this.setError(errorMessage(reason, 'Pull requests could not be loaded'))
    } finally {
      this.markBusy('pr-list', false)
    }
  }

  /** Load everything a PR detail view needs, serving cache first. */
  async ensurePullRequestBundle(
    projectId: string,
    owner: string,
    repo: string,
    pullNumber: number,
    force = false
  ): Promise<void> {
    if (!projectId) return
    const key = prBundleKey(owner, repo, pullNumber)
    const cached = this.bundles[key]
    if (!force && cached && Date.now() - cached.fetchedAt < PR_CACHE_TTL_MS) return
    if (!force && this.coolingDown(key)) return
    this.markBusy('pr-detail', true)
    try {
      const bundle = await invoke('pr:bundle', projectId, owner, repo, pullNumber)
      this.bundles = { ...this.bundles, [key]: bundle }
      delete this.failures[key]
    } catch (reason) {
      this.markFailure(key)
      this.setError(errorMessage(reason, 'Pull request could not be loaded'))
    } finally {
      this.markBusy('pr-detail', false)
    }
  }

  /**
   * Repository accounts that can be @-mentioned in a PR conversation.
   *
   * Called only when the user types `@`, and cache-first so a typed query does
   * not re-fetch per keystroke. Concurrent callers share one in-flight request
   * rather than racing, and a failure resolves to the stale cache (or an empty
   * list) so autocomplete degrades to the on-screen participants instead of
   * surfacing an error: the token may legitimately lack the permission this
   * needs, and a mention menu is not worth an error banner.
   */
  async mentionUsersFor(
    projectId: string,
    owner: string,
    repo: string
  ): Promise<RepositoryMentionUser[]> {
    if (!projectId || !owner || !repo) return []
    const key = `${owner}/${repo}`
    const cached = this.mentionUsers[key]
    if (cached && Date.now() - cached.fetchedAt < MENTION_USERS_TTL_MS) return cached.users
    const failedAt = this.mentionUsersFailedAt[key]
    if (!cached && failedAt !== undefined && Date.now() - failedAt < MENTION_USERS_RETRY_MS) {
      return []
    }
    const inFlight = this.mentionUsersInFlight[key]
    if (inFlight) return inFlight
    const request = invoke('pr:mentionUsers', projectId, owner, repo)
      .then((users) => {
        this.mentionUsers = { ...this.mentionUsers, [key]: { users, fetchedAt: Date.now() } }
        delete this.mentionUsersFailedAt[key]
        return users
      })
      .catch(() => {
        this.mentionUsersFailedAt[key] = Date.now()
        return cached?.users ?? []
      })
      .finally(() => {
        delete this.mentionUsersInFlight[key]
      })
    this.mentionUsersInFlight[key] = request
    return request
  }

  /** Files and patches for one commit inside a PR. */
  async getCommitFiles(
    projectId: string,
    owner: string,
    repo: string,
    sha: string
  ): Promise<PullRequestFile[]> {
    try {
      return await invoke('pr:commitFiles', projectId, owner, repo, sha)
    } catch (reason) {
      this.setError(errorMessage(reason, 'Commit files could not be loaded'))
      return []
    }
  }

  /** Read the agent's review report for a PR, if it has written one. */
  async loadAgentReport(projectId: string, pullNumber: number): Promise<PrAgentReport | null> {
    if (!projectId) return null
    try {
      const report = await invoke('pr:agentReport', projectId, pullNumber)
      this.agentReports = { ...this.agentReports, [String(pullNumber)]: report }
      return report
    } catch {
      return null
    }
  }
}
