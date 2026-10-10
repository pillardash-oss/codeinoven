import { invoke } from '$lib/ipc.svelte'
import type {
  IssueBundle,
  IssueLabel,
  IssueListQuery,
  IssueMilestone,
  IssuePage,
  IssueStateReason,
  IssueSummary,
  PrState,
  RepositoryMentionUser
} from '$shared/types'
import {
  PR_CACHE_TTL_MS,
  PR_ERROR_COOLDOWN_MS,
  PR_PRELOAD_RETRY_MS,
  errorMessage,
  issueBundleKey,
  issuePageKey,
  type GitOperation
} from './git-store-helpers'

/**
 * The fields of one cached issue a successful mutation rewrites.
 *
 * Declared as a patch rather than as a whole replacement row because every writer
 * knows only what it changed: a close knows the state, a label write knows the
 * labels, and neither has a fresh row to substitute for the cached one.
 */
export interface CachedIssuePatch {
  state?: IssueSummary['state']
  stateReason?: IssueStateReason | null
  labels?: IssueLabel[]
  assignees?: RepositoryMentionUser[]
  milestone?: IssueMilestone | null
}

/** One cached listing page, with the state filter it was fetched under. */
export interface CachedIssuePage {
  page: IssuePage
  fetchedAt: number
  state: PrState
}

/**
 * Cached issue listings and detail bundles.
 *
 * The sidebar tab is unmounted every time the user switches tabs, so without a
 * store-level cache every visit would re-fetch and re-show a spinner. Cached data
 * renders immediately and is revalidated in the background when it is older than
 * `PR_CACHE_TTL_MS` (one clock for both GitHub listings, since they age the same
 * way). The list also warms the entry under the pointer before it is clicked, and
 * a warm-up is the same request the click would have made, sharing one in-flight
 * promise, staying invisible: no busy state, no error banner, no failure cooldown.
 */
export class GitIssueCache {
  pages: Record<string, CachedIssuePage> = $state({})
  bundles: Record<string, IssueBundle> = $state({})

  /**
   * Epoch ms of the last failure per cache key. Deliberately plain (not `$state`)
   * - it only gates fetching, and making it reactive would feed the very effects
   * that triggered the request.
   */
  private failures: Record<string, number> = {}

  /** One request per page key, preventing duplicate IPC calls from concurrent mounts. */
  private pageRequests: Record<string, Promise<void> | undefined> = {}

  /** One `issue:bundle` request per key, so a warm-up and the click are one round trip. */
  private bundleRequests: Record<string, Promise<IssueBundle> | undefined> = {}

  /**
   * Warm-ups that failed, per key. Plain rather than `$state` because nothing
   * renders from it: it only stops a pointer parked on a broken row from
   * re-requesting on every pass. Kept apart from `failures` on purpose, which
   * gates the load the user actually asked for.
   */
  private preloadFailures: Record<string, number> = {}

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

  /** True while a recent warm-up for this key failed, so hover backs off it. */
  private preloadCoolingDown(key: string): boolean {
    const failedAt = this.preloadFailures[key]
    if (failedAt === undefined) return false
    if (Date.now() - failedAt < PR_PRELOAD_RETRY_MS) return true
    delete this.preloadFailures[key]
    return false
  }

  /**
   * Hold on to the rows a transient failure could not replace.
   *
   * A page that answers with `transientError` carries no rows, because the request
   * never completed. Storing it as-is would blank a listing the reader is looking
   * at, so the failure becomes a line above the rows already held rather than a
   * replacement for them.
   */
  private keepRowsOnTransient(key: string, page: IssuePage): IssuePage {
    const previous = this.pages[key]?.page
    if (!page.transientError || !previous) return page
    return {
      items: previous.items,
      page: page.page,
      hasMore: previous.hasMore,
      nextCursor: previous.nextCursor,
      transientError: page.transientError
    }
  }

