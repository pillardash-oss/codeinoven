import { invoke } from '$lib/ipc.svelte'
import type {
  GitHubNotification,
  GitHubNotificationFilter,
  GitHubNotificationGroup,
  GitHubNotificationPageResult,
  GitHubNotificationSort,
  GitHubNotificationTab,
  GitHubNotificationTabCounts,
  GitHubNotificationAccessRequired
} from '$shared/types'

/** Items fetched per page. GitHub caps `per_page` at 100 and the panel asks for less. */
const PAGE_SIZE = 30

const EMPTY_COUNTS: GitHubNotificationTabCounts = { inbox: 0, saved: 0, done: 0 }

/**
 * Whether a listing answer reports that no usable token serves it rather than a
 * listing.
 *
 * A page and the access state are told apart by the marker the access shape
 * carries; the page has no `status` field.
 */ function isAccessRequired(
  result: GitHubNotificationPageResult
): result is GitHubNotificationAccessRequired {
  return 'status' in result && result.status === 'access_required'
}

/**
 * The signed-in account's GitHub notifications.
 *
 * Notifications are account-wide, so there is exactly one of these for the whole
 * window rather than one per project. Every mutation rewrites the row in place
 * instead of refetching the list, and a page response that arrives after a newer
 * one is dropped, so switching filters quickly can never show a stale listing.
 */
class GitHubNotificationsStore {
  tab = $state<GitHubNotificationTab>('inbox')
  filter = $state<GitHubNotificationFilter>('default')
  sort = $state<GitHubNotificationSort>('newest')
  group = $state<GitHubNotificationGroup>('date')

  items = $state<GitHubNotification[]>([])
  counts = $state<GitHubNotificationTabCounts>(EMPTY_COUNTS)
  hasMore = $state(false)
  loading = $state(false)
  loadingMore = $state(false)
  error = $state<string | null>(null)
  /**
   * The access state the listing reported, when GitHub could not serve it.
   *
   * GitHub refuses its notification endpoints to GitHub App tokens outright, so
   * this is the state a registration the app cannot read notifications with
   * lands in. No retry clears it, and no second sign-in through the same
   * registration reaches a different answer, which is why the panel reports the
   * cause instead of offering a control that cannot work.
   */
  access = $state<GitHubNotificationAccessRequired | null>(null)
  /** Thread id of an in-flight per-row action, so its row can show busy. */
  busyThreadId = $state<string | null>(null)

  private page = 1
  /** Guards against a slower earlier response overwriting a newer one. */
  private requestId = 0

  /** Whether the panel has been opened at least once, so it loads lazily. */
  private started = false

  /**
   * Whether the listing has ever been loaded.
   *
   * Lets a caller that only wants to keep a loaded view current (an account
   * switch, a sign-in) skip the work when the view was never opened, instead of
   * fetching an inbox the user has not asked to see.
   */
  get hasLoaded(): boolean {
    return this.started
  }

  /** Load the first page for the current tab and filter, unless already loaded. */
  async ensureLoaded(): Promise<void> {
    if (this.started) return
    this.started = true
    await this.load()
  }

  async setTab(tab: GitHubNotificationTab): Promise<void> {
    if (this.tab === tab) return
    this.tab = tab
    await this.load()
  }

  async setFilter(filter: GitHubNotificationFilter): Promise<void> {
    if (this.filter === filter) return
    this.filter = filter
    await this.load()
  }

  setSort(sort: GitHubNotificationSort): void {
    this.sort = sort
  }

  setGroup(group: GitHubNotificationGroup): void {
    this.group = group
  }

  /** Fetch the first page, replacing whatever is loaded. */
  async load(): Promise<void> {
    const requestId = ++this.requestId
    this.loading = true
    this.error = null
    this.access = null
    try {
      const result = await invoke('githubNotification:page', {
        tab: this.tab,
        filter: this.filter,
        page: 1,
        perPage: PAGE_SIZE
      })
      if (requestId !== this.requestId) return
      if (isAccessRequired(result)) {
        this.items = []
        this.hasMore = false
        this.access = result
        return
      }
      this.page = 1
      this.items = result.items
      // Saved and Done carry no inbox count of their own, so the badge keeps the
      // last figure the Inbox view reported rather than dropping to zero.
      this.counts =
        this.tab === 'inbox' ? result.counts : { ...result.counts, inbox: this.counts.inbox }
      this.hasMore = result.hasMore
    } catch (reason) {
      if (requestId !== this.requestId) return
      this.error = reason instanceof Error ? reason.message : 'Notifications could not be loaded'
      this.items = []
      this.hasMore = false
    } finally {
      if (requestId === this.requestId) this.loading = false
    }
  }

