import { invoke } from '$lib/ipc.svelte'
import { APP_SLUG } from '$shared/brand'
import type { GitRemoteInfo, PullRequestSummary } from '$shared/types'
import { parseGitHubRepo } from './git-store-helpers'

/** How fresh a successful PR conflict check is before it is refetched. */
const PR_ISSUE_FRESHNESS_MS = 60_000

/** Persisted open-PR conflict indicators, keyed by `owner/repo`. */
const PR_CONFLICTS_STORAGE_KEY = `${APP_SLUG}.prConflicts.v2`

export function loadStoredPrConflicts(): Record<string, PullRequestSummary[]> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(PR_CONFLICTS_STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null) return {}
    const result: Record<string, PullRequestSummary[]> = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (!Array.isArray(value)) continue
      const prs: PullRequestSummary[] = []
      for (const entry of value) {
        if (typeof entry !== 'object' || entry === null) continue
        const record = entry as Record<string, unknown>
        if (typeof record['number'] !== 'number' || record['number'] <= 0) continue
        prs.push({
          number: record['number'],
          title:
            typeof record['title'] === 'string'
              ? record['title']
              : `Pull request #${record['number']}`,
          url: typeof record['url'] === 'string' ? record['url'] : '',
          state:
            record['state'] === 'closed' || record['state'] === 'merged' ? record['state'] : 'open',
          draft: record['draft'] === true,
          authorLogin:
            typeof record['authorLogin'] === 'string' ? record['authorLogin'] : 'unknown',
          headRef: typeof record['headRef'] === 'string' ? record['headRef'] : '',
          baseRef: typeof record['baseRef'] === 'string' ? record['baseRef'] : '',
          createdAt: typeof record['createdAt'] === 'string' ? record['createdAt'] : '',
          updatedAt: typeof record['updatedAt'] === 'string' ? record['updatedAt'] : '',
          comments: typeof record['comments'] === 'number' ? record['comments'] : 0,
          mergeable: false,
          mergeableState: 'dirty'
        })
      }
      result[key] = prs
    }
    return result
  } catch {
    return {}
  }
}

/**
 * The open-PR conflict indicators every subscribed surface reads from.
 *
 * The store owns one instance so the header button, the PR list rows and the
 * PR detail always show exactly the same state. Results are seeded from local
 * storage so a restart does not lose the badge, then kept current by
 * connection-gated refreshes.
 */
export class GitPrConflictIndicators {
  /**
   * Open PRs that need conflict resolution, keyed by `owner/repo`. This is the
   * single source of truth every subscribed surface (header button, PR list
   * rows, PR detail) reads from - seeded from local storage so it survives a
   * restart, then kept current by the store's own connection-gated refreshes.
   */
  byRepo: Record<string, PullRequestSummary[]> = $state(loadStoredPrConflicts())
  /** When the conflict check last SUCCEEDED per repo - set only on success. */
  private fetchedAt: Record<string, number> = {}
  /** In-flight conflict checks per project, so concurrent refreshes share one. */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  private readonly checks = new Map<string, Promise<void>>()

  constructor(
    private readonly getRemotes: () => GitRemoteInfo[],
    private readonly getActiveProjectId: () => string | null,
    private readonly ensureConnection: () => Promise<boolean>
  ) {}

  /**
   * Number of open PRs with merge conflicts for the active project's origin
   * remote. Read from the persisted indicator so it's available immediately
   * on app restart; kept current by the store's connection-gated refreshes.
   */
  get activeCount(): number {
    const repo = this.originRepo
    if (!repo) return 0
    return (this.byRepo[`${repo.owner}/${repo.repo}`] ?? []).length
  }

  /**
   * Whether an open PR currently needs conflict resolution. All indicator UI
   * (header button, PR list rows, PR detail) reads this one store-owned fact,
   * so every subscribed surface shows exactly the same state.
   */
  hasIssue(owner: string, repo: string, pullNumber: number): boolean {
    return (this.byRepo[`${owner}/${repo}`] ?? []).some((pr) => pr.number === pullNumber)
  }

