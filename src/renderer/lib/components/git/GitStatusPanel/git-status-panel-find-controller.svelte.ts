import { formatCompactAge } from '$shared/date-time-format'
import { gitState } from '$lib/stores/git.svelte'
import { githubNotifications } from '$lib/stores/github-notifications.svelte'
import { findNavState } from '$lib/stores/find-nav.svelte'
import { issuePanelView } from '$lib/stores/issue-panel-view.svelte'
import type { GitPanelTabId } from '$lib/stores/git-panel-view.svelte'
import type {
  GitBranchInfo,
  GitCommitInfo,
  GitHubDeployment,
  GitHubWorkflowRun,
  GitStashEntry,
  PrState,
  PullRequestSummary
} from '$shared/types'
import {
  GIT_FIND_WORDS,
  gitFindScopeFor,
  type GitFindRow,
  type GitFindScope
} from '../git-panel-find'

/**
 * What the find bar needs from the panel it searches.
 *
 * Every row a search answers with is a thing the view in focus can already open,
 * so the panel supplies the opening and the bar stays a reader of results rather
 * than a second navigator with its own ideas about where a row belongs.
 */
export interface GitStatusPanelFindHost {
  readonly projectId: string
  readonly activeTab: GitPanelTabId
  readonly githubIdentity: { owner: string; repo: string } | null
  readonly prListState: PrState
  openCommit(commit: GitCommitInfo): void
  requestCheckout(branch: GitBranchInfo): void
  openPullRequest(pr: PullRequestSummary): void
  openRun(run: GitHubWorkflowRun): void
  openDeployment(deployment: GitHubDeployment): void
  openStash(stash: GitStashEntry): void
}

/**
 * The panel's Find bar: the query, the rows it answered with, and the row the
 * keyboard is on.
 *
 * The bar follows the view in focus, so what it searches is derived from the
 * tab rather than chosen here, and a subject change drops the answers that
 * belonged to the previous one.
 */
export class GitStatusPanelFindController {
  query = $state('')
  rows = $state.raw<GitFindRow[]>([])
  loading = $state(false)
  activeIndex = $state(0)
  requestId = 0
  /** Why the last search could not be answered, when it could not. */
  error = $state<string | null>(null)
  /** How many matches the bar offers: a find is a jump to one item, not a listing. */
  readonly limit = 20
  /** What the bar searches, which the view in focus decides. */
  readonly scope: GitFindScope
  readonly words: (typeof GIT_FIND_WORDS)[GitFindScope]
  private readonly host: GitStatusPanelFindHost

  constructor(host: GitStatusPanelFindHost) {
    this.host = host
    this.scope = $derived.by(() => gitFindScopeFor(host.activeTab))
    this.words = $derived.by(() => GIT_FIND_WORDS[this.scope])
  }

  open(): void {
    findNavState.openGitFind()
  }

  close(): void {
    this.requestId++
    this.query = ''
    this.rows = []
    this.loading = false
    this.activeIndex = 0
    this.error = null
    findNavState.closeGitFind()
  }

  /**
   * Drop what the previous view answered, keeping the bar open.
   *
   * Switching views switches the subject of the search, and results from the old
   * subject would be a list of things this view does not show.
   */
  resetResults(): void {
    this.requestId++
    this.query = ''
    this.rows = []
    this.loading = false
    this.activeIndex = 0
    this.error = null
  }

  async run(rawQuery: string): Promise<void> {
    const query = rawQuery.trim()
    this.query = query
    this.activeIndex = 0
    this.error = null
    const requestId = ++this.requestId
    if (!query) {
      this.rows = []
      this.loading = false
      return
    }

    this.rows = []
    this.loading = true
    try {
      const rows = await this.rowsFor(this.scope, query)
      if (requestId !== this.requestId) return
      this.rows = rows
    } catch (reason) {
      if (requestId !== this.requestId) return
      this.rows = []
      this.error = reason instanceof Error ? reason.message : 'The search could not be run'
    } finally {
      if (requestId === this.requestId) this.loading = false
    }
  }

