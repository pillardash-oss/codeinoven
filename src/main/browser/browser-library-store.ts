/**
 * The browser's user library on disk: the browsing history and the bookmarks.
 *
 * Both live under the config root as atomically written JSON files, the way the
 * global tab list does, for the same reason: renderer `localStorage` is scoped to
 * the renderer origin and silently becomes an empty, process-local storage
 * whenever another app instance already holds the profile, which is exactly how
 * durable browser state used to disappear between launches.
 *
 * The renderer holds the live list and sends the whole of it; this side is the
 * boundary, so every payload is parsed and repaired before it is written. Storage
 * is one class per file, and the two differ only in their bounds and their key, so
 * they are one class here with the record shape named at construction: a second
 * copy of the same read/validate/write sequence is what this avoids.
 */

import { dirname, join } from 'node:path'
import {
  BROWSER_BOOKMARKS_STATE_RELATIVE_PATH,
  BROWSER_HISTORY_STATE_RELATIVE_PATH,
  browserBookmarksSnapshotPayload,
  browserHistorySnapshotPayload,
  parseBrowserBookmarksSnapshot,
  parseBrowserHistorySnapshot,
  type BrowserBookmarksSnapshot,
  type BrowserHistorySnapshot
} from '../../lib/browser/browser-library'
import { ensureDir, getConfigRoot, isUnpackagedElectronLaunch, readJson, writeJson } from '../../lib/utils'
import { Logger } from '../system/logger'

/**
 * One durable library file.
 *
 * `parse` is shared by the read and the write path: a corrupt file reads as the
 * empty record (the renderer then rewrites it from the list it holds), and a
 * renderer payload with an unusable field keeps its record with that field
 * bounded rather than losing it.
 */
export class BrowserLibraryFile<Snapshot> {
  private readonly relativePath: string
  private readonly parse: (value: unknown) => Snapshot
  private readonly payload: (snapshot: Snapshot) => Record<string, unknown>
  private readonly empty: Snapshot
  private readonly label: string

  constructor(options: {
    relativePath: string
    parse: (value: unknown) => Snapshot
    payload: (snapshot: Snapshot) => Record<string, unknown>
    empty: Snapshot
    label: string
  }) {
    this.relativePath = options.relativePath
    this.parse = options.parse
    this.payload = options.payload
    this.empty = options.empty
    this.label = options.label
  }

  private get filePath(): string {
    // Dev keeps its own history and bookmarks so test browsing never pollutes
    // prod. Prod keeps the established filenames.
    const relativePath = isUnpackagedElectronLaunch()
      ? this.relativePath.replace(/\.json$/, '-dev.json')
      : this.relativePath
    return join(getConfigRoot(), relativePath)
  }

  /** The stored record, or the empty one when nothing was ever stored. */
  async load(): Promise<Snapshot> {
    let stored: unknown
    try {
      stored = await readJson<unknown>(this.filePath)
    } catch (error) {
      Logger.error(`${this.label} could not be read`, error)
      return this.empty
    }
    return stored === null ? this.empty : this.parse(stored)
  }

  /** Store what the renderer sent, bounded and repaired first. */
  async save(value: unknown): Promise<void> {
    const snapshot = this.parse(value)
    const path = this.filePath
    await ensureDir(dirname(path))
    await writeJson(path, this.payload(snapshot))
  }

  /** Forget everything. The file itself stays, holding the empty record, so a
   *  clear can never race a read that is already in flight into a missing file. */
  async clear(): Promise<void> {
    await this.save(this.empty)
  }
}

export function createBrowserHistoryStore(): BrowserLibraryFile<BrowserHistorySnapshot> {
  return new BrowserLibraryFile({
    relativePath: BROWSER_HISTORY_STATE_RELATIVE_PATH,
    parse: parseBrowserHistorySnapshot,
    payload: browserHistorySnapshotPayload,
    empty: { entries: [] },
    label: 'Browser history'
  })
}

export function createBrowserBookmarkStore(): BrowserLibraryFile<BrowserBookmarksSnapshot> {
  return new BrowserLibraryFile({
    relativePath: BROWSER_BOOKMARKS_STATE_RELATIVE_PATH,
    parse: parseBrowserBookmarksSnapshot,
    payload: browserBookmarksSnapshotPayload,
    empty: { bookmarks: [], groups: [] },
    label: 'Browser bookmarks'
  })
}
