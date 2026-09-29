import { Logger } from './logger'
import type { StorageEngine } from '../storage/storage-engine'

/** Persisted shape: one versioned marker so the file stays inspectable. */
interface CleanShutdownStoreFile {
  version: 1
  marker: CleanShutdownMarker | null
}

/**
 * The process that shut down on purpose, and the moment it did.
 *
 * `pid` attributes the marker to one process in a config root several instances
 * may share, so an orphaned turn owned by a different process is never mistaken
 * for a deliberate stop.
 */
export interface CleanShutdownMarker {
  pid: number
  at: number
}

const STORE_PATH = 'shutdown/clean-shutdown.json'

function isValidMarker(value: unknown): value is CleanShutdownMarker {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    typeof record.pid === 'number' &&
    Number.isInteger(record.pid) &&
    record.pid > 0 &&
    typeof record.at === 'number'
  )
}

/**
 * CleanShutdownStore   proof that the previous process exited on purpose.
 *
 * A turn left in flight after the app stopped is normally reported as an abrupt
 * interruption: the harness was killed before it reported a terminal answer.
 * That is exactly what happened on a crash or a power loss, but it is false for
 * a deliberate close   the tray Quit item or a confirmed force close. This store
 * removes the guesswork: the deliberate shutdown path writes a marker here
 * before it kills the harness, and the next launch consumes it. An orphaned turn
 * whose owner left a marker is settled as a clean app-closed stop; every other
 * orphan keeps the crash wording.
 *
 * The marker is consumed   cleared   the moment a launch has read it, so a later
 * crash with no marker can never inherit a stale "clean" verdict.
 */
export class CleanShutdownStore {
  private marker: CleanShutdownMarker | null = null
  private loaded = false

  constructor(private readonly storage: StorageEngine) {}

  async load(): Promise<void> {
    const raw = await this.storage.read<CleanShutdownStoreFile>(STORE_PATH)
    this.marker = raw && isValidMarker(raw.marker) ? raw.marker : null
    this.loaded = true
  }

  isLoaded(): boolean {
    return this.loaded
  }

  /** The pending marker left by a previous deliberate shutdown, or `null`. */
  current(): CleanShutdownMarker | null {
    return this.marker
  }

  /**
   * Record that this process is shutting down deliberately. Awaited before the
   * harness is killed so the next launch can tell a deliberate close from a
   * crash. Idempotent: a repeated call refreshes the same marker.
   */
  async record(pid: number = process.pid): Promise<void> {
    this.marker = { pid, at: Date.now() }
    this.loaded = true
    await this.persist()
  }

  /** Clear the marker once a launch has consumed it. */
  async consume(): Promise<void> {
    if (this.marker === null) return
    this.marker = null
    await this.persist()
  }

  /**
   * Whether an orphaned turn owned by `ownerPid` was stopped by a deliberate
   * shutdown. A turn with no recorded owner (a row written before `owner_pid`
   * existed) is attributed to the marker too, because a clean-shutdown marker
   * means the only process in this config root left on purpose.
   */
  isDeliberateStop(ownerPid: number | null): boolean {
    if (!this.marker) return false
    if (ownerPid === null) return true
    return ownerPid === this.marker.pid
  }

  private async persist(): Promise<void> {
    try {
      await this.storage.write(STORE_PATH, {
        version: 1,
        marker: this.marker
      } satisfies CleanShutdownStoreFile)
    } catch (error) {
      Logger.error('Clean-shutdown marker write failed', error)
    }
  }
}
