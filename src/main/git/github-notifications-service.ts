import type {
  GitHubNotification,
  GitHubNotificationFilter,
  GitHubNotificationPage,
  GitHubNotificationPageInput,
  GitHubNotificationTabCounts
} from '../../lib/types'
import type { StorageEngine } from '../storage/storage-engine'
import { Logger } from '../system/logger'
import { GITHUB_API_BASE_URL } from '../providers/github-provider'

/** Where the app's own saved/done snapshots live, relative to the config root. */
const STORE_FILE = 'github-notifications.json'
const STORE_VERSION = 2

const NETWORK_TIMEOUT_MS = 15_000
const GITHUB_API_ACCEPT = 'application/vnd.github+json'
const GITHUB_API_VERSION = '2022-11-28'
const USER_AGENT = 'CodeInOven'

/** GitHub caps `per_page` at 100; the panel never asks for more than this. */
export const MAX_NOTIFICATION_PAGE_SIZE = 50

/**
 * Reasons that make up each reason-based filter.
 *
 * GitHub's REST listing has no query parameter for these; its own site narrows
 * the returned threads by their `reason`, and these sets are that mapping. The
 * `participating` filter is the one exception   the API answers it directly with
 * `?participating=true`, so it is not listed here.
 */
const REASON_FILTERS: Record<
  Exclude<GitHubNotificationFilter, 'default' | 'all' | 'participating'>,
  readonly string[]
> = {
  assigned: ['assign'],
  mentioned: ['mention'],
  'team-mentioned': ['team_mention'],
  'review-requested': ['review_requested'],
  security: ['security_alert'],
  ci: ['ci_activity']
}

/** One thread's persisted snapshot, keyed by thread id. */
type NotificationSnapshots = Record<string, GitHubNotification>

/** The snapshots one account holds. */
interface NotificationAccountSnapshots {
  saved: NotificationSnapshots
  done: NotificationSnapshots
}

interface NotificationStoreFile {
  version: number
  accounts: Record<string, NotificationAccountSnapshots>
}

/**
 * Local, app-owned state GitHub's API does not expose (saved and done views).
 *
 * Split per account, because notifications are a property of the account rather
 * than of the app: switching accounts must not show one account's saved threads
 * under another's inbox, and signing a second account in must not move the
 * first account's threads into it.
 */
export class NotificationSnapshotStore {
  private loaded: NotificationStoreFile | null = null
  /** Serializes writes so two quick actions cannot interleave a read-modify-write. */
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(private readonly storage: StorageEngine) {}

  private async load(accountId: string): Promise<NotificationStoreFile> {
    if (!this.loaded) {
      const raw = await this.storage.read<unknown>(STORE_FILE).catch(() => null)
      this.loaded = this.parse(raw, accountId)
    }
    return this.loaded
  }

  /**
   * Read a store file, carrying the app's single-account snapshots into the
   * account that is signed in now.
   *
   * The version 1 file had one `saved`/`done` pair with no account on it. Those
   * threads belonged to whoever was signed in at the time, which the caller knows
   * is the account making this call.
   */
  private parse(raw: unknown, accountId: string): NotificationStoreFile {
    if (!raw || typeof raw !== 'object') return { version: STORE_VERSION, accounts: {} }
    const record = raw as Record<string, unknown>
    if (record['version'] === STORE_VERSION) {
      const accounts = record['accounts']
      return {
        version: STORE_VERSION,
        accounts:
          accounts && typeof accounts === 'object'
            ? (accounts as Record<string, NotificationAccountSnapshots>)
            : {}
      }
    }
    const saved = record['saved']
    const done = record['done']
    return {
      version: STORE_VERSION,
      accounts: {
        [accountId]: {
          saved: saved && typeof saved === 'object' ? (saved as NotificationSnapshots) : {},
          done: done && typeof done === 'object' ? (done as NotificationSnapshots) : {}
        }
      }
    }
  }

  private forAccount(file: NotificationStoreFile, accountId: string): NotificationAccountSnapshots {
    const existing = file.accounts[accountId]
    if (existing) return existing
    const created: NotificationAccountSnapshots = { saved: {}, done: {} }
    file.accounts[accountId] = created
    return created
  }

  private persist(): Promise<void> {
    const file = this.loaded
    if (!file) return Promise.resolve()
    this.writeQueue = this.writeQueue
      .then(() => this.storage.write(STORE_FILE, file))
      .catch((failure) => {
        Logger.error('GitHub notification snapshots could not be saved', failure)
      })
    return this.writeQueue
  }

  async snapshot(accountId: string, id: string): Promise<GitHubNotification | null> {
    const snapshots = this.forAccount(await this.load(accountId), accountId)
    return snapshots.saved[id] ?? snapshots.done[id] ?? null
  }