  /**
   * Rewrite one cached issue in place, in every listing that holds it and in its
   * detail bundle.
   *
   * This is the coherence story for a metadata or state write: the server already
   * answered with the value it stored, so the cached row is corrected rather than
   * invalidated, and the list never has to refetch a page the user is reading.
   */
  patchIssue(owner: string, repo: string, issueNumber: number, patch: CachedIssuePatch): void {
    const apply = (issue: IssueSummary): IssueSummary => ({ ...issue, ...patch })
    let changed = false
    const pages: Record<string, CachedIssuePage> = {}
    for (const [key, entry] of Object.entries(this.pages)) {
      const index = entry.page.items.findIndex((item) => item.number === issueNumber)
      if (index < 0) {
        pages[key] = entry
        continue
      }
      changed = true
      const items = entry.page.items.slice()
      const current = items[index]
      if (current) items[index] = apply(current)
      pages[key] = { ...entry, page: { ...entry.page, items } }
    }
    if (changed) this.pages = pages

    const bundleKey = issueBundleKey(owner, repo, issueNumber)
    const bundle = this.bundles[bundleKey]
    if (bundle) {
      this.bundles = {
        ...this.bundles,
        [bundleKey]: { ...bundle, detail: { ...bundle.detail, ...patch } }
      }
    }
  }

  /** Load every page up to `page`, serving cache first. */
  async ensureIssuePage(
    projectId: string,
    owner: string,
    repo: string,
    state: PrState,
    page: number,
    query: IssueListQuery,
    force = false
  ): Promise<void> {
    if (!projectId || !owner || !repo) return
    for (let index = 1; index <= page; index += 1) {
      const key = issuePageKey(owner, repo, state, query.filter, query.sort, index)
      const cached = this.pages[key]
      if (!force && cached && Date.now() - cached.fetchedAt < PR_CACHE_TTL_MS) continue
      if (!force && this.coolingDown(key)) return
      // A pagination cursor is the only way into a later page, and the provider
      // hands one out only while the listing has more. Absent one, this page does
      // not exist and asking for it would return the first page's rows.
      const cursor = index > 1 ? this.cursorBefore(owner, repo, state, query, index) : null
      if (index > 1 && !cursor) return
      await this.requestPage(projectId, owner, repo, state, index, query, cursor, key, false)
      // A failed page leaves nothing for the next iteration to continue from.
      if (!this.pages[key]) return
    }
  }

  /**
   * Warm the page behind Next, so pressing it renders from cache.
   *
   * Deliberately not `ensureIssuePage(page + 1)`: that walks every page up to the
   * target. Page N+1 needs one thing from page N, which is its cursor.
   */
  async preloadIssueNextPage(
    projectId: string,
    owner: string,
    repo: string,
    state: PrState,
    page: number,
    query: IssueListQuery
  ): Promise<void> {
    if (!projectId || !owner || !repo) return
    const cursor =
      this.pages[issuePageKey(owner, repo, state, query.filter, query.sort, page)]?.page
        .nextCursor ?? null
    if (!cursor) return
    const key = issuePageKey(owner, repo, state, query.filter, query.sort, page + 1)
    const cached = this.pages[key]
    if (cached && Date.now() - cached.fetchedAt < PR_CACHE_TTL_MS) return
    if (this.coolingDown(key) || this.preloadCoolingDown(key)) return
    await this.requestPage(projectId, owner, repo, state, page + 1, query, cursor, key, true)
  }

  /** One `issue:page` request per key, shared by the load and the hover warm-up. */
  private async requestPage(
    projectId: string,
    owner: string,
    repo: string,
    state: PrState,
    page: number,
    query: IssueListQuery,
    cursor: string | null,
    key: string,
    silent: boolean
  ): Promise<void> {
    const existing = this.pageRequests[key]
    if (existing) {
      await existing
      return
    }
    const request = this.loadIssuePage(
      projectId,
      owner,
      repo,
      state,
      page,
      query,
      cursor,
      key,
      silent
    )
    this.pageRequests[key] = request
    try {
      await request
    } finally {
      if (this.pageRequests[key] === request) delete this.pageRequests[key]
    }
  }

