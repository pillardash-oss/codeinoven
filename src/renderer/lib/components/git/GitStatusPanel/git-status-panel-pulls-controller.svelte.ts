import { copyText } from '$lib/copy-text'
import { openInBrowser } from '$lib/open-in-browser'
import { githubDisplayLogin } from '$lib/format/github-login'
import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
import { gitState, GitState } from '$lib/stores/git.svelte'
import { prBatchJobs } from '$lib/stores/pr-batch-jobs.svelte'
import { threadSettings } from '$lib/stores/thread-settings.svelte'
import type {
  PrListFilter,
  PrListSort,
  PrMergeMethod,
  PrState,
  PullRequestBundle,
  PullRequestSummary
} from '$shared/types'
import {
  PR_DETAIL_VIEWS,
  prViewCount,
  type PrDetailTabId,
  type PrListAction,
  type PrMetadataMode
} from '../pr-view'
import { prSummaryChatContext, prSummaryExplainPrompt } from '../git-status-panel-prompts'

/**
 * What the pull request surfaces need from the panel around them: the repository
 * they read, the account they read it as, and the two agent moves a row menu can
 * ask for.
 */
export interface GitStatusPanelPullsHost {
  readonly projectId: string
  readonly threadId: string
  readonly githubIdentity: { owner: string; repo: string } | null
  assignAgentToPullRequest(pr: PullRequestSummary): void
  openAgentThread(threadId: string): void
}

/** The persisted view state a remounted panel seeds its pull request view from. */
export interface GitStatusPanelPullsSeed {
  selectedPullRequest: PullRequestSummary | null
  prListState: PrState
  prListFilter: PrListFilter
  prListSort: PrListSort
}

/**
 * Full screen pull request reader. It mirrors the fullscreen terminal and
 * browser: the reader owns its own tab list, opens from the pull request
 * surfaces, and closes by clearing the active tab id. The list is a tab of its
 * own, so the reader can both browse and read without leaving fullscreen.
 */
const PR_READER_LIST_TAB = '__pullRequests__'

/**
 * The Pulls view and its surfaces: which pull requests are listed, what is open,
 * and every confirmation, picker and reader the rows can open.
 *
 * The list is mounted twice (the dock and the full screen reader) and both mounts
 * draw the same listing from this state, so a selection held inside the list
 * would let the two disagree about what a batch acts on.
 */
export class GitStatusPanelPullsController {
  readonly listTabId = PR_READER_LIST_TAB
  selectedPullRequest = $state<PullRequestSummary | null>(null)
  prListState = $state<PrState>('open')
  prListFilter = $state<PrListFilter>('all')
  prListSort = $state<PrListSort>('updated')
  prListPage = $state(1)
  prListSelection = $state<Record<number, boolean>>({})
  /**
   * The lifecycle batch waiting on its confirmation. It is only ever the pending
   * question: the run itself leaves as a background job (`prBatchJobs`), so nothing
   * here holds the window while twenty pull requests are written.
   */
  prBatch = $state<{ mode: 'close' | 'reopen'; targets: PullRequestSummary[] } | null>(null)
  /** The pull request a metadata picker is editing, or null when none is open. */
  prMetadata = $state<{ pr: PullRequestSummary; mode: PrMetadataMode } | null>(null)
  /** The merge a row menu asked for, with the method the user chose. */
  prMerge = $state<{ pr: PullRequestSummary; method: PrMergeMethod } | null>(null)
  prMergeOpen = $state(false)
  prMergeTitle = $state('')
  prMergeMessage = $state('')
  prMergeBusy = $state(false)
  /**
   * The view the detail reader is showing, mirrored so the header's check pill
   * can open Checks without reaching into the reader.
   */
  prDetailTab = $state<PrDetailTabId>('conversation')
  fullscreenPullRequests = $state<PullRequestSummary[]>([])
  fullscreenPullRequestId = $state<string | null>(null)
  readonly fullscreenPullRequestTabs = $derived([
    { id: PR_READER_LIST_TAB, title: 'All pull requests' },
    ...this.fullscreenPullRequests.map((pr) => ({
      id: String(pr.number),
      title: `#${pr.number} ${pr.title}`
    }))
  ])
  readonly fullscreenActivePullRequest = $derived(
    this.fullscreenPullRequestId && this.fullscreenPullRequestId !== PR_READER_LIST_TAB
      ? (this.fullscreenPullRequests.find(
          (pr) => String(pr.number) === this.fullscreenPullRequestId
        ) ?? null)
      : null
  )
  /**
   * The open pull request's fetched record. The reader reads the same bundle
   * from the store, so the panel's identity row and its pills cannot show one
   * thing while the reader shows another.
   */
  get pullRequestBundle(): PullRequestBundle | undefined {
    return this.bundleFor(this.host.githubIdentity, this.selectedPullRequest)
  }
  /**
   * The reader's views with their counts, for the switcher in the action row. The
   * counts come from the same bundle the reader renders, so the switcher and the
   * rail agree.
   */
  get prDetailViews() {
    return this.viewsFor(
      this.bundleFor(this.host.githubIdentity, this.selectedPullRequest),
      this.selectedPullRequest
    )
  }
  constructor(
    private readonly host: GitStatusPanelPullsHost,
    seed: GitStatusPanelPullsSeed
  ) {
    this.selectedPullRequest = seed.selectedPullRequest
    this.prListState = seed.prListState
    this.prListFilter = seed.prListFilter
    this.prListSort = seed.prListSort
  }