  async counts(accountId: string): Promise<{ saved: number; done: number }> {
    const snapshots = this.forAccount(await this.load(accountId), accountId)
    return { saved: Object.keys(snapshots.saved).length, done: Object.keys(snapshots.done).length }
  }

  async saved(accountId: string): Promise<GitHubNotification[]> {
    const snapshots = this.forAccount(await this.load(accountId), accountId)
    return Object.values(snapshots.saved).map((item) => ({ ...item, saved: true, done: false }))
  }

  async done(accountId: string): Promise<GitHubNotification[]> {
    const snapshots = this.forAccount(await this.load(accountId), accountId)
    return Object.values(snapshots.done).map((item) => ({ ...item, saved: false, done: true }))
  }

  async setSaved(accountId: string, item: GitHubNotification): Promise<void> {
    const snapshots = this.forAccount(await this.load(accountId), accountId)
    snapshots.saved[item.id] = { ...item, saved: true, done: false }
    await this.persist()
  }

  async removeSaved(accountId: string, id: string): Promise<void> {
    delete this.forAccount(await this.load(accountId), accountId).saved[id]
    await this.persist()
  }

  async setDone(accountId: string, item: GitHubNotification): Promise<void> {
    const snapshots = this.forAccount(await this.load(accountId), accountId)
    snapshots.done[item.id] = { ...item, saved: false, done: true }
    await this.persist()
  }

  async removeDone(accountId: string, id: string): Promise<void> {
    delete this.forAccount(await this.load(accountId), accountId).done[id]
    await this.persist()
  }
}

/** A provider failure that keeps the HTTP status, without leaking the token. */
export class GitHubNotificationError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = 'GitHubNotificationError'
  }
}

/**
 * No account is signed in, so there is no token and nothing to read.
 *
 * Its own failure because it is not a GitHub answer at all: the app never sent a
 * request. The panel reads it as signed out and offers the app's own sign-in.
 */
export class GitHubNotificationTokenMissingError extends Error {
  constructor() {
    super('Sign in to GitHub to read your notifications')
    this.name = 'GitHubNotificationTokenMissingError'
  }
}

export interface GitHubNotificationsDeps {
  /**
   * Resolve the active account's GitHub token; null when none is signed in.
   *
   * Every request resolves it per call rather than capturing it, so switching
   * accounts changes who the very next request runs as.
   */
  resolveToken: () => Promise<string | null>
  /**
   * The account those tokens belong to, which keys the app's own saved and done
   * snapshots. Null when none is signed in.
   */
  activeAccountId: () => Promise<string | null>
  storage: StorageEngine
  baseUrl?: string
}

/**
 * Read and act on the signed-in account's GitHub notifications.
 *
 * The listing is fetched live; GitHub has no REST endpoint that lists archived
 * ("done") threads or the "Saved" view, so the app persists a snapshot when the
 * user saves or dones a thread and still sends the real action (mark read, mark
 * done, subscribe) to GitHub. Every request resolves the token from the vault on
 * the main process only and is sanitized before an error crosses IPC.
 */
export class GitHubNotificationsService {
  private readonly store: NotificationSnapshotStore
  private readonly baseUrl: string
  /** Last-seen threads per account, so an action can persist a snapshot without
   *  a re-fetch. Keyed by account and thread, because two accounts can hold a
   *  thread id for the same repository. */
  private readonly seen = new Map<string, GitHubNotification>()

  constructor(private readonly deps: GitHubNotificationsDeps) {
    this.store = new NotificationSnapshotStore(deps.storage)
    this.baseUrl = deps.baseUrl ?? GITHUB_API_BASE_URL
  }

  /** The account a listing belongs to, or a signed-out failure. */
  private async requireAccount(): Promise<string> {
    const accountId = await this.deps.activeAccountId()
    if (!accountId) throw new GitHubNotificationTokenMissingError()
    return accountId
  }

  private seenKey(accountId: string, threadId: string): string {
    return `${accountId}:${threadId}`
  }

  async listPage(input: GitHubNotificationPageInput): Promise<GitHubNotificationPage> {
    const accountId = await this.requireAccount()
    const counts = await this.countState(accountId)
    if (input.tab === 'saved') {
      const saved = await this.store.saved(accountId)
      return { items: saved, hasMore: false, counts: { ...counts, inbox: 0 } }
    }
    if (input.tab === 'done') {
      const done = await this.store.done(accountId)
      return { items: done, hasMore: false, counts: { ...counts, inbox: 0 } }
    }
    const { items, hasMore } = await this.fetchInbox(input, accountId)
    const unread = items.filter((item) => item.unread).length
    return { items, hasMore, counts: { ...counts, inbox: unread } }
  }

