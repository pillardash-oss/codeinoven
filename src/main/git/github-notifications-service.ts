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
const STORE_VERSION = 1

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

interface NotificationStoreFile {
  version: number
  saved: NotificationSnapshots
  done: NotificationSnapshots
}

/** Local, app-owned state GitHub's API does not expose (saved and done views). */
export class NotificationSnapshotStore {
  private loaded: NotificationStoreFile | null = null
  /** Serializes writes so two quick actions cannot interleave a read-modify-write. */
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(private readonly storage: StorageEngine) {}

  private async load(): Promise<NotificationStoreFile> {
    if (this.loaded) return this.loaded
    const raw = await this.storage
      .read<Partial<NotificationStoreFile>>(STORE_FILE)
      .catch(() => null)
    const saved =
      raw && raw.version === STORE_VERSION && raw.saved && typeof raw.saved === 'object'
        ? raw.saved
        : {}
    const done =
      raw && raw.version === STORE_VERSION && raw.done && typeof raw.done === 'object'
        ? raw.done
        : {}
    this.loaded = { version: STORE_VERSION, saved, done }
    return this.loaded
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

  async snapshot(id: string): Promise<GitHubNotification | null> {
    const file = await this.load()
    return file.saved[id] ?? file.done[id] ?? null
  }

  async counts(): Promise<{ saved: number; done: number }> {
    const file = await this.load()
    return { saved: Object.keys(file.saved).length, done: Object.keys(file.done).length }
  }

  async saved(): Promise<GitHubNotification[]> {
    const file = await this.load()
    return Object.values(file.saved).map((item) => ({ ...item, saved: true, done: false }))
  }

  async done(): Promise<GitHubNotification[]> {
    const file = await this.load()
    return Object.values(file.done).map((item) => ({ ...item, saved: false, done: true }))
  }

  async setSaved(item: GitHubNotification): Promise<void> {
    const file = await this.load()
    file.saved[item.id] = { ...item, saved: true, done: false }
    await this.persist()
  }

  async removeSaved(id: string): Promise<void> {
    const file = await this.load()
    delete file.saved[id]
    await this.persist()
  }

  async setDone(item: GitHubNotification): Promise<void> {
    const file = await this.load()
    file.done[item.id] = { ...item, saved: false, done: true }
    await this.persist()
  }

  async removeDone(id: string): Promise<void> {
    const file = await this.load()
    delete file.done[id]
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
 * No notification token is connected yet.
 *
 * Its own failure because it is not a GitHub answer at all: the app never sent a
 * request. GitHub serves the notifications API only to a classic personal access
 * token, which the app's GitHub App sign-in can never produce, so the panel is
 * told to connect one instead of being handed a retry that cannot work.
 */
export class GitHubNotificationTokenMissingError extends Error {
  constructor() {
    super('Connect a GitHub token to read your notifications')
    this.name = 'GitHubNotificationTokenMissingError'
  }
}

/**
 * Whether a token's scopes may read the notifications API.
 *
 * GitHub accepts the `notifications` scope, and also the broader `repo` scope
 * (its reference: "All calls to these endpoints require the `notifications` or
 * `repo` scopes"). A token whose scopes GitHub does not report at all is let
 * through: the header is absent for some credential types, and the API itself is
 * the authority that then answers.
 */
export function notificationScopesAllowRead(scopes: readonly string[] | null): boolean {
  if (!scopes) return true
  return scopes.includes('notifications') || scopes.includes('repo')
}

/** What a candidate token says about itself: whose it is, and what it may do. */
export interface GitHubTokenInspection {
  login: string | null
  scopes: string[] | null
}

export interface GitHubNotificationsDeps {
  /**
   * The classic personal access token the notification endpoints run on, from
   * the vault. Null until the user connects one; the app's GitHub App sign-in
   * token is deliberately not a fallback, because GitHub refuses it here.
   */
  resolveToken: () => Promise<string | null>
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
  /** Last-seen threads, so an action can persist a snapshot without a re-fetch. */
  private readonly seen = new Map<string, GitHubNotification>()

  constructor(private readonly deps: GitHubNotificationsDeps) {
    this.store = new NotificationSnapshotStore(deps.storage)
    this.baseUrl = deps.baseUrl ?? GITHUB_API_BASE_URL
  }

  async listPage(input: GitHubNotificationPageInput): Promise<GitHubNotificationPage> {
    const counts = await this.countState()
    if (input.tab === 'saved') {
      const saved = await this.store.saved()
      return { items: saved, hasMore: false, counts: { ...counts, inbox: 0 } }
    }
    if (input.tab === 'done') {
      const done = await this.store.done()
      return { items: done, hasMore: false, counts: { ...counts, inbox: 0 } }
    }
    const { items, hasMore } = await this.fetchInbox(input)
    const unread = items.filter((item) => item.unread).length
    return { items, hasMore, counts: { ...counts, inbox: unread } }
  }

  private async countState(): Promise<GitHubNotificationTabCounts> {
    const { saved, done } = await this.store.counts()
    return { inbox: 0, saved, done }
  }

  /** Fetch and normalize one page of the live inbox listing. */
  private async fetchInbox(
    input: GitHubNotificationPageInput
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

    for (const item of items) this.seen.set(item.id, item)
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
    await this.request(`/notifications/threads/${encodeURIComponent(threadId)}`, {
      method: 'PATCH'
    })
    const seen = this.seen.get(threadId)
    if (seen) this.seen.set(threadId, { ...seen, unread: false })
  }

  /** Mark every notification read on GitHub. */
  async markAllRead(): Promise<void> {
    await this.request('/notifications', { method: 'PUT' })
    for (const [id, item] of this.seen) this.seen.set(id, { ...item, unread: false })
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
    if (saved) {
      await this.store.setSaved(await this.requireThread(threadId))
    } else {
      await this.store.removeSaved(threadId)
    }
    return this.countState()
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
    if (done) {
      const item = await this.requireThread(threadId)
      await this.request(`/notifications/threads/${encodeURIComponent(threadId)}`, {
        method: 'DELETE'
      })
      this.seen.set(threadId, { ...item, unread: false })
      await this.store.setDone({ ...item, unread: false })
    } else {
      await this.store.removeDone(threadId)
    }
    return this.countState()
  }

  /** Resolve a thread's snapshot from memory, the store, or the API. */
  private async requireThread(threadId: string): Promise<GitHubNotification> {
    const cached = this.seen.get(threadId)
    if (cached) return cached
    const stored = await this.store.snapshot(threadId)
    if (stored) return stored
    const response = await this.request(`/notifications/threads/${encodeURIComponent(threadId)}`, {
      method: 'GET'
    })
    const payload = (await response.json()) as unknown
    const item = this.toNotification(payload)
    if (!item) throw new Error('GitHub did not return that notification thread')
    this.seen.set(item.id, item)
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

  /**
   * Ask GitHub whose a candidate token is and what it may do.
   *
   * This is the one call that runs on a token that is not connected yet, so it
   * takes the token as an argument. It is what lets the panel refuse a token
   * that cannot read notifications before storing it, and name the account
   * afterwards. A 401 is reported as `GitHubNotificationError`, so the caller can
   * tell a dead token from a network fault.
   */
  async inspectToken(token: string): Promise<GitHubTokenInspection> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS)
    try {
      const response = await this.send('/user', { method: 'GET' }, token, controller.signal)
      if (!response.ok) {
        throw new GitHubNotificationError(response.status, await this.readErrorMessage(response))
      }
      const payload = (await response.json()) as unknown
      const record = this.asRecord(payload)
      const header = response.headers.get('x-oauth-scopes')
      const scopes =
        typeof header === 'string'
          ? header
              .split(',')
              .map((scope) => scope.trim())
              .filter((scope) => scope.length > 0)
          : null
      return { login: this.readString(record, 'login'), scopes }
    } catch (failure) {
      if (failure instanceof Error && failure.name === 'AbortError') {
        throw new Error('GitHub token check timed out', { cause: failure })
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