  /** Opens the reader, adding the pull request as a tab when it is not one yet. */
  openFullscreen(pr: PullRequestSummary | null): void {
    if (!pr) {
      this.fullscreenPullRequestId = PR_READER_LIST_TAB
      return
    }
    if (!this.fullscreenPullRequests.some((open) => open.number === pr.number)) {
      this.fullscreenPullRequests = [...this.fullscreenPullRequests, pr]
    }
    this.fullscreenPullRequestId = String(pr.number)
  }

  /**
   * Closes one reader tab, falling back to the last tab still open. The list is
   * the reader's home tab, so closing it closes the reader rather than leaving a
   * close button that does nothing.
   */
  closeFullscreenTab(id: string): void {
    if (id === PR_READER_LIST_TAB) {
      this.fullscreenPullRequestId = null
      return
    }
    const remaining = this.fullscreenPullRequests.filter((pr) => String(pr.number) !== id)
    this.fullscreenPullRequests = remaining
    if (this.fullscreenPullRequestId !== id) return
    const fallback = remaining.at(-1)
    this.fullscreenPullRequestId = fallback ? String(fallback.number) : PR_READER_LIST_TAB
  }

  /**
   * Switch which pull requests the PR view lists. The filter is the panel's, so
   * the page it belonged to goes with it: page 4 of the closed list has nothing
   * to do with page 4 of the open one. The selection goes with it for the same
   * reason: "close 5 selected" must never mean five rows the user can no longer see.
   */
  selectListState(next: PrState): void {
    if (next === this.prListState) return
    this.prListState = next
    this.prListPage = 1
    this.prListSelection = {}
  }

  /**
   * Switch which relationship the PR view keeps, or how it orders the result.
   * Both are the panel's, so the page goes with them: page 4 of "everything" has
   * nothing to do with page 4 of "authored by me".
   */
  selectListFilter(next: PrListFilter): void {
    if (next === this.prListFilter) return
    this.prListFilter = next
    this.prListPage = 1
    this.prListSelection = {}
  }

  selectListSort(next: PrListSort): void {
    if (next === this.prListSort) return
    this.prListSort = next
    this.prListPage = 1
    this.prListSelection = {}
  }

  /** A different page is a different set of rows, so the selection goes with it. */
  selectListPage(next: number): void {
    if (next === this.prListPage) return
    this.prListPage = next
    this.prListSelection = {}
  }

  /**
   * Where a pull request list action becomes something real.
   *
   * The list hands over one action plus the rows it applies to and knows nothing
   * else, which is what keeps the two mounts of the list identical and keeps every
   * confirmation, picker, and batch in the panel that owns the state behind them.
   */
  handleListAction(action: PrListAction): void {
    if (action.kind === 'open') {
      const target = action.targets[0]
      if (target) this.selectedPullRequest = target
      return
    }
    if (action.kind === 'open-in-browser') {
      const target = action.targets[0]
      if (target) void openInBrowser(target.url)
      return
    }
    if (action.kind === 'copy-links' || action.kind === 'copy-branches') {
      const text = action.targets
        .map((target) => (action.kind === 'copy-links' ? target.url : target.headRef))
        .join('\n')
      void copyText(text).catch(() => undefined)
      return
    }
    if (action.kind === 'close' || action.kind === 'reopen') {
      if (action.targets.length === 0) return
      this.prBatch = { mode: action.kind, targets: action.targets }
      return
    }
    const target = action.targets[0]
    if (!target) return
    if (action.kind === 'explain' || action.kind === 'quick-chat') {
      this.openChat(target, action.kind === 'explain' ? 'explain' : 'quick')
      return
    }
    if (action.kind === 'assign-agent') {
      this.host.assignAgentToPullRequest(target)
      return
    }
    if (action.kind === 'open-agent-thread') {
      this.host.openAgentThread(action.threadId)
      return
    }
    if (action.kind === 'mark-ready') {
      void this.markReady(target)
      return
    }
    if (action.kind === 'merge') {
      this.openMerge(target, action.method)
      return
    }
    this.prMetadata = { pr: target, mode: action.kind }
  }

