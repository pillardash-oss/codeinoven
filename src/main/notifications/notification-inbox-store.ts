import { Logger } from '../system/logger'
import type { StorageEngine } from '../storage/storage-engine'
import { ASSISTANT_SPACE_ID, INBOX_PROJECT_ID } from '../../lib/types'
import {
  type AgentNotificationPayload,
  type NotificationFamily,
  type PersistedAgentNotification
} from '../../lib/ipc-contract'

/**
 * Persisted shape: one versioned object so the file stays inspectable, with the
 * dismissal tombstones carried next to the entries rather than in a second file
 * that could disagree with the first.
 */
interface NotificationInboxFile {
  version: 1
  notifications: PersistedAgentNotification[]
  /** Ids the user dismissed, so nothing can rebuild them behind their back. */
  dismissed: string[]
}

const STORE_PATH = 'state/notification-inbox.json'

/**
 * How many entries the store keeps. Matches the OS-notification retention cap
 * above it (`MAX_RETAINED_NOTIFICATIONS`), so the panel can never hold something
 * the notification centre has already forgotten.
 */
const MAX_NOTIFICATIONS = 200

/**
 * How many dismissal tombstones are kept. A tombstone only has to outlive the
 * window in which something could still rebuild the entry it retires, which is
 * the thread-state hydration: the newest few hundred dismissals cover that by a
 * wide margin, and the list is trimmed oldest-first so the file cannot grow
 * without bound.
 */
const MAX_DISMISSED = 400

const NOTIFICATION_KINDS = new Set<AgentNotificationPayload['kind']>([
  'completed',
  'chat-completed',
  'attention',
  'spec',
  'error'
])

const NOTIFICATION_SOURCES = new Set<AgentNotificationPayload['source']>([
  'project',
  'chat',
  'assistant',
  'temporary-chat'
])

function isPersistedNotification(value: unknown): value is PersistedAgentNotification {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record.id === 'string' &&
    record.id.length > 0 &&
    typeof record.kind === 'string' &&
    NOTIFICATION_KINDS.has(record.kind as AgentNotificationPayload['kind']) &&
    typeof record.title === 'string' &&
    typeof record.body === 'string' &&
    typeof record.projectId === 'string' &&
    typeof record.threadId === 'string' &&
    typeof record.source === 'string' &&
    NOTIFICATION_SOURCES.has(record.source as AgentNotificationPayload['source']) &&
    typeof record.timestamp === 'number' &&
    Number.isFinite(record.timestamp)
  )
}

/**
 * Which family a notification belongs to, from the entity that owns it.
 *
 * The owning project decides, never the source: a temporary (side) chat carries
 * its parent thread's project, so a side chat opened from a project thread
 * groups under that project, one opened from the assistant space under the
 * assistant, and one opened from an inbox chat under Chats. Grouping it by its
 * `temporary-chat` source instead forced every side chat onto the Chats tab and
 * rail, whichever entity had actually spawned it.
 */
export function familyOf(notification: AgentNotificationPayload): NotificationFamily {
  if (notification.source === 'chat' || notification.projectId === INBOX_PROJECT_ID) {
    return 'chat'
  }
  if (notification.source === 'assistant' || notification.projectId === ASSISTANT_SPACE_ID) {
    return 'assistant'
  }
  return 'project'
}

/**
 * NotificationInboxStore   the durable record of what the panel is showing.
 *
 * The notification panel is the app's only complete inbox: a toast is a
 * transient announcement that expires on its own, so anything the user must not
 * lose has to be written down before the window that received it closes. That
 * makes this store the answer to "what is still pending", including after a
 * restart, and the panel's dismissals part of the same record.
 *
 * Entries are idempotent by id. Notification ids are derived from the thread,
 * its status and its last update, so a repeated delivery of the same event
 * (a re-broadcast, a retry, a second window) refreshes one entry instead of
 * stacking duplicates. Writes are serialized through a single chain so a
 * delivery racing a dismissal cannot interleave and corrupt the file.
 */
export class NotificationInboxStore {
  private notifications = new Map<string, PersistedAgentNotification>()
  private dismissed = new Set<string>()
  private loaded = false
  private persistChain: Promise<void> = Promise.resolve()

  constructor(private storage: StorageEngine) {}

  async load(): Promise<void> {
    this.notifications.clear()
    this.dismissed.clear()
    try {
      const raw = await this.storage.read<NotificationInboxFile>(STORE_PATH)
      // Tombstones first: the entries below are filtered against them, so a file
      // that still holds a retired entry (a write that landed just before the
      // tombstone did) cannot hand it back on the next launch.
      if (raw && Array.isArray(raw.dismissed)) {
        for (const id of raw.dismissed) {
          if (typeof id === 'string') this.dismissed.add(id)
        }
      }
      if (raw && Array.isArray(raw.notifications)) {
        for (const entry of raw.notifications) {
          if (!isPersistedNotification(entry)) continue
          if (this.dismissed.has(entry.id)) continue
          this.notifications.set(entry.id, entry)
        }
      }
    } catch (error) {
      Logger.dev('Notification inbox restore failed:', error)
    }
    // Normalize what came off disk against the caps, so a file written by an
    // older build with a different limit cannot load unbounded.
    this.prune()
    this.trimDismissed()
    this.loaded = true
  }

  isLoaded(): boolean {
    return this.loaded
  }