  /**
   * The rows the active view's search answers with.
   *
   * Every scope reads the same data its view draws, so a result is a thing the
   * view can open: the commit list reads commits, the PR search asks GitHub for
   * `is:pr`, and the views whose lists are already resident filter what is loaded
   * rather than making a request per keystroke.
   */
  async rowsFor(scope: GitFindScope, query: string): Promise<GitFindRow[]> {
    switch (scope) {
      case 'commits': {
        const commits = await gitState.getLog(this.host.projectId, 50, 0, query)
        return commits.map((commit) => ({
          kind: 'commit',
          key: commit.hash,
          title: commit.message.split('\n')[0] ?? commit.shortHash,
          detail: `${commit.shortHash} · ${commit.author} · ${formatCompactAge(commit.date)}`,
          commit
        }))
      }
      case 'branches': {
        const needle = query.toLowerCase()
        return gitState.branches
          .filter(
            (branch) =>
              branch.name.toLowerCase().includes(needle) ||
              branch.ref.toLowerCase().includes(needle)
          )
          .slice(0, this.limit)
          .map((branch) => ({
            kind: 'branch',
            key: branch.ref,
            title: branch.name,
            detail: branch.remote ? `${branch.remote} · ${branch.kind}` : branch.kind,
            badge: branch.current ? 'current' : undefined,
            branch
          }))
      }
      case 'pulls': {
        const identity = this.requireIdentity('pull requests')
        const pulls = await gitState.searchPullRequests(
          this.host.projectId,
          identity.owner,
          identity.repo,
          this.host.prListState,
          query
        )
        return pulls.map((pull) => ({
          kind: 'pull',
          key: String(pull.number),
          title: `#${String(pull.number)} ${pull.title}`,
          detail: `${pull.headRef} → ${pull.baseRef} · @${pull.authorLogin}`,
          badge: pull.state,
          pull
        }))
      }
      case 'issues': {
        const identity = this.requireIdentity('issues')
        const issues = await gitState.searchIssueCandidates(
          this.host.projectId,
          identity.owner,
          identity.repo,
          query
        )
        return issues.map((issue) => ({
          kind: 'issue',
          key: String(issue.number),
          title: `#${String(issue.number)} ${issue.title}`,
          detail: `@${issue.authorLogin} · ${formatCompactAge(Date.parse(issue.updatedAt))}`,
          badge: issue.state,
          issue
        }))
      }
      case 'notifications': {
        const needle = query.toLowerCase()
        return githubNotifications.items
          .filter((item) =>
            `${item.title} ${item.repositoryFullName}`.toLowerCase().includes(needle)
          )
          .slice(0, this.limit)
          .map((notification) => ({
            kind: 'notification',
            key: notification.id,
            title: notification.title,
            detail: `${notification.repositoryFullName} · ${formatCompactAge(Date.parse(notification.updatedAt))}`,
            badge: notification.unread ? 'unread' : undefined,
            notification
          }))
      }
      case 'stashes': {
        const needle = query.toLowerCase()
        return gitState.stashes
          .filter((stash) =>
            `${stash.message} ${stash.branch ?? ''}`.toLowerCase().includes(needle)
          )
          .slice(0, this.limit)
          .map((stash) => ({
            kind: 'stash',
            key: stash.id,
            title: stash.message,
            detail: stash.branch ? `${stash.id} · ${stash.branch}` : stash.id,
            badge: formatCompactAge(stash.date),
            stash
          }))
      }
      case 'deployments': {
        const identity = this.requireIdentity('deploys')
        const prefix = `${identity.owner}/${identity.repo}#`
        const needle = query.toLowerCase()
        const runs: GitHubWorkflowRun[] = []
        const seenRuns: Record<number, true> = {}
        for (const [key, cached] of Object.entries(gitState.deploymentRunPages)) {
          if (!key.startsWith(`${prefix}runs:`)) continue
          for (const run of cached.page.items) {
            if (seenRuns[run.id]) continue
            seenRuns[run.id] = true
            runs.push(run)
          }
        }
        const deployments: GitHubDeployment[] = []
        const seenDeployments: Record<number, true> = {}
        for (const [key, cached] of Object.entries(gitState.deploymentPages)) {
          if (!key.startsWith(`${prefix}deployments:`)) continue
          for (const deployment of cached.page.items) {
            if (seenDeployments[deployment.id]) continue
            seenDeployments[deployment.id] = true
            deployments.push(deployment)
          }
        }
        const runRows: GitFindRow[] = runs
          .filter((run) =>
            `${run.displayTitle} ${run.name} ${run.branch} ${run.headSha}`
              .toLowerCase()
              .includes(needle)
          )
          .map((run) => ({
            kind: 'run',
            key: `run-${String(run.id)}`,
            title: run.displayTitle || run.name,
            detail: `${run.name} · ${run.branch} · ${run.headSha.slice(0, 7)}`,
            badge: run.conclusion ?? run.status,
            run
          }))
        const deploymentRows: GitFindRow[] = deployments
          .filter((deployment) =>
            `${deployment.environment} ${deployment.ref} ${deployment.sha}`
              .toLowerCase()
              .includes(needle)
          )
          .map((deployment) => ({
            kind: 'deployment',
            key: `deployment-${String(deployment.id)}`,
            title: deployment.environment,
            detail: `${deployment.ref} · ${deployment.sha.slice(0, 7)}`,
            badge: deployment.latestStatus?.state,
            deployment
          }))
        return [...runRows, ...deploymentRows].slice(0, this.limit)
      }
    }
  }

  /**
   * The repository a GitHub-backed search reads from, or the reason there is none.
   *
   * A view that searches GitHub has nothing to search when origin is not a GitHub
   * remote, and an empty answer would claim the repository holds no matches.
   */
  private requireIdentity(subject: string): { owner: string; repo: string } {
    const identity = this.host.githubIdentity
    if (!identity)
      throw new Error(`Git origin is not a GitHub repository, so ${subject} cannot be searched`)
    return identity
  }

  move(direction: -1 | 1): void {
    if (this.rows.length === 0) return
    this.activeIndex = (this.activeIndex + direction + this.rows.length) % this.rows.length
  }

  openActiveResult(): void {
    const row = this.rows[this.activeIndex]
    if (!row) return
    this.selectRow(row)
  }

  /**
   * Open the row the bar answered with, in the view it came from.
   *
   * Each kind has one action the view already offers for that kind of row: a
   * commit opens its diff, a pull request opens the reader, and a deploy opens the
   * record the Deployments view shows.
   */
  selectRow(row: GitFindRow): void {
    this.close()
    switch (row.kind) {
      case 'commit':
        this.host.openCommit(row.commit)
        return
      case 'branch':
        this.host.requestCheckout(row.branch)
        return
      case 'pull':
        this.host.openPullRequest(row.pull)
        return
      case 'issue':
        issuePanelView.set(this.host.projectId, {
          ...issuePanelView.get(this.host.projectId),
          selectedIssue: row.issue
        })
        return
      case 'notification':
        githubNotifications.openThread(row.notification)
        return
      case 'run':
        this.host.openRun(row.run)
        return
      case 'deployment':
        this.host.openDeployment(row.deployment)
        return
      case 'stash':
        this.host.openStash(row.stash)
        return
    }
  }
}
