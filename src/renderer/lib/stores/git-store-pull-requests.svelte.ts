import { invoke } from '$lib/ipc.svelte'
import type {
  PrAgentAssignmentInput,
  PrAgentAssignmentSummary,
  PrAgentAssignmentWorkspace,
  PrAgentReport,
  PrListQuery,
  PrState,
  PullRequestBundle,
  PullRequestFile,
  PullRequestLabel,
  PullRequestMilestone,
  PullRequestPage,
  PullRequestSummary,
  RepositoryMentionUser
} from '$shared/types'
import {
  MENTION_USERS_RETRY_MS,
  MENTION_USERS_TTL_MS,
  PR_CACHE_TTL_MS,
  PR_ERROR_COOLDOWN_MS,
  PR_PRELOAD_RETRY_MS,
  REPO_CATALOG_TTL_MS,
  errorMessage,
  prBundleKey,
  prPageKey,
  type GitOperation
} from './git-store-helpers'

/**
 * The fields of one cached pull request a successful mutation rewrites.
 *
 * Declared as a patch rather than as whole replacement rows because every writer
 * knows only what it changed: a close knows the state, a label write knows the
 * labels, and neither has a fresh row to substitute for the cached one.
 */
export interface CachedPullRequestPatch {
  state?: PullRequestSummary['state']
  draft?: boolean
  labels?: PullRequestLabel[]
  assignees?: RepositoryMentionUser[]
  milestone?: PullRequestMilestone | null
}

/** One cached listing page, with the filter it was fetched under. */
export interface CachedPullRequestPage {
  page: PullRequestPage
  fetchedAt: number
  /**
   * Which state filter produced this page. Kept beside the rows because a
   * lifecycle change lands differently in each listing, and the key alone would
   * force a string parse to find out which one a page is.
   */
  state: PrState
}

/**
 * Cached PR listings and detail bundles.
 *
 * The sidebar tab is mounted and unmounted every time the user switches tabs,
 * so without a store-level cache every visit would re-fetch and re-show a
 * spinner. Cached data renders immediately and is revalidated in the
 * background when it is older than `PR_CACHE_TTL_MS`.
 *
 * Cache-first is only half of it. `pr:bundle` is seven GitHub calls the user
 * pays for on every cold open, so the list also warms the entry under the
 * pointer before it is clicked. A warm-up is the same request the click would
 * have made, sharing one in-flight promise, and it stays invisible: no busy
 * state, no error banner, and no failure cooldown. See `preloadPullRequestBundle`.
 */
export class GitPullRequestCache {
  pages: Record<string, CachedPullRequestPage> = $state({})
  bundles: Record<string, PullRequestBundle> = $state({})
  /** Agent assignment reports per pull request number, newest first. */
  agentReports: Record<string, PrAgentReport[]> = $state({})
  /**
   * What the list knows about a row's agent assignments.
   *
   * Three states, and the difference matters: absent means the row has not been
   * asked about yet, `null` means it was asked about and holds no assignment, and
   * a summary means it holds at least one. Without the explicit `null` a page that
   * rendered before the read landed would ask about the same rows on every render.
   */
  agentAssignments: Record<string, PrAgentAssignmentSummary | null> = $state({})

  /**
   * Repository label and milestone catalogs, keyed by `owner/repo`. Read only if
   * a picker opens, so they are held apart from the pull request caches they are
   * read alongside.
   */
  labels: Record<string, { items: PullRequestLabel[]; fetchedAt: number }> = $state({})
  milestones: Record<string, { items: PullRequestMilestone[]; fetchedAt: number }> = $state({})

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

  /**
   * In-flight assignment-summary reads, keyed by the project and the numbers asked
   * about. The list is mounted twice (dock and fullscreen) and both mounts load the
   * same page, so without this the same read would be made twice over.
   */
  private assignmentRequests: Record<string, Promise<void> | undefined> = {}

  /** One request per page key, preventing duplicate IPC calls from concurrent mounts/effects. */
  private pageRequests: Record<string, Promise<void> | undefined> = {}

  /**
   * One `pr:bundle` request per key, so a hover warm-up and the click that
   * follows it are one round trip rather than two racing ones.
   */
  private bundleRequests: Record<string, Promise<PullRequestBundle> | undefined> = {}

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