  private async countState(accountId: string): Promise<GitHubNotificationTabCounts> {
    const { saved, done } = await this.store.counts(accountId)
    return { inbox: 0, saved, done }
  }

  /** Fetch and normalize one page of the live inbox listing. */
  private async fetchInbox(
    input: GitHubNotificationPageInput,
    accountId: string
  ): Promise<{ items: GitHubNotification[]; hasMore: boolean }> {
    const params = new URLSearchParams({
      per_page: String(input.perPage),
      page: String(input.page)
    })
    if (input.filter === 'all') params.set('all', 'true')
    if (input.filter === 'participating') params.set('participating', 'true')

    const response = await this.request(`/notifications?${params.toString()}`, {
      method: 'GET'
    })
    const payload = (await response.json()) as unknown
    const records = Array.isArray(payload) ? payload : []
    let items = records
      .map((record) => this.toNotification(record))
      .filter((item): item is GitHubNotification => item !== null)

    const reasons = this.reasonSet(input.filter)
    if (reasons) items = items.filter((item) => reasons.has(item.reason))

    for (const item of items) this.seen.set(this.seenKey(accountId, item.id), item)
    return { items, hasMore: this.hasNextPage(response) }
  }

  /** The reasons a filter keeps, or null when it keeps everything. */
  private reasonSet(filter: GitHubNotificationFilter): ReadonlySet<string> | null {
    if (filter === 'default' || filter === 'all' || filter === 'participating') return null
    return new Set(REASON_FILTERS[filter])
  }

  private hasNextPage(response: Response): boolean {
    const link = response.headers.get('link')
    return typeof link === 'string' && /rel="next"/u.test(link)
  }

  /** Mark one thread read on GitHub. */
  async markRead(threadId: string): Promise<void> {
    const accountId = await this.requireAccount()
    await this.request(`/notifications/threads/${encodeURIComponent(threadId)}`, {
      method: 'PATCH'
    })
    const key = this.seenKey(accountId, threadId)
    const seen = this.seen.get(key)
    if (seen) this.seen.set(key, { ...seen, unread: false })
  }

  /** Mark every notification read on GitHub. */
  async markAllRead(): Promise<void> {
    const accountId = await this.requireAccount()
    await this.request('/notifications', { method: 'PUT' })
    for (const [key, item] of this.seen) {
      if (key.startsWith(`${accountId}:`)) this.seen.set(key, { ...item, unread: false })
    }
  }

  /** Subscribe (watch) or unsubscribe (ignore) a thread's notifications. */
  async setSubscribed(threadId: string, subscribed: boolean): Promise<void> {
    const path = `/notifications/threads/${encodeURIComponent(threadId)}/subscription`
    if (subscribed) {
      await this.request(path, { method: 'DELETE' })
    } else {
      await this.request(path, {
        method: 'PUT',
        body: JSON.stringify({ ignored: true })
      })
    }
  }

  /**
   * Save or unsave a thread in the app. GitHub exposes no save, so this only
   * writes the local snapshot store.
   */
  async setSaved(threadId: string, saved: boolean): Promise<GitHubNotificationTabCounts> {
    const accountId = await this.requireAccount()
    if (saved) {
      await this.store.setSaved(accountId, await this.requireThread(accountId, threadId))
    } else {
      await this.store.removeSaved(accountId, threadId)
    }
    return this.countState(accountId)
  }

  /**
   * Mark a thread done (archive it) or restore it to the inbox.
   *
   * Done sends GitHub's own "mark as done", which marks the thread read and
   * drops it from the inbox; the snapshot backs the app's Done view, which the
   * API cannot list. There is no "un-done" endpoint, so restoring only removes
   * the local snapshot   a thread that gets new activity reappears on its own.
   */
  async setDone(threadId: string, done: boolean): Promise<GitHubNotificationTabCounts> {
    const accountId = await this.requireAccount()
    if (done) {
      const item = await this.requireThread(accountId, threadId)
      await this.request(`/notifications/threads/${encodeURIComponent(threadId)}`, {
        method: 'DELETE'
      })
      this.seen.set(this.seenKey(accountId, threadId), { ...item, unread: false })
      await this.store.setDone(accountId, { ...item, unread: false })
    } else {
      await this.store.removeDone(accountId, threadId)
    }
    return this.countState(accountId)
  }

  /** Resolve a thread's snapshot from memory, the store, or the API. */
  private async requireThread(accountId: string, threadId: string): Promise<GitHubNotification> {
    const key = this.seenKey(accountId, threadId)
    const cached = this.seen.get(key)
    if (cached) return cached
    const stored = await this.store.snapshot(accountId, threadId)
    if (stored) return stored
    const response = await this.request(`/notifications/threads/${encodeURIComponent(threadId)}`, {
      method: 'GET'
    })
    const payload = (await response.json()) as unknown
    const item = this.toNotification(payload)
    if (!item) throw new Error('GitHub did not return that notification thread')
    this.seen.set(key, item)
    return item
  }