  confirmBatch(comment: string | null): void {
    const pending = this.prBatch
    const identity = this.host.githubIdentity
    if (!pending || !identity) return
    prBatchJobs.start({
      projectId: this.host.projectId,
      owner: identity.owner,
      repo: identity.repo,
      mode: pending.mode,
      targets: pending.targets,
      comment
    })
    this.prBatch = null
    // The selection has been acted on, so it goes with the batch rather than
    // inviting a second close of the same rows.
    this.prListSelection = {}
  }

  /**
   * Anchor a read-only side chat on one pull request, the same panel the comment
   * actions open.
   *
   * The visible row is the selection and the pull request's own facts are the
   * pinned context, because a list row carries no transcript to ride and no diff to
   * quote. That gap is named in the context rather than papered over, so the agent
   * says what it cannot see instead of guessing.
   */
  private openChat(pr: PullRequestSummary, mode: 'explain' | 'quick'): void {
    const identity = this.host.githubIdentity
    if (!identity) return
    contextSidebarState.openTemporaryChat(
      this.host.projectId,
      this.host.threadId,
      mode === 'explain' ? 'elaborate' : 'quick',
      [
        `#${pr.number} ${pr.title}`,
        `by ${githubDisplayLogin(pr.authorLogin)} · ${pr.headRef} → ${pr.baseRef}`,
        pr.url
      ].join('\n'),
      prSummaryChatContext(pr, `${identity.owner}/${identity.repo}`),
      threadSettings.lastUsed,
      true,
      mode === 'explain' ? prSummaryExplainPrompt(pr) : undefined
    )
  }

  private async markReady(pr: PullRequestSummary): Promise<void> {
    const identity = this.host.githubIdentity
    if (!identity) return
    await gitState.markPullRequestReadyForReview(
      this.host.projectId,
      identity.owner,
      identity.repo,
      pr.number
    )
  }

  /**
   * Open the merge confirmation with the method the row menu chose.
   *
   * The title is seeded the way GitHub seeds it and the message is left empty: the
   * list never fetched the pull request body, and an empty message is what tells
   * GitHub to keep its own. Both are then the user's to edit before merging.
   */
  private openMerge(pr: PullRequestSummary, method: PrMergeMethod): void {
    this.prMergeTitle =
      method === 'merge' ? `Merge pull request #${pr.number} from ${pr.headRef}` : pr.title
    this.prMergeMessage = ''
    this.prMerge = { pr, method }
    this.prMergeOpen = true
  }

  async confirmMerge(): Promise<void> {
    const pending = this.prMerge
    const identity = this.host.githubIdentity
    if (!pending || !identity) return
    this.prMergeBusy = true
    try {
      const merged = await gitState.mergePullRequest(
        this.host.projectId,
        identity.owner,
        identity.repo,
        pending.pr.number,
        pending.method,
        pending.method === 'rebase' ? undefined : this.prMergeTitle.trim() || undefined,
        pending.method === 'rebase' ? undefined : this.prMergeMessage.trim() || undefined
      )
      if (merged) {
        // The row has left every open listing, so the selection it may have been
        // part of no longer describes anything on screen.
        this.prListSelection = {}
        this.prMerge = null
      }
    } finally {
      this.prMergeBusy = false
      this.prMergeOpen = false
    }
  }

  /**
   * One pull request's views with their counts, from a bundle this panel did not
   * necessarily fetch.
   */
  viewsFor(bundle: PullRequestBundle | undefined, summary: PullRequestSummary | null) {
    return PR_DETAIL_VIEWS.filter(
      (view) => view.id !== 'stacks' || (bundle?.stack?.length ?? 0) > 1
    ).map((view) => ({
      ...view,
      count: prViewCount(
        view.id,
        bundle,
        summary ? (gitState.prAgentReports[String(summary.number)]?.length ?? 0) : 0
      )
    }))
  }

  /**
   * One pull request's fetched record, for whoever is reading it.
   *
   * A function rather than a second derived value because two readers ask for it:
   * the Pulls view for the pull request it has open, and the Notifications view for
   * the one a notification names, which lives in the repository the notification
   * came from. The store keys bundles by repository and number, so the same call
   * serves both.
   */
  bundleFor(
    identity: { owner: string; repo: string } | null,
    summary: PullRequestSummary | null
  ): PullRequestBundle | undefined {
    return identity && summary
      ? gitState.prBundles[GitState.bundleKey(identity.owner, identity.repo, summary.number)]
      : undefined
  }
}
