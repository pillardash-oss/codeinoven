import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { atomicWriteDurable, generateId } from '../../lib/utils'
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

/**
 * Best-effort synchronous fsync of the directory holding a durable write, so the
 * rename itself survives a power loss. Not every platform allows a directory to
 * be opened for syncing (Windows notably does not), so a failure here is ignored
 * and the file sync at the call site remains the guarantee.
 */
function syncContainingDirectorySync(filePath: string): void {
  try {
    const handle = openSync(dirname(filePath), 'r')
    try {
      fsyncSync(handle)
    } finally {
      closeSync(handle)
    }
  } catch {
    // Directory fsync is unsupported on some platforms; the file sync remains.
  }
}

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

  /**
   * Load the marker for this launch.
   *
   * An unreadable or unparseable marker is treated as "no marker" and logged,
   * never thrown: a torn write must not abort the boot reads that follow it, and
   * the class only ever degrades a bad marker to the crash wording, never the
   * other way around. A genuinely missing file is filtered out by the reader and
   * stays silent.
   */
  async load(): Promise<void> {
    try {
      await this.readMarker()
    } catch (error) {
      Logger.error('Clean-shutdown marker load failed', error)
      this.marker = null
    }
    this.loaded = true
  }

  /**
   * Re-read the marker from disk.
   *
   * A running instance judges a sibling's orphans long after it read the file
   * at its own launch, and the marker a deliberate shutdown leaves is written at
   * that shutdown, so the in-memory copy is stale exactly when a take-over pass
   * needs it. A failed read keeps the previous marker rather than clearing it,
   * because "could not read" is not evidence of a crash.
   */
  async reload(): Promise<void> {
    try {
      await this.readMarker()
    } catch (error) {
      Logger.error('Clean-shutdown marker reload failed', error)
    }
  }

  /**
   * Read and validate the marker, throwing when the file cannot be read or
   * parsed. Callers decide whether a failed read clears the marker (`load`) or
   * keeps the last known one (`reload`).
   */
  private async readMarker(): Promise<void> {
    const raw = await this.storage.read<CleanShutdownStoreFile>(STORE_PATH)
    this.marker = raw && isValidMarker(raw.marker) ? raw.marker : null
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

  /**
   * Record the marker with a synchronous write, for the forced-exit path where
   * the event loop never gets another turn. The async durable helper cannot run
   * once nothing will turn the loop again, so this is its synchronous
   * counterpart: a unique temp file opened with `wx`, fsynced, renamed into
   * place, then a best-effort directory sync. Every step is synchronous and
   * takes a single bounded attempt, so a locked or refused path logs and returns
   * instead of hanging the exit.
   */
  recordSync(pid: number = process.pid): void {
    this.marker = { pid, at: Date.now() }
    this.loaded = true
    const path = this.storage.resolve(STORE_PATH)
    const tmpPath = `${path}.${process.pid}.${generateId()}.tmp`
    try {
      mkdirSync(dirname(path), { recursive: true })
      const handle = openSync(tmpPath, 'wx', 0o600)
      try {
        writeSync(
          handle,
          JSON.stringify({ version: 1, marker: this.marker } satisfies CleanShutdownStoreFile),
          null,
          'utf8'
        )
        // The event loop never turns again, so the flush has to happen here or a
        // power loss right after the marker is written could still zero it.
        fsyncSync(handle)
      } finally {
        closeSync(handle)
      }
      renameSync(tmpPath, path)
      syncContainingDirectorySync(path)
    } catch (error) {
      rmSync(tmpPath, { force: true })
      Logger.error('Clean-shutdown marker sync write failed', error)
    }
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
      const path = this.storage.resolve(STORE_PATH)
      await mkdir(dirname(path), { recursive: true })
      // The marker is written at boot and at shutdown, never on a hot path, so
      // it opts into the durable write: fsync before the rename and the
      // containing directory after it, so a forced kill cannot leave it zeroed.
      await atomicWriteDurable(
        path,
        JSON.stringify(
          { version: 1, marker: this.marker } satisfies CleanShutdownStoreFile,
          null,
          2
        )
      )
    } catch (error) {
      Logger.error('Clean-shutdown marker write failed', error)
    }
  }
}
