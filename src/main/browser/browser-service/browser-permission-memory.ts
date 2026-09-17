/**
 * Durable permission memory for the embedded browser.
 *
 * The browser's own decision ledger lives in `BrowserService`; this module is
 * only its on-disk record, so an "Allow" or "Don't allow" the user already gave
 * for a site survives quitting and reopening the app instead of being asked
 * again.
 *
 * Electron calls the session's permission *request* handler for every web API
 * call, even when the synchronous check handler already answered (verified on
 * Electron 44: a `getUserMedia` after a granted permission check still reaches
 * the request handler). The browser therefore cannot lean on Chromium's
 * per-session permission store and has to remember decisions itself.
 *
 * File contents are untrusted input: a hand-edited, truncated, or corrupt file
 * must never grant anything, so every entry is validated and bounded on load.
 */

import { BROWSER_PARTITION_PREFIX } from './browser-validation'

/** Minimal persistence surface this store needs (a `StorageEngine` satisfies
 *  it structurally); paths are relative to the app config root. */
export interface PermissionMemoryPersistence {
  read<T>(relativePath: string): Promise<T | null>
  write(relativePath: string, data: unknown): Promise<void>
}

/** The browser's live decision ledgers, keyed by session partition. The store
 *  mutates these in place so handler closures keep observing the same sets. */
export interface PermissionMemoryLedgers {
  grants: Map<string, Set<string>>
  denies: Map<string, Set<string>>
}

export const PERMISSION_MEMORY_FILE = 'browser/permission-memory.json'

const MEMORY_VERSION = 1
/** Bounds for the persisted file: partitions are trimmed to the most recent
 *  ones, keys to the most recently decided ones, so one abandoned project can
 *  never grow the file without limit. */
const MAX_REMEMBERED_PARTITIONS = 300
const MAX_KEYS_PER_PARTITION = 400
const MAX_KEY_LENGTH = 1_024
const PARTITION_PATTERN = new RegExp(`^${BROWSER_PARTITION_PREFIX}[A-Za-z0-9:._-]{1,240}$`, 'u')

interface PersistedPartitionMemory {
  grants?: string[]
  denies?: string[]
}

interface PersistedPermissionMemory {
  version?: number
  partitions?: Record<string, PersistedPartitionMemory>
}

function readKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const keys: string[] = []
  for (const candidate of value) {
    if (typeof candidate !== 'string') continue
    if (candidate.length === 0 || candidate.length > MAX_KEY_LENGTH) continue
    if (candidate.includes('\0')) continue
    if (!keys.includes(candidate)) keys.push(candidate)
  }
  // Keep the most recent decisions when a partition exceeds the cap.
  return keys.slice(-MAX_KEYS_PER_PARTITION)
}

function mergeInto(ledger: Map<string, Set<string>>, partition: string, keys: string[]): void {
  if (keys.length === 0) return
  const existing = ledger.get(partition)
  if (!existing) {
    ledger.set(partition, new Set(keys))
    return
  }
  for (const key of keys) existing.add(key)
}

export class BrowserPermissionMemory {
  /** Serializes writes so a slower earlier snapshot can never land after a
   *  newer one and quietly drop the decision the user just made. */
  private writeChain: Promise<void> = Promise.resolve()

  constructor(private readonly persistence: PermissionMemoryPersistence) {}

  /**
   * Merge the remembered decisions from disk into the live ledgers.
   *
   * Merging rather than replacing matters: a decision taken in this session
   * while the read was in flight is strictly newer than the file, and the
   * decision sets are shared with the permission handler closures.
   */
  async load(ledgers: PermissionMemoryLedgers): Promise<void> {
    const persisted = await this.persistence.read<PersistedPermissionMemory>(PERMISSION_MEMORY_FILE)
    const partitions = persisted?.partitions
    if (!partitions || typeof partitions !== 'object') return
    for (const [partition, memory] of Object.entries(partitions)) {
      if (!PARTITION_PATTERN.test(partition)) continue
      if (!memory || typeof memory !== 'object') continue
      mergeInto(ledgers.grants, partition, readKeys(memory.grants))
      mergeInto(ledgers.denies, partition, readKeys(memory.denies))
    }
  }

  /** Write the live ledgers back to disk. The caller's ledgers are snapshotted
   *  synchronously, so a decision taken while the write is in flight is part of
   *  the next write rather than an inconsistent payload. Partitions with no
   *  remembered decision are dropped so a "Reset permissions" leaves no trace
   *  behind. */
  save(ledgers: PermissionMemoryLedgers): Promise<void> {
    const partitions: Record<string, PersistedPartitionMemory> = {}
    const names = [...new Set([...ledgers.grants.keys(), ...ledgers.denies.keys()])].slice(
      -MAX_REMEMBERED_PARTITIONS
    )
    for (const partition of names) {
      if (!PARTITION_PATTERN.test(partition)) continue
      const grants = [...(ledgers.grants.get(partition) ?? [])].slice(-MAX_KEYS_PER_PARTITION)
      const denies = [...(ledgers.denies.get(partition) ?? [])].slice(-MAX_KEYS_PER_PARTITION)
      if (grants.length === 0 && denies.length === 0) continue
      partitions[partition] = { grants, denies }
    }
    const payload: PersistedPermissionMemory = { version: MEMORY_VERSION, partitions }
    const write = this.writeChain
      .catch(() => undefined)
      .then(() => this.persistence.write(PERMISSION_MEMORY_FILE, payload))
    this.writeChain = write.catch(() => undefined)
    return write
  }
}
