/**
 * The Screen Canvas of one design, read for the board.
 *
 * A design folder may hold a `canvas.html` that shows every screen at once, and
 * the board has to answer three questions about it before it can offer the right
 * button: does this design have a canvas, which screens is it missing or
 * pointing at files that are gone, and which screens were written after it last
 * was. The canvas file is the only place that
 * says any of this, so the answer is a read of the folder rather than a record
 * the app keeps, and the board calls it on demand rather than the app tracking
 * the file.
 *
 * A canvas that is absent, unreadable or malformed is answered as no canvas
 * rather than as an error: the board is a listing of the design's screens, and a
 * broken canvas must not take the listing down with it. The frame parse itself
 * lives in the shared contract, so the reader here and the renderer that builds
 * the same vocabulary cannot drift.
 */

import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  SCREEN_CANVAS_FILE,
  isScreenCanvasEntry,
  normalizedFrameEntry,
  parseScreenCanvasFrames
} from '../../lib/design/screen-canvas'
import type { DesignScreen, ScreenCanvasState } from '../../lib/ipc/design'

/** What a sketch frame with no title is called when the board has to name it. */
function sketchLabel(title: string | null, index: number): string {
  return title ?? `Untitled sketch ${index + 1}`
}

/**
 * The state of one design folder's Screen Canvas, or null when it has none.
 *
 * `screens` is the folder's screens as the board lists them, in listing order,
 * so the missing and changed lists come back in the order the user already sees
 * them. The canvas file itself is dropped from both: it is the page rather than
 * a screen, and reporting it as missing from its own canvas is nonsense.
 */
export async function readScreenCanvasState(input: {
  /** Absolute path of the design folder. */
  folderAbsolute: string
  /** Project-relative spelling of that folder, for the reply. */
  directory: string
  /** The folder's screens, as the board lists them. */
  screens: DesignScreen[]
}): Promise<ScreenCanvasState | null> {
  const canvasPath = join(input.folderAbsolute, SCREEN_CANVAS_FILE)
  const info = await stat(canvasPath).catch(() => null)
  if (info === null || !info.isFile()) return null
  const html = await readFile(canvasPath, 'utf8').catch(() => null)
  // Read but unreadable is still no canvas: the board gets an empty answer it
  // can offer to create into, not a failure that takes the screens down.
  if (html === null) return null
  const frames = parseScreenCanvasFrames(html)
  const framed = new Set(
    frames.flatMap((frame) =>
      !frame.sketch && frame.entry !== null ? [normalizedFrameEntry(frame.entry)] : []
    )
  )
  const screens = input.screens.filter((screen) => !isScreenCanvasEntry(screen.entry))
  const listed = new Set(screens.map((screen) => normalizedFrameEntry(screen.entry)))
  return {
    directory: input.directory,
    entry: SCREEN_CANVAS_FILE,
    updatedAt: Math.round(info.mtimeMs),
    frames,
    missingScreens: screens
      .filter((screen) => !framed.has(normalizedFrameEntry(screen.entry)))
      .map((screen) => screen.entry),
    // Only a screen the canvas frames can be out of date on it: one the canvas
    // never shows belongs in the missing list, and naming it in both would ask
    // the agent to refresh a frame that does not exist.
    changedScreens: screens
      .filter(
        (screen) =>
          framed.has(normalizedFrameEntry(screen.entry)) && screen.updatedAt > info.mtimeMs
      )
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((screen) => screen.entry),
    // A frame whose file is gone is the canvas pointing at nothing, which the
    // board has to say: the frame renders an error page and the design no
    // longer holds what the canvas promises.
    orphanFrames: [...framed].filter((entry) => !listed.has(entry)),
    sketchTitles: frames
      .filter((frame) => frame.sketch)
      .map((frame, index) => sketchLabel(frame.title, index))
  }
}