  /** Normalize one raw thread record into the panel's shape. */
  private toNotification(raw: unknown): GitHubNotification | null {
    const record = this.asRecord(raw)
    if (!record) return null
    const id = this.readId(record)
    if (!id) return null
    const subject = this.asRecord(record['subject'])
    const repository = this.asRecord(record['repository'])
    const actor = this.asRecord(record['actor'])
    if (!subject || !repository) return null
    const repositoryUrl = this.readString(repository, 'html_url') ?? ''
    return {
      id,
      unread: record['unread'] === true,
      reason: this.readString(record, 'reason') ?? 'subscribed',
      updatedAt: this.readString(record, 'updated_at') ?? new Date(0).toISOString(),
      subjectType: this.readString(subject, 'type') ?? 'Unknown',
      title: this.readString(subject, 'title') ?? 'Untitled',
      url: this.subjectWebUrl(
        this.readString(subject, 'type') ?? '',
        this.readString(subject, 'url'),
        repositoryUrl
      ),
      repositoryName: this.readString(repository, 'name') ?? '',
      repositoryFullName: this.readString(repository, 'full_name') ?? '',
      repositoryUrl,
      repositoryPrivate: repository['private'] === true,
      actorLogin: this.readString(actor, 'login'),
      saved: false,
      done: false
    }
  }

  /**
   * Turn the API's subject URL into the browsable github.com URL.
   *
   * The API answers with `https://api.github.com/repos/{owner}/{repo}/{kind}/{n}`
   * while github.com serves `/pull/`, `/issues/`, `/discussions/` and
   * `/releases/tag/`, so the path is rebuilt from the subject kind and its number.
   */
  private subjectWebUrl(kind: string, apiUrl: string | null, repositoryUrl: string): string | null {
    if (!repositoryUrl || !apiUrl) return repositoryUrl || null
    const tail = apiUrl.split('/').filter(Boolean).pop() ?? ''
    if (!tail) return repositoryUrl
    switch (kind) {
      case 'PullRequest':
        return `${repositoryUrl}/pull/${tail}`
      case 'Issue':
        return `${repositoryUrl}/issues/${tail}`
      case 'Discussion':
        return `${repositoryUrl}/discussions/${tail}`
      case 'Commit':
        return `${repositoryUrl}/commit/${tail}`
      case 'Release':
        return `${repositoryUrl}/releases/tag/${tail}`
      default:
        return repositoryUrl
    }
  }

  /**
   * One authenticated request, with a timeout. The token never appears in an
   * error: only GitHub's own message is carried, and it is truncated.
   */
  private async request(path: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS)
    try {
      const token = await this.deps.resolveToken()
      if (!token) throw new GitHubNotificationTokenMissingError()
      const response = await this.send(path, init, token, controller.signal)
      if (!response.ok) {
        throw new GitHubNotificationError(response.status, await this.readErrorMessage(response))
      }
      return response
    } catch (failure) {
      if (failure instanceof Error && failure.name === 'AbortError') {
        throw new Error('GitHub notifications request timed out', { cause: failure })
      }
      throw failure
    } finally {
      clearTimeout(timer)
    }
  }

  private send(
    path: string,
    init: RequestInit,
    token: string,
    signal: AbortSignal
  ): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, {
      ...init,
      signal,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        Accept: GITHUB_API_ACCEPT,
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
        'User-Agent': USER_AGENT,
        ...(init.body ? { 'Content-Type': 'application/json' } : {})
      }
    })
  }

  /** GitHub's error message, sanitized and bounded so nothing leaks or floods. */
  private async readErrorMessage(response: Response): Promise<string> {
    const fallback = `GitHub notifications request failed (${String(response.status)})`
    try {
      const payload = (await response.json()) as unknown
      const record = this.asRecord(payload)
      const message = record ? this.readString(record, 'message') : null
      if (!message) return fallback
      return message.length > 300 ? `${message.slice(0, 297)}...` : message
    } catch {
      return fallback
    }
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
  }

  private asRecordArray(value: unknown): Record<string, unknown>[] {
    if (!Array.isArray(value)) return []
    return value
      .map((entry) => this.asRecord(entry))
      .filter((entry): entry is Record<string, unknown> => entry !== null)
  }

  private readString(record: Record<string, unknown> | null, key: string): string | null {
    if (!record) return null
    const value = record[key]
    return typeof value === 'string' ? value : null
  }

  private readId(record: Record<string, unknown>): string | null {
    const value = record['id']
    if (typeof value === 'string' && value.length > 0) return value
    if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
    return null
  }
}