  /**
   * Hold on to the rows a transient failure could not replace.
   *
   * A page that answers with `transientError` carries no rows, because the
   * request never completed. Storing it as-is would blank a listing the reader
   * is looking at, so the failure becomes a line above the rows already held
   * rather than a replacement for them. A later success replaces the whole page
   * and clears the line with it.
   */
  private keepRowsOnTransient(key: string, page: PullRequestPage): PullRequestPage {
    const previous = this.pages[key]?.page
    if (!page.transientError || !previous) return page
    // Only the rows carry over. The previous answer's own error does not: the
    // newest answer is this transient one, and an access failure it has since
    // recovered from must not outlive it.
    return {
      items: previous.items,
      page: page.page,
      hasMore: previous.hasMore,
      nextCursor: previous.nextCursor,
      transientError: page.transientError
    }
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
   * Rewrite one cached pull request in place, in every listing that holds it and
   * in its detail bundle.
   *
   * This is the whole coherence story for a metadata write: the server already
   * answered with the value it stored, so the cached row is corrected rather than
   * invalidated, and the list never has to refetch a page the user is reading.
   */
  patchPullRequest(
    owner: string,
    repo: string,
    pullNumber: number,
    patch: CachedPullRequestPatch
  ): void {
    const prefix = `${owner}/${repo}:`
    this.pages = Object.fromEntries(
      Object.entries(this.pages).map(([key, cached]) => [
        key,
        key.startsWith(prefix)
          ? {
              ...cached,
              page: {
                ...cached.page,
                items: cached.page.items.map((item) =>
                  item.number === pullNumber ? { ...item, ...patch } : item
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
        [bundleKey]: { ...bundle, detail: { ...bundle.detail, ...patch } }
      }
    }
  }

  /**
   * Apply a lifecycle state change across the cached listings.
   *
   * A page is cached under the state filter that produced it, so one close is not
   * one edit but a different edit per listing: the row leaves an `open` listing,
   * stays in an `all` listing carrying its new state, and cannot be placed
   * correctly in a `closed` one because its position there is the server's to
   * decide. Doing that here is what lets a batch of twenty closes drain the list
   * as it runs, instead of leaving twenty rows that no longer exist on screen
   * until the cache ages out.
   */
  applyPullRequestState(
    owner: string,
    repo: string,
    pullNumber: number,
    state: PullRequestSummary['state']
  ): void {
    const prefix = `${owner}/${repo}:`
    // A `closed` listing has always meant closed and merged alike on GitHub, and
    // `all` is the one listing with no state qualifier at all.
    const holds = (listing: PrState): boolean =>
      listing === 'all' || listing === state || (state === 'merged' && listing === 'closed')
    this.pages = Object.fromEntries(
      Object.entries(this.pages).map(([key, cached]) => {
        if (!key.startsWith(prefix)) return [key, cached]
        const without = cached.page.items.filter((item) => item.number !== pullNumber)
        if (!holds(cached.state)) {
          return [key, { ...cached, page: { ...cached.page, items: without } }]
        }
        if (without.length === cached.page.items.length) return [key, cached]
        return [
          key,
          {
            ...cached,
            page: {
              ...cached.page,
              items: cached.page.items.map((item) =>
                item.number === pullNumber ? { ...item, state } : item
              )
            }
          }
        ]
      })
    )
    const bundleKey = prBundleKey(owner, repo, pullNumber)
    const bundle = this.bundles[bundleKey]
    if (bundle) {
      this.bundles = {
        ...this.bundles,
        [bundleKey]: {
          ...bundle,
          detail: {
            ...bundle.detail,
            state,
            // A merged pull request is never a draft, and neither is a closed one:
            // the marker belongs to an open pull request that is not ready for
            // review yet, so leaving it set would draw a draft glyph on a row that
            // has finished.
            ...(state === 'open' ? {} : { draft: false })
          }
        }
      }
    }
  }

  /**
   * Load one repository catalog, cache-first.
   *
   * The label and milestone catalogs are the same problem twice: a small list that
   * changes slowly, read only when a picker opens, and never worth an error banner
   * because every other action on the pull request still works without it. `read`
   * is the only place they differ, so it is the only thing they do not share.
   */
  private async readCatalog<T>(
    cached: { items: T[]; fetchedAt: number } | undefined,
    store: (entry: { items: T[]; fetchedAt: number }) => void,
    read: () => Promise<T[]>
  ): Promise<T[]> {
    if (cached && Date.now() - cached.fetchedAt < REPO_CATALOG_TTL_MS) return cached.items
    this.markBusy('pr-catalog', true)
    try {
      const items = await read()
      store({ items, fetchedAt: Date.now() })
      return items
    } catch {
      // A picker that cannot list the catalog still opens, showing only what the
      // pull request already carries, which is better than an error it cannot act
      // on.
      return cached?.items ?? []
    } finally {
      this.markBusy('pr-catalog', false)
    }
  }

  /** The repository's own labels, for the label picker. */
  async repositoryLabels(
    projectId: string,
    owner: string,
    repo: string
  ): Promise<PullRequestLabel[]> {
    if (!projectId || !owner || !repo) return []
    const key = `${owner}/${repo}`
    return this.readCatalog(
      this.labels[key],
      (entry) => (this.labels = { ...this.labels, [key]: entry }),
      () => invoke('pr:labels', projectId, owner, repo)
    )
  }

  /** The repository's open milestones, for the milestone picker. */
  async repositoryMilestones(
    projectId: string,
    owner: string,
    repo: string
  ): Promise<PullRequestMilestone[]> {
    if (!projectId || !owner || !repo) return []
    const key = `${owner}/${repo}`
    return this.readCatalog(
      this.milestones[key],
      (entry) => (this.milestones = { ...this.milestones, [key]: entry }),
      () => invoke('pr:milestones', projectId, owner, repo)
    )
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
      await this.requestPage(projectId, owner, repo, state, index, query, cursor, key, false)
      // A failed page leaves nothing for the next iteration to continue from.
      if (!this.pages[key]) return
    }
  }

  /**
   * Warm the page behind Next, so pressing it renders from cache.
   *
   * Deliberately not `ensurePullRequestPage(page + 1)`: that walks every page
   * up to the target, so a hover on a listing whose earlier pages had aged out
   * would re-fetch all of them in sequence. Page N+1 needs one thing from page
   * N, which is its cursor, and nothing else.
   */
  async preloadPullRequestNextPage(
    projectId: string,
    owner: string,
    repo: string,
    state: PrState,
    page: number,
    query: PrListQuery
  ): Promise<void> {
    if (!projectId || !owner || !repo) return
    // No cached page means nothing to continue from yet: the load that fills it
    // pulls this one in behind it, so there is nothing to warm.
    const cursor =
      this.pages[prPageKey(owner, repo, state, query.filter, query.sort, page)]?.page.nextCursor ??
      null
    if (!cursor) return
    const key = prPageKey(owner, repo, state, query.filter, query.sort, page + 1)
    const cached = this.pages[key]
    if (cached && Date.now() - cached.fetchedAt < PR_CACHE_TTL_MS) return
    if (this.coolingDown(key) || this.preloadCoolingDown(key)) return
    await this.requestPage(projectId, owner, repo, state, page + 1, query, cursor, key, true)
  }

  /** One `pr:page` request per key, shared by the load and the hover warm-up. */
  private async requestPage(
    projectId: string,
    owner: string,
    repo: string,
    state: PrState,
    page: number,
    query: PrListQuery,
    cursor: string | null,
    key: string,
    silent: boolean
  ): Promise<void> {
    const existing = this.pageRequests[key]
    if (existing) {
      await existing
      return
    }
    const request = this.loadPullRequestPage(
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
    key: string,
    silent: boolean
  ): Promise<void> {
    if (!silent) this.markBusy('pr-list', true)
    try {
      const result = await invoke('pr:page', projectId, owner, repo, state, page, {
        filter: query.filter,
        sort: query.sort,
        cursor
      })
      // A warm-up that only learned GitHub is unreachable must not park a
      // transient page in the cache: it would read as a fresh page, and the
      // click it was warming would then skip the fetch it needs. Back the
      // hover off instead, the way a thrown failure used to.
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
      // The chips for these rows are read alongside the page, so a listing and its
      // assignment state arrive together rather than the rows changing under the
      // pointer a moment after they are drawn.
      void this.ensureAgentAssignments(
        projectId,
        result.items.map((item) => item.number)
      )
    } catch (reason) {
      if (silent) {
        this.preloadFailures[key] = Date.now()
      } else {
        this.markFailure(key)
        this.setError(errorMessage(reason, 'Pull requests could not be loaded'))
      }
    } finally {
      if (!silent) this.markBusy('pr-list', false)
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
      // A warm-up already in flight is this load's own request, so awaiting it
      // here is what turns hover-then-click into one round trip instead of two.
      await this.requestBundle(projectId, owner, repo, pullNumber, key)
    } catch (reason) {
      this.markFailure(key)
      this.setError(errorMessage(reason, 'Pull request could not be loaded'))
    } finally {
      this.markBusy('pr-detail', false)
    }
  }

  /**
   * Warm one pull request's detail bundle so the click that opens it renders
   * from cache, the way the skill marketplace warms a skill the pointer rests
   * on.
   *
   * A warm-up is invisible by design. It moves no busy state (the panel's
   * spinner belongs to the load the user asked for, not to a fetch they may
   * never open), it posts no error banner, and its failure is filed under its
   * own brief clock rather than the cooldown `ensurePullRequestBundle` reads.
   * That last part matters: a hover that failed must leave the click behind it
   * free to make its own attempt and report its own error.
   */
  async preloadPullRequestBundle(
    projectId: string,
    owner: string,
    repo: string,
    pullNumber: number
  ): Promise<void> {
    if (!projectId || !owner || !repo || pullNumber <= 0) return
    const key = prBundleKey(owner, repo, pullNumber)
    // Already warm, or already being fetched by the load this warm-up would
    // duplicate.
    if (this.bundles[key] || this.bundleRequests[key]) return
    if (this.coolingDown(key) || this.preloadCoolingDown(key)) return
    try {
      await this.requestBundle(projectId, owner, repo, pullNumber, key)
    } catch {
      this.preloadFailures[key] = Date.now()
    }
  }

  /** The single place `pr:bundle` is called: one request per key, cache on success. */
  private requestBundle(
    projectId: string,
    owner: string,
    repo: string,
    pullNumber: number,
    key: string
  ): Promise<PullRequestBundle> {
    const existing = this.bundleRequests[key]
    if (existing) return existing
    const request = invoke('pr:bundle', projectId, owner, repo, pullNumber)
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

  /** Read every agent assignment report a pull request holds, newest first. */
  async loadAgentReports(projectId: string, pullNumber: number): Promise<PrAgentReport[]> {
    if (!projectId) return []
    try {
      const reports = await invoke('pr:agentReports', projectId, pullNumber)
      this.agentReports = { ...this.agentReports, [String(pullNumber)]: reports }
      return reports
    } catch {
      return []
    }
  }

  /**
   * The agent assignment summaries a page of rows needs, in one batched read.
   *
   * A summary only ever changes when this app makes an assignment, and every one of
   * those goes through `recordAgentAssignment`, which patches the cache in place.
   * So a number is read once and then trusted: re-reading the disk for a chip that
   * cannot have moved would be work for nothing.
   */
  async ensureAgentAssignments(projectId: string, numbers: number[]): Promise<void> {
    if (!projectId || numbers.length === 0) return
    const missing = numbers.filter((number) => this.agentAssignments[String(number)] === undefined)
    if (missing.length === 0) return
    const key = `${projectId}:${missing.join(',')}`
    const existing = this.assignmentRequests[key]
    if (existing) {
      await existing
      return
    }
    const request = this.readAgentAssignments(projectId, missing)
    this.assignmentRequests[key] = request
    try {
      await request
    } finally {
      if (this.assignmentRequests[key] === request) delete this.assignmentRequests[key]
    }
  }

  private async readAgentAssignments(projectId: string, numbers: number[]): Promise<void> {
    try {
      const summaries = await invoke('pr:agentAssignments', projectId, numbers)
      const next = { ...this.agentAssignments }
      // A row with nothing on disk is cached as a known absence, so the next render
      // of the page does not ask about it again.
      for (const number of numbers) next[String(number)] = summaries[String(number)] ?? null
      this.agentAssignments = next
    } catch {
      // The chip is an accessory. A failed read leaves rows looking unassigned
      // rather than failing a listing that is already on screen.
    }
  }

  /**
   * Record an assignment the user just made, without re-reading the disk.
   *
   * The row chip and the reader's report list both read from here, so an assignment
   * shows the moment it exists rather than after the next page load. The report is
   * seeded empty: the agent has not written it yet.
   */
  recordAgentAssignment(
    pullNumber: number,
    threadId: string,
    input: PrAgentAssignmentInput,
    workspace: PrAgentAssignmentWorkspace
  ): void {
    const key = String(pullNumber)
    const current = this.agentAssignments[key] ?? null
    const assignedAt = Date.now()
    this.agentAssignments = {
      ...this.agentAssignments,
      [key]: {
        count: (current?.count ?? 0) + 1,
        threadId,
        title: input.title,
        createdAt: assignedAt
      }
    }
    const report: PrAgentReport = {
      id: workspace.id,
      kind: input.kind,
      title: input.title,
      path: workspace.reportPath,
      content: '',
      updatedAt: null,
      createdAt: assignedAt,
      threadId,
      url: input.url ?? null
    }
    this.agentReports = {
      ...this.agentReports,
      [key]: [report, ...(this.agentReports[key] ?? [])]
    }
  }
}