  /** `{ owner, repo }` parsed from the active project's origin remote URL. */
  private get originRepo(): { owner: string; repo: string } | null {
    const remotesList = Array.isArray(this.getRemotes()) ? this.getRemotes() : []
    const origin = remotesList.find((remote) => remote.name === 'origin')
    if (!origin) return null
    return parseGitHubRepo(origin.url)
  }

  /**
   * Refresh the open-PR conflict indicator for the active project. Gated on
   * the GitHub connection - the store guarantees the connection before any
   * online operation, so this never runs (or records anything) before GitHub
   * is reachable. A fresh successful result is served without a round trip; a
   * failed check records nothing, so the next event simply tries again.
   *
   * `force` bypasses the freshness window for explicit user mutations (push,
   * PR create/merge/reopen/close) that directly change mergeability - those
   * must always re-check immediately.
   */
  async refresh(projectId: string, force = false): Promise<void> {
    const repo = this.originRepo
    if (!repo || projectId !== this.getActiveProjectId()) return
    const key = `${repo.owner}/${repo.repo}`
    if (!force && Date.now() - (this.fetchedAt[key] ?? 0) < PR_ISSUE_FRESHNESS_MS) return
    const inflight = this.checks.get(projectId)
    if (inflight) return inflight
    const check = this.runCheck(projectId, repo.owner, repo.repo, key)
    this.checks.set(projectId, check)
    try {
      await check
    } finally {
      if (this.checks.get(projectId) === check) this.checks.delete(projectId)
    }
  }

  private async runCheck(
    projectId: string,
    owner: string,
    repo: string,
    key: string
  ): Promise<void> {
    if (!(await this.ensureConnection())) return
    try {
      // The conflict probe wants the plainest listing there is: every open pull
      // request, newest first, no relationship filter.
      const page = await invoke('pr:page', projectId, owner, repo, 'open', 1, {
        filter: 'all',
        sort: 'updated',
        cursor: null
      })
      // A page GitHub could not answer proves nothing about conflicts, so an
      // access failure and a transient transport failure both leave the last
      // known conflict state alone.
      if (page.accessError || page.transientError) return
      // `mergeable` is frequently null in list payloads (GitHub computes it
      // lazily); `mergeable_state` (e.g. `dirty`) is the reliable list signal,
      // so a PR counts if either flags it. PRs with no computed state probe
      // the detail endpoint, which forces GitHub to compute mergeability.
      const conflicted = page.items.filter(
        (item) => item.mergeable === false || item.mergeableState === 'dirty'
      )
      const uncomputed = page.items.filter(
        (item) => item.mergeable === null && item.mergeableState !== 'dirty'
      )
      for (const pr of uncomputed) {
        try {
          const detail = await invoke('pr:detail', projectId, owner, repo, pr.number)
          // null means the provider request failed (timeout, rate limit) -
          // treat it as "mergeability unknown" and skip this PR.
          if (detail?.mergeable === false) conflicted.push(pr)
        } catch {
          // A single PR failing its probe must not discard the whole check.
        }
      }
      this.byRepo = { ...this.byRepo, [key]: conflicted }
      this.fetchedAt[key] = Date.now()
      try {
        window.localStorage.setItem(
          PR_CONFLICTS_STORAGE_KEY,
          JSON.stringify(
            Object.fromEntries(
              Object.entries(this.byRepo).map(([repoKey, prs]) => [
                repoKey,
                prs.map((pr) => ({ number: pr.number, title: pr.title }))
              ])
            )
          )
        )
      } catch {
        // Persistence is best-effort - an unavailable store must not break the badge.
      }
    } catch {
      // GitHub unreachable - keep the last known result. Nothing is persisted
      // and no freshness is recorded, so the next poll retries.
    }
  }
}
