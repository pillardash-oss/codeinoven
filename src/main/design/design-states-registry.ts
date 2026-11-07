import type { ScreenCanvasDiscoveredState } from '../../lib/design/screen-canvas'

/**
 * The states a design's screens have been read as declaring.
 *
 * Kept here rather than beside the window that does the reading because two very
 * different processes need this answer: the canvas page, which is generated on a
 * request and cannot wait for a browser, and the design export worker, which
 * serves the same page into a PDF or an archive. Importing a module that owns a
 * `BrowserWindow` from either of them would drag Electron into a worker that has
 * no windows at all, so the record is plain data and the reading is somebody
 * else's job.
 */

/** Most designs whose discovered states are kept in memory at once. */
const MAX_TRACKED_DESIGNS = 32

interface DiscoveredRecord {
  /** The design stamp these states belong to. */
  stamp: number
  states: ScreenCanvasDiscoveredState[]
  /** When the record was written, so the oldest one can be evicted. */
  readAt: number
}

const records = new Map<string, DiscoveredRecord>()

/**
 * The states already discovered for this exact design, or none.
 *
 * Synchronous on purpose: the canvas page is generated on a request, and a page
 * that waited for a browser would be a canvas that takes seconds to load. A stamp
 * that does not match is answered as "nothing yet" rather than with states of an
 * older design, because a state whose trigger has since moved would click the
 * wrong element.
 */
export function knownScreenStates(
  folderAbsolute: string,
  stamp: number
): readonly ScreenCanvasDiscoveredState[] {
  const record = records.get(folderAbsolute)
  if (!record || record.stamp !== stamp) return []
  return record.states
}

/**
 * Whether this design has been read at this version, states or none.
 *
 * A design that declares no states is a real answer: without this, every board
 * read would load every screen again to learn the same nothing.
 */
export function hasScreenStates(folderAbsolute: string, stamp: number): boolean {
  return records.get(folderAbsolute)?.stamp === stamp
}

/** Keep one design's discovered states, evicting the least recently read. */
export function rememberScreenStates(
  folderAbsolute: string,
  stamp: number,
  states: ScreenCanvasDiscoveredState[]
): void {
  records.set(folderAbsolute, { stamp, states, readAt: Date.now() })
  while (records.size > MAX_TRACKED_DESIGNS) {
    let oldestKey: string | null = null
    let oldestAt = Number.POSITIVE_INFINITY
    for (const [key, record] of records) {
      if (record.readAt >= oldestAt) continue
      oldestAt = record.readAt
      oldestKey = key
    }
    if (oldestKey === null) return
    records.delete(oldestKey)
  }
}
