/**
 * Durable permission memory for the embedded browser.
 *
 * The browser's own decision ledger lives in `BrowserService`; this module is
 * only its on-disk record, so an "Allow" or "Don't allow" the user already gave
 * for a site survives quitting and reopening the app instead of being asked
 * again.
 *
 * More than one app instance can share one config root (the installed app and a
 * development instance), so the file is treated as shared state: reads merge
 * into the live ledgers, and a write merges over the file instead of replacing
 * it, so neither instance erases the other's decisions.
 *
 * Electron calls the session's permission *request* handler for every web API
 * call, even when the synchronous check handler already answered (verified on
 * Electron 44: a `getUserMedia` after a granted permission check still reaches
 * the request handler). The browser therefore cannot lean on Chromium's
 * per-session permission store and has to remember decisions itself.
 *
 * File contents are untrusted input: a truncated, corrupt, or unrecognized entry
 * must never grant anything, so every entry is validated and bounded on load.
 * That validation is structural only: a well-formed entry is honored as the
 * user's own decision, because the file is app data written by the user's
 * account.
 *
 * Two instances writing the same file cannot be ordered, so a key both decided
 * on is last-writer-wins between them; the merge only guarantees that a write
 * never truncates the file to one instance's view, and that the instance which
 * would prompt has re-read it first.
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

/** One partition's keys, already validated and bounded. */
interface PartitionMemory {
  grants: string[]
  denies: string[]
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

/** Validate one file entry; an entry that yields no key at all is dropped. A
 *  key that appears on both sides is treated as a refusal: the contradiction is
 *  not trustworthy, and refusing is the fail-closed reading of it. */
function readPartitionMemory(value: unknown): PartitionMemory | null {
  if (!value || typeof value !== 'object') return null
  const grants = readKeys(Reflect.get(value, 'grants'))
  const denies = readKeys(Reflect.get(value, 'denies'))
  for (const deny of denies) {
    const index = grants.indexOf(deny)
    if (index !== -1) grants.splice(index, 1)
  }
  if (grants.length === 0 && denies.length === 0) return null
  return { grants, denies }
}

/** Every valid partition in a persisted payload, keyed by partition. */
function readPersistedPartitions(value: unknown): Map<string, PartitionMemory> {
  const partitions = new Map<string, PartitionMemory>()
  const raw = (value as PersistedPermissionMemory | null)?.partitions
  if (!raw || typeof raw !== 'object') return partitions
  for (const [partition, memory] of Object.entries(raw)) {
    if (!PARTITION_PATTERN.test(partition)) continue
    const read = readPartitionMemory(memory)
    if (read) partitions.set(partition, read)
  }
  return partitions
}

function addKeys(target: string[], keys: readonly string[]): void {
  for (const key of keys) if (!target.includes(key)) target.push(key)
}

function removeKeys(target: string[], keys: readonly string[]): void {
  for (const key of keys) {
    const index = target.indexOf(key)
    if (index !== -1) target.splice(index, 1)
  }
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
  /** The read a burst of permission requests shares; see {@link refresh}. */
  private inFlightRefresh: Promise<void> | null = null
  /** Bumped by {@link forget}. A read that started before the bump holds keys
   *  the user has since forgotten, so it must not merge anything at all. */
  private generation = 0

  constructor(private readonly persistence: PermissionMemoryPersistence) {}

  /**
   * Merge the remembered decisions from disk into the live ledgers.
   *
   * Merging rather than replacing matters: a decision taken in this session
   * while the read was in flight is strictly newer than the file, and the
   * decision sets are shared with the permission handler closures.
   */
  async load(ledgers: PermissionMemoryLedgers): Promise<void> {
    await this.readInto(ledgers, this.generation)
  }

  /**
   * Re-read the durable memory into the live ledgers.
   *
   * More than one app instance can share one config root, so a decision the
   * user made in the other instance reaches this one only by re-reading the
   * file. Reads are coalesced: a burst of requests from one page costs one
   * read, and the next refresh after it completes reads again. Callers share the
   * same live ledgers, so one coalesced read applies to all of them.
   */
  refresh(ledgers: PermissionMemoryLedgers): Promise<void> {
    if (!this.inFlightRefresh) {
      this.inFlightRefresh = this.readInto(ledgers, this.generation).finally(() => {
        this.inFlightRefresh = null
      })
    }
    return this.inFlightRefresh
  }

  /**
   * Forget one partition: its live keys are cleared, any read already in flight
   * can no longer bring them back, and the file is written without it.
   */
  forget(partition: string, ledgers: PermissionMemoryLedgers): Promise<void> {
    this.generation += 1
    ledgers.grants.get(partition)?.clear()
    ledgers.denies.get(partition)?.clear()
    return this.write(ledgers, [partition])
  }

  /**
   * Write the live ledgers back to disk, keeping what the file holds and this
   * instance does not know about.
   *
   * The file is the record every instance reads at startup, so a write must not
   * truncate it to one instance's view: the file's partitions are the base and
   * this instance's decisions are merged over them. The caller's ledgers are
   * snapshotted synchronously, so a decision taken while the write is in flight
   * is part of the next write rather than an inconsistent payload.
   */
  save(ledgers: PermissionMemoryLedgers): Promise<void> {
    return this.write(ledgers, [])
  }

  /** One read of the file, applied only while nothing was forgotten under it. */
  private async readInto(ledgers: PermissionMemoryLedgers, generation: number): Promise<void> {
    // A "Reset permissions" that has not reached the file yet would otherwise be
    // read straight back into the live ledgers: every queued write (the clear
    // included) lands before this read starts.
    await this.writeChain
    const persisted = await this.persistence.read<PersistedPermissionMemory>(PERMISSION_MEMORY_FILE)
    // A clear that landed while this read was in flight is newer than the file
    // it read, so the read is dropped rather than undoing the clear.
    if (generation !== this.generation) return
    this.mergePersisted(readPersistedPartitions(persisted), ledgers)
  }

  private write(
    ledgers: PermissionMemoryLedgers,
    droppedPartitions: readonly string[]
  ): Promise<void> {
    const snapshot = this.snapshot(ledgers)
    const dropped = new Set(droppedPartitions)
    const write = this.writeChain
      .catch(() => undefined)
      .then(async () => {
        // A failed read (missing file, unreadable, corrupt) only costs the other
        // instances' decisions; this instance's decisions are always written.
        const persisted = await this.persistence
          .read<PersistedPermissionMemory>(PERMISSION_MEMORY_FILE)
          .catch(() => null)
        const merged = readPersistedPartitions(persisted)
        for (const [partition, memory] of snapshot) {
          const current = merged.get(partition) ?? { grants: [], denies: [] }
          // This instance's own decisions are the newest the user made, so they
          // win over a key the file still holds on the other side: a grant here
          // clears a remembered refusal, a refusal here clears a remembered
          // grant.
          removeKeys(current.denies, memory.grants)
          removeKeys(current.grants, memory.denies)
          addKeys(current.grants, memory.grants)
          addKeys(current.denies, memory.denies)
          merged.set(partition, current)
        }
        for (const partition of dropped) merged.delete(partition)
        await this.persistence.write(PERMISSION_MEMORY_FILE, {
          version: MEMORY_VERSION,
          partitions: this.toPayload(merged)
        })
      })
    this.writeChain = write.catch(() => undefined)
    return write
  }

  /** The caller's ledgers as a plain, bounded snapshot. */
  private snapshot(ledgers: PermissionMemoryLedgers): Map<string, PartitionMemory> {
    const snapshot = new Map<string, PartitionMemory>()
    const partitions = new Set([...ledgers.grants.keys(), ...ledgers.denies.keys()])
    for (const partition of partitions) {
      if (!PARTITION_PATTERN.test(partition)) continue
      snapshot.set(partition, {
        grants: [...(ledgers.grants.get(partition) ?? [])],
        denies: [...(ledgers.denies.get(partition) ?? [])]
      })
    }
    return snapshot
  }

  /** Keep the most recently decided partitions, and drop the ones with nothing
   *  remembered, so a "Reset permissions" leaves no trace behind. */
  private toPayload(
    partitions: Map<string, PartitionMemory>
  ): Record<string, PersistedPartitionMemory> {
    const payload: Record<string, PersistedPartitionMemory> = {}
    for (const partition of [...partitions.keys()].slice(-MAX_REMEMBERED_PARTITIONS)) {
      const memory = partitions.get(partition)
      if (!memory) continue
      const grants = memory.grants.slice(-MAX_KEYS_PER_PARTITION)
      const denies = memory.denies.slice(-MAX_KEYS_PER_PARTITION)
      if (grants.length === 0 && denies.length === 0) continue
      payload[partition] = { grants, denies }
    }
    return payload
  }

  private mergePersisted(
    persisted: Map<string, PartitionMemory>,
    ledgers: PermissionMemoryLedgers
  ): void {
    for (const [partition, memory] of persisted) {
      // A decision this instance already holds was taken in this run, so it is
      // newer than the file's copy of that same key and the file must not
      // overrule it. Only the opposite side of a key the file holds is filtered;
      // keys this instance has never decided are adopted as they are.
      const grants = ledgers.grants.get(partition)
      const denies = ledgers.denies.get(partition)
      mergeInto(
        ledgers.grants,
        partition,
        memory.grants.filter((key) => denies?.has(key) !== true)
      )
      mergeInto(
        ledgers.denies,
        partition,
        memory.denies.filter((key) => grants?.has(key) !== true)
      )
    }
  }
}