  /** Append the next live page. Only meaningful for the inbox tab. */
  async loadMore(): Promise<void> {
    if (!this.hasMore || this.loading || this.loadingMore) return
    const requestId = this.requestId
    this.loadingMore = true
    try {
      const next = this.page + 1
      const result = await invoke('githubNotification:page', {
        tab: this.tab,
        filter: this.filter,
        page: next,
        perPage: PAGE_SIZE
      })
      if (requestId !== this.requestId) return
      // A refusal mid-list is the same fact as one on the first page: no usable
      // token serves this listing, and only connecting one changes that.
      if (isAccessRequired(result)) {
        this.access = result
        return
      }
      this.page = next
      const known = new Set(this.items.map((item) => item.id))
      this.items = [...this.items, ...result.items.filter((item) => !known.has(item.id))]
      this.counts = result.counts
      this.hasMore = result.hasMore
    } catch (reason) {
      if (requestId !== this.requestId) return
      this.error =
        reason instanceof Error ? reason.message : 'More notifications could not be loaded'
    } finally {
      if (requestId === this.requestId) this.loadingMore = false
    }
  }

  /** Mark one thread read, updating the row in place. */
  async markRead(threadId: string): Promise<void> {
    await this.runRowAction(threadId, async () => {
      await invoke('githubNotification:markRead', threadId)
      this.replaceItem(threadId, (item) => ({ ...item, unread: false }))
    })
  }

  /** Save or unsave a thread in the app. */
  async setSaved(threadId: string, saved: boolean): Promise<void> {
    await this.runRowAction(threadId, async () => {
      const counts = await invoke('githubNotification:setSaved', threadId, saved)
      this.counts = counts
      this.replaceItem(threadId, (item) => ({ ...item, saved }))
      // A row that no longer belongs to the view it was saved from leaves it.
      if (!saved && this.tab === 'saved') this.removeItem(threadId)
    })
  }

  /** Mark a thread done (archive), or restore it to the inbox. */
  async setDone(threadId: string, done: boolean): Promise<void> {
    await this.runRowAction(threadId, async () => {
      const counts = await invoke('githubNotification:setDone', threadId, done)
      this.counts = counts
      if (done) {
        this.replaceItem(threadId, (item) => ({ ...item, unread: false, done: true }))
        if (this.tab === 'inbox') this.removeItem(threadId)
      } else {
        this.replaceItem(threadId, (item) => ({ ...item, done: false }))
        if (this.tab === 'done') this.removeItem(threadId)
      }
    })
  }

  /** Unsubscribe (ignore) a thread on GitHub. */
  async unsubscribe(threadId: string): Promise<void> {
    await this.runRowAction(threadId, () =>
      invoke('githubNotification:setSubscribed', threadId, false)
    )
  }

  /** Mark every notification read on GitHub. */
  async markAllRead(): Promise<void> {
    this.busyThreadId = '__all__'
    try {
      await invoke('githubNotification:markAllRead')
      this.items = this.items.map((item) => ({ ...item, unread: false }))
      this.counts = { ...this.counts, inbox: 0 }
    } catch (reason) {
      this.error = reason instanceof Error ? reason.message : 'Notifications could not be updated'
    } finally {
      this.busyThreadId = null
    }
  }

  /** One row action, with its id marked busy and any failure surfaced. */
  private async runRowAction(threadId: string, action: () => Promise<void>): Promise<void> {
    this.busyThreadId = threadId
    try {
      await action()
    } catch (reason) {
      this.error =
        reason instanceof Error ? reason.message : 'The notification could not be updated'
    } finally {
      this.busyThreadId = null
    }
  }

  private replaceItem(
    threadId: string,
    patch: (item: GitHubNotification) => GitHubNotification
  ): void {
    this.items = this.items.map((item) => (item.id === threadId ? patch(item) : item))
  }

  private removeItem(threadId: string): void {
    this.items = this.items.filter((item) => item.id !== threadId)
  }
}

export const githubNotifications = new GitHubNotificationsStore()