  /** The cursor that opens a page: the one the page before it reported. */
  private cursorBefore(
    owner: string,
    repo: string,
    state: PrState,
    query: IssueListQuery,
    page: number
  ): string | null {
    const previous =
      this.pages[issuePageKey(owner, repo, state, query.filter, query.sort, page - 1)]
    return previous?.page.nextCursor ?? null
  }

  private async loadIssuePage(
    projectId: string,
    owner: string,
    repo: string,
    state: PrState,
    page: number,
    query: IssueListQuery,
    cursor: string | null,
    key: string,
    silent: boolean
  ): Promise<void> {
    if (!silent) this.markBusy('issue-list', true)
    try {
      const result = await invoke('issue:page', projectId, owner, repo, state, page, {
        filter: query.filter,
        sort: query.sort,
        cursor
      })
      // A warm-up that only learned GitHub is unreachable must not park a
      // transient page in the cache: the click it was warming would then skip the
      // fetch it needs. Back the hover off instead.
      if (silent && result.transientError) {
        this.preloadFailures[key] = Date.now()
        return
      }
      this.pages = {
        ...this.pages,
        [key]: { page: this.keepRowsOnTransient(key, result), fetchedAt: Date.now(), state }
      }
      delete this.failures[key]
      delete this.preloadFailures[key]
    } catch (reason) {
      if (silent) {
        this.preloadFailures[key] = Date.now()
      } else {
        this.markFailure(key)
        this.setError(errorMessage(reason, 'Issues could not be loaded'))
      }
    } finally {
      if (!silent) this.markBusy('issue-list', false)
    }
  }

  /** Load everything an issue detail view needs, serving cache first. */
  async ensureIssueBundle(
    projectId: string,
    owner: string,
    repo: string,
    issueNumber: number,
    force = false
  ): Promise<void> {
    if (!projectId || !owner || !repo || issueNumber <= 0) return
    const key = issueBundleKey(owner, repo, issueNumber)
    const cached = this.bundles[key]
    if (!force && cached && Date.now() - cached.fetchedAt < PR_CACHE_TTL_MS) return
    if (!force && this.coolingDown(key)) return
    this.markBusy('issue-detail', true)
    try {
      await this.requestBundle(projectId, owner, repo, issueNumber, key)
    } catch (reason) {
      this.markFailure(key)
      this.setError(errorMessage(reason, 'Issue could not be loaded'))
    } finally {
      this.markBusy('issue-detail', false)
    }
  }

  /** Warm one issue's detail bundle so the click that opens it renders from cache. */
  async preloadIssueBundle(
    projectId: string,
    owner: string,
    repo: string,
    issueNumber: number
  ): Promise<void> {
    if (!projectId || !owner || !repo || issueNumber <= 0) return
    const key = issueBundleKey(owner, repo, issueNumber)
    if (this.bundles[key] || this.bundleRequests[key]) return
    if (this.coolingDown(key) || this.preloadCoolingDown(key)) return
    try {
      await this.requestBundle(projectId, owner, repo, issueNumber, key)
    } catch {
      this.preloadFailures[key] = Date.now()
    }
  }

  /** The single place `issue:bundle` is called: one request per key, cache on success. */
  private requestBundle(
    projectId: string,
    owner: string,
    repo: string,
    issueNumber: number,
    key: string
  ): Promise<IssueBundle> {
    const existing = this.bundleRequests[key]
    if (existing) return existing
    const request = invoke('issue:bundle', projectId, owner, repo, issueNumber)
      .then((bundle) => {
        this.bundles = { ...this.bundles, [key]: bundle }
        delete this.failures[key]
        delete this.preloadFailures[key]
        return bundle
      })
      .finally(() => {
        if (this.bundleRequests[key] === request) delete this.bundleRequests[key]
      })
    this.bundleRequests[key] = request
    return request
  }
}