  /** Every pending entry, oldest first (the order the panel renders them in). */
  list(): PersistedAgentNotification[] {
    return [...this.notifications.values()].sort((a, b) => a.timestamp - b.timestamp)
  }

  /**
   * Record one delivered notification.
   *
   * Returns false for an id the user already dismissed: that is the whole point
   * of the tombstone. A dismissed notification must not come back because the
   * same event was delivered again, or because thread-state hydration rebuilt
   * the same entry from a thread row that still says the same thing.
   */
  add(notification: PersistedAgentNotification): boolean {
    if (this.dismissed.has(notification.id)) return false
    if (this.notifications.has(notification.id)) {
      this.notifications.set(notification.id, notification)
      this.persist()
      return true
    }
    this.notifications.set(notification.id, notification)
    this.prune()
    this.persist()
    return true
  }

  /** Ids the user dismissed. Handed to a window so thread-state hydration in the
   *  renderer cannot rebuild an entry the user has already retired. */
  dismissedIds(): string[] {
    return [...this.dismissed]
  }

  /**
   * Heal assistant entries written before the payload carried their assistant.
   *
   * `assistantId` joined the payload after this store had already been in use, so
   * entries written by an older build carry no assistant and the panel grouped
   * every one of those assistant runs under "Tasks without an assistant". The run
   * thread has always known its assistant, so `resolve` reads it back from there.
   *
   * Only distinct thread ids that are genuinely missing the assistant are queried,
   * each entry is written once, and the file is rewritten a single time, so this
   * is a no-op from the second launch on. A thread that has since been purged
   * resolves to null and its entry is left alone rather than guessed by name.
   */
  async resolveMissingAssistantIds(
    resolve: (threadId: string) => Promise<string | null>
  ): Promise<void> {
    const byThread = new Map<string, PersistedAgentNotification[]>()
    for (const entry of this.notifications.values()) {
      if (entry.source !== 'assistant' || entry.assistantId) continue
      const bucket = byThread.get(entry.threadId)
      if (bucket) bucket.push(entry)
      else byThread.set(entry.threadId, [entry])
    }
    if (byThread.size === 0) return

    let healed = false
    await Promise.all(
      [...byThread].map(async ([threadId, entries]) => {
        try {
          const assistantId = await resolve(threadId)
          if (!assistantId) return
          for (const entry of entries) {
            this.notifications.set(entry.id, { ...entry, assistantId })
          }
          healed = true
        } catch (error) {
          Logger.dev('Assistant notification assistant backfill failed:', error)
        }
      })
    )
    if (healed) this.persist()
  }

  /** Retire one entry the user dismissed by hand. */
  dismiss(id: string): void {
    this.dismissed.add(id)
    this.trimDismissed()
    this.notifications.delete(id)
    this.persist()
  }

  /**
   * Drop every entry belonging to a thread that is gone.
   *
   * No tombstone: a thread id is never reused, so nothing can rebuild an entry
   * for it, and a tombstone would only grow the file for nothing.
   */
  dismissForThread(projectId: string, threadId: string): void {
    let changed = false
    for (const [id, entry] of this.notifications) {
      if (entry.projectId !== projectId || entry.threadId !== threadId) continue
      this.notifications.delete(id)
      changed = true
    }
    if (changed) this.persist()
  }

  /**
   * Clear one tab (or, with no family, the whole inbox), tombstoning every id
   * it retires so the next thread-state hydration cannot put them back.
   */
  clear(family?: NotificationFamily): void {
    let changed = false
    for (const [id, entry] of this.notifications) {
      if (family !== undefined && familyOf(entry) !== family) continue
      this.dismissed.add(id)
      this.notifications.delete(id)
      changed = true
    }
    if (!changed) return
    this.trimDismissed()
    this.persist()
  }

  /** Await the pending write chain (used by shutdown and by tests). */
  async flush(): Promise<void> {
    await this.persistChain
  }

  private trimDismissed(): void {
    if (this.dismissed.size <= MAX_DISMISSED) return
    // Sets iterate in insertion order, so the oldest tombstones drop first.
    const excess = this.dismissed.size - MAX_DISMISSED
    let dropped = 0
    for (const id of this.dismissed) {
      this.dismissed.delete(id)
      dropped += 1
      if (dropped >= excess) break
    }
  }

  /**
   * Enforce the entry cap by age, not by insertion order.
   *
   * A refreshed entry keeps its slot in the map but takes a new arrival time, so
   * insertion order and age drift apart; the oldest entries are the ones the
   * user has had the longest chance to act on, and the OS notification centre
   * has already forgotten them at this depth.
   */
  private prune(): void {
    while (this.notifications.size > MAX_NOTIFICATIONS) {
      let oldestId: string | undefined
      let oldestAt = Number.POSITIVE_INFINITY
      for (const [id, entry] of this.notifications) {
        if (entry.timestamp < oldestAt) {
          oldestAt = entry.timestamp
          oldestId = id
        }
      }
      if (oldestId === undefined) return
      this.notifications.delete(oldestId)
    }
  }

  private persist(): void {
    const snapshot: NotificationInboxFile = {
      version: 1,
      notifications: this.list(),
      dismissed: [...this.dismissed]
    }
    this.persistChain = this.persistChain
      .then(() => this.storage.write(STORE_PATH, snapshot))
      .catch((error) => {
        Logger.error('Notification inbox store could not be written:', error)
      })
  }
}
