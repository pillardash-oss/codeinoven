import { Logger } from './logger'
import type { StorageEngine } from '../storage/storage-engine'
import type {
  AutoAnswerEntry,
  AutoAnswerItem,
  AutoAnswerKind,
  AutoAnswerOutcome
} from '../../lib/types'

/** Persisted shape: one versioned array so the file stays inspectable. */
interface AutoAnswerStoreFile {
  version: 1
  items: AutoAnswerItem[]
}

const STORE_PATH = 'attention/auto-answers.json'

/**
 * Hard cap on the store. Dismissed entries are evicted before unread ones, and
 * the oldest of each group first, so the rail keeps the recent past and can
 * never grow without bound.
 */
const MAX_ENTRIES = 100

const KINDS = new Set<AutoAnswerKind>([
  'question',
  'secret',
  'image-descriptor',
  'scope-confirmation'
])
const OUTCOMES = new Set<AutoAnswerOutcome>(['auto-answered', 'expired', 'ignored'])

function isValidEntry(value: unknown): value is AutoAnswerEntry {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record.prompt === 'string' &&
    (record.header === undefined || typeof record.header === 'string') &&
    Array.isArray(record.options) &&
    record.options.every((option) => typeof option === 'string') &&
    (record.picked === null || typeof record.picked === 'string')
  )
}

function isValidItem(value: unknown): value is AutoAnswerItem {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record.id === 'string' &&
    typeof record.kind === 'string' &&
    KINDS.has(record.kind as AutoAnswerKind) &&
    typeof record.outcome === 'string' &&
    OUTCOMES.has(record.outcome as AutoAnswerOutcome) &&
    typeof record.projectId === 'string' &&
    typeof record.threadId === 'string' &&
    typeof record.at === 'number' &&
    Array.isArray(record.entries) &&
    record.entries.every(isValidEntry) &&
    (record.dismissedAt === undefined || typeof record.dismissedAt === 'number')
  )
}

/**
 * AutoAnswerStore   the durable record of gates the app resolved on its own.
 *
 * A question that timed out, a secret card that expired, or an image-descriptor
 * decision that was ignored happens while the user is away or busy, so each one
 * is written here the instant it settles. Unlike the transcript, this record
 * spells out the options that were offered and what was chosen, which is what
 * the attention rail shows. The file is one versioned array and every write is
 * serialized through one promise chain, so concurrent settles cannot interleave
 * and corrupt it.
 */
export class AutoAnswerStore {
  private items = new Map<string, AutoAnswerItem>()
  private loaded = false
  private persistChain: Promise<void> = Promise.resolve()

  constructor(private storage: StorageEngine) {}

  async load(): Promise<void> {
    const raw = await this.storage.read<AutoAnswerStoreFile>(STORE_PATH)
    this.items.clear()
    if (raw && Array.isArray(raw.items)) {
      for (const entry of raw.items) {
        if (isValidItem(entry)) this.items.set(entry.id, entry)
      }
    }
    if (this.items.size > MAX_ENTRIES) this.prune()
    this.loaded = true
  }

  isLoaded(): boolean {
    return this.loaded
  }

  /**
   * Record one auto-resolved gate. Idempotent by `id`: a repeated settle for
   * the same request returns the existing entry untouched, so a re-entrant
   * resolution can never duplicate a notice or reset its dismissal.
   */
  record(input: {
    id: string
    kind: AutoAnswerKind
    outcome: AutoAnswerOutcome
    projectId: string
    threadId: string
    entries: AutoAnswerEntry[]
    at?: number
  }): AutoAnswerItem {
    const existing = this.items.get(input.id)
    if (existing) return existing
    const entry: AutoAnswerItem = {
      id: input.id,
      kind: input.kind,
      outcome: input.outcome,
      projectId: input.projectId,
      threadId: input.threadId,
      at: input.at ?? Date.now(),
      entries: input.entries
    }
    this.items.set(entry.id, entry)
    this.trimToCap()
    this.persist()
    return entry
  }

  /** Every recorded gate, newest first. */
  list(): AutoAnswerItem[] {
    return [...this.items.values()].sort((a, b) => b.at - a.at)
  }

  /** Undismissed gates, newest first   what the rail shows. */
  listUnread(): AutoAnswerItem[] {
    return this.list().filter((item) => item.dismissedAt === undefined)
  }

  /** Dismiss one gate. Unknown ids are ignored so a stale click never throws. */
  dismiss(id: string, at?: number): void {
    const existing = this.items.get(id)
    if (!existing || existing.dismissedAt !== undefined) return
    this.items.set(id, { ...existing, dismissedAt: at ?? Date.now() })
    this.persist()
  }

  /** Dismiss every unread gate. Returns how many were dismissed. */
  dismissAll(at?: number): number {
    const stamp = at ?? Date.now()
    let dismissed = 0
    for (const [id, item] of this.items) {
      if (item.dismissedAt !== undefined) continue
      this.items.set(id, { ...item, dismissedAt: stamp })
      dismissed += 1
    }
    if (dismissed > 0) this.persist()
    return dismissed
  }

  /** Drop entries until the store is back under its cap. No-op within the cap. */
  prune(): void {
    if (this.trimToCap()) this.persist()
  }

  /** Await the pending write chain (used by tests and shutdown). */
  async flush(): Promise<void> {
    await this.persistChain
  }

  private trimToCap(): boolean {
    if (this.items.size <= MAX_ENTRIES) return false
    const candidates = [...this.items.values()].sort((a, b) => {
      const aDismissed = a.dismissedAt !== undefined ? 0 : 1
      const bDismissed = b.dismissedAt !== undefined ? 0 : 1
      if (aDismissed !== bDismissed) return aDismissed - bDismissed
      return a.at - b.at
    })
    const evicted = candidates.slice(0, this.items.size - MAX_ENTRIES)
    for (const entry of evicted) this.items.delete(entry.id)
    return evicted.length > 0
  }

  private persist(): void {
    const snapshot: AutoAnswerStoreFile = { version: 1, items: [...this.items.values()] }
    this.persistChain = this.persistChain
      .then(() => this.storage.write(STORE_PATH, snapshot))
      .catch((error) => {
        Logger.error('Auto-answer store could not be written:', error)
      })
  }
}
