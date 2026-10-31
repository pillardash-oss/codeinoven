import type { PullRequestSummary } from '$shared/types'
import type { GitStatusPanel } from './GitStatusPanel-board.svelte'
import { BoardUnit } from '$lib/components/board-unit'
/** One concern of the GitStatusPanel board. */
export class GitStatusPanelCloseFullscreenPullRequestTab extends BoardUnit<GitStatusPanel> {
  constructor(root: GitStatusPanel) {
    super(root)
  }
  /**
   * Full screen pull request reader. It mirrors the fullscreen terminal and
   * browser: the reader owns its own tab list, opens from the pull request
   * surfaces, and closes by clearing the active tab id. The list is a tab of
   * its own, so the reader can both browse and read without leaving fullscreen.
   */
  PR_READER_LIST_TAB = '__pullRequests__'

  fullscreenPullRequests = $state<PullRequestSummary[]>([])

  fullscreenPullRequestId = $state<string | null>(null)

  fullscreenPullRequestTabs = $derived([
    { id: this.PR_READER_LIST_TAB, title: 'All pull requests' },
    ...this.fullscreenPullRequests.map((pr) => ({
      id: String(pr.number),
      title: `#${pr.number} ${pr.title}`
    }))
  ])

  fullscreenActivePullRequest = $derived(
    this.fullscreenPullRequestId && this.fullscreenPullRequestId !== this.PR_READER_LIST_TAB
      ? (this.fullscreenPullRequests.find(
          (pr) => String(pr.number) === this.fullscreenPullRequestId
        ) ?? null)
      : null
  )

  /** Opens the reader, adding the pull request as a tab when it is not one yet. */
  openPullRequestFullscreen(pr: PullRequestSummary | null): void {
    if (!pr) {
      this.fullscreenPullRequestId = this.PR_READER_LIST_TAB
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
  closeFullscreenPullRequestTab(id: string): void {
    if (id === this.PR_READER_LIST_TAB) {
      this.fullscreenPullRequestId = null
      return
    }
    const remaining = this.fullscreenPullRequests.filter((pr) => String(pr.number) !== id)
    this.fullscreenPullRequests = remaining
    if (this.fullscreenPullRequestId !== id) return
    const fallback = remaining.at(-1)
    this.fullscreenPullRequestId = fallback ? String(fallback.number) : this.PR_READER_LIST_TAB
  }
}
