import { webContents } from 'electron'
import { mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { LOGS_DIRECTORY, logDayName } from './log-paths'
import { Logger } from './logger'
import { perfTrace } from './perf-trace'
import type { StorageEngine } from '../storage/storage-engine'
import type { HeapSnapshotResult } from './perf-heap-snapshot-types'

/** The slice of storage this needs: an absolute path inside the app's root. */
type HeapSnapshotStorage = Pick<StorageEngine, 'resolve'>

/** How many snapshots one session may write. Each one is hundreds of megabytes. */
export const HEAP_SNAPSHOT_MAX_PER_SESSION = 3

/** How long to wait before another snapshot may be taken. */
export const HEAP_SNAPSHOT_COOLDOWN_MS = 10 * 60 * 1000

/** App total at or above this is worth a snapshot without being asked. */
export const HEAP_SNAPSHOT_AUTO_TOTAL_BYTES = 2_500 * 1024 * 1024

/** Whether the budget above allows one more capture right now. */
export function mayCaptureHeapSnapshot(input: {
  captures: number
  lastCaptureAt: number | null
  now: number
}): boolean {
  if (input.captures >= HEAP_SNAPSHOT_MAX_PER_SESSION) return false
  if (input.lastCaptureAt === null) return true
  return input.now - input.lastCaptureAt >= HEAP_SNAPSHOT_COOLDOWN_MS
}

export type { HeapSnapshotResult } from './perf-heap-snapshot-types'

/**
 * Full V8 heap snapshots of the app's renderer windows.
 *
 * A working set says how much a renderer costs; only a heap snapshot says what is
 * holding it. Chromium already knows how to write one, so the app asks its own
 * windows for a snapshot and leaves the file in the day folder's `heap/`
 * directory: open it in DevTools → Memory → Load, and the retainer chain names
 * the code that is holding the megabytes.
 *
 * Snapshots pause the renderer they are taken from, and the file is large, so
 * this is deliberately bounded: a handful per session, ten minutes apart, and
 * only tried automatically when the app has already grown past a threshold that
 * makes the cost worth paying.
 */
class PerfHeapSnapshots {
  private storage: HeapSnapshotStorage | null = null
  private captures = 0
  private lastCaptureAt: number | null = null
  private capturing = false

  /** Point the snapshot writer at the app's storage root. */
  initialize(storage: HeapSnapshotStorage): void {
    this.storage = storage
  }

  /** Whether one more capture is allowed right now. */
  get available(): boolean {
    return mayCaptureHeapSnapshot({
      captures: this.captures,
      lastCaptureAt: this.lastCaptureAt,
      now: Date.now()
    })
  }

  /**
   * Snapshot every app renderer window.
   *
   * Never throws: a snapshot is a diagnostic, and failing to take one must not
   * disturb the session it was meant to explain. A capture that is already in
   * flight is not started twice, because two snapshots at once would pause the
   * windows for twice as long to answer the same question.
   */
  async capture(reason: string): Promise<HeapSnapshotResult[]> {
    if (!this.storage || !this.available || this.capturing) return []
    this.capturing = true
    this.captures += 1
    this.lastCaptureAt = Date.now()
    const startedAt = Date.now()
    const written: HeapSnapshotResult[] = []
    try {
      const directory = join(LOGS_DIRECTORY, logDayName(), 'heap')
      for (const contents of this.rendererWindows()) {
        const surface = this.describe(contents)
        const stamp = new Date(startedAt).toISOString().replace(/[:.]/gu, '-')
        const fileName = `${stamp}-pid${this.pidOf(contents)}-${reason}.heapsnapshot`
        const relativePath = join(directory, sanitizeFileName(fileName))
        const absolutePath = this.storage.resolve(relativePath)
        try {
          await mkdir(this.storage.resolve(directory), { recursive: true })
          await contents.takeHeapSnapshot(absolutePath)
          const bytes = (await stat(absolutePath)).size
          written.push({ file: absolutePath, bytes, surface })
          Logger.info('Renderer heap snapshot written', { file: absolutePath, bytes, reason })
        } catch (error) {
          Logger.dev('Heap snapshot could not be written:', error)
        }
      }
    } finally {
      this.capturing = false
      perfTrace.record({
        id: `heap-snapshot-${startedAt}`,
        kind: 'mark',
        actor: 'main',
        name: 'main.heap.snapshot',
        startedAt,
        durationMs: Date.now() - startedAt,
        outcome: written.length > 0 ? 'ok' : 'error',
        context: {
          reason,
          surfaces: written.length,
          bytes: written.reduce((total, entry) => total + entry.bytes, 0),
          capturesThisSession: this.captures
        }
      })
    }
    return written
  }

  /**
   * The windows worth snapshotting: the app's own documents only.
   *
   * A heap snapshot pauses its renderer, and pausing an embedded browser tab or a
   * device mirror would freeze something the user is using for a diagnostic that
   * is about this app's own memory.
   */
  private rendererWindows(): Electron.WebContents[] {
    const targets: Electron.WebContents[] = []
    for (const contents of webContents.getAllWebContents()) {
      try {
        if (contents.isDestroyed() || contents.getType() !== 'window') continue
        targets.push(contents)
      } catch {
        // A window that died mid-enumeration is not a surface any more.
        continue
      }
    }
    return targets
  }

  private describe(contents: Electron.WebContents): string {
    try {
      return `${contents.getTitle() || 'window'} <${contents.getURL()}>`.slice(0, 200)
    } catch {
      return 'window'
    }
  }

  private pidOf(contents: Electron.WebContents): number {
    try {
      return contents.getOSProcessId()
    } catch {
      return 0
    }
  }
}

/** Keep the file name inside the log tree's safe character set. */
function sanitizeFileName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/gu, '-')
}

/** The one snapshot writer the process uses. */
export const heapSnapshots = new PerfHeapSnapshots()
