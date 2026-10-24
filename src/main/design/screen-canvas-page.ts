/**
 * The Screen Canvas, generated from a design folder.
 *
 * The app serves the canvas instead of reading one the agent wrote, so this
 * module is the whole of it: it reads the folder's screens, merges the optional
 * `canvas.json` a design may carry, and answers either the page to serve or the
 * state the board needs to offer that page.
 *
 * Both answers come from the same plan, which is what keeps the page and the
 * board from disagreeing. There is no second record to fall behind, no stamp to
 * compare and no repair to ask for: a screen written a second ago is on the
 * canvas the next time either side asks, because the folder is the only input
 * besides the metadata and the metadata can only arrange what the folder holds.
 *
 * A folder that cannot be read, a metadata file that is not JSON and a frame
 * that names a file nobody wrote are all answered with a canvas rather than an
 * error: the board is a listing of a design somebody is still writing, and a
 * canvas that refuses to load would take the screens down with it.
 */

import { readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { DesignScreen, ScreenCanvasState } from '../../lib/ipc/design'
import {
  SCREEN_CANVAS_DEFAULT_COLUMNS,
  SCREEN_CANVAS_METADATA_FILE,
  SCREEN_CANVAS_PATH,
  isScreenCanvasEntry,
  planScreenCanvas,
  readScreenCanvasMetadata
} from '../../lib/design/screen-canvas'
import type { ScreenCanvasMetadata, ScreenCanvasPlan } from '../../lib/design/screen-canvas'
import { listDesignScreens } from './design-screens'

/** What one design folder's canvas is, and what its metadata could not say. */
export interface ScreenCanvasRead {
  plan: ScreenCanvasPlan
  /** Why `canvas.json` could not be read, or null when it was read or absent. */
  metadataError: string | null
  /**
   * The newest write the canvas shows this time, in ms.
   *
   * A canvas has no file of its own to date, so its stamp is the newest thing it
   * is made of: the screens it frames and the metadata that arranges them. The
   * board pictures the canvas against that stamp, which is what makes a picture
   * of it go stale exactly when the canvas itself would have changed.
   */
  stamp: number
}

/** Give the board the screens as the canvas needs them, index file first. */
function screensOf(listed: readonly DesignScreen[]): { entry: string; name: string }[] {
  return listed
    .filter((screen) => !isScreenCanvasEntry(screen.entry))
    .map((screen) => ({ entry: screen.entry, name: screen.name }))
}

/** One design folder's metadata, or an empty declaration when it has none. */
async function readMetadata(folderAbsolute: string): Promise<{
  metadata: ScreenCanvasMetadata
  error: string | null
  stamp: number
}> {
  const path = join(folderAbsolute, SCREEN_CANVAS_METADATA_FILE)
  const info = await stat(path).catch(() => null)
  const stamp = info === null ? 0 : Math.round(info.mtimeMs)
  const raw = await readFile(path, 'utf8').catch(() => null)
  if (raw === null) return { metadata: readScreenCanvasMetadata(null), error: null, stamp: 0 }
  try {
    return { metadata: readScreenCanvasMetadata(JSON.parse(raw)), error: null, stamp }
  } catch (error) {
    // A canvas still renders without its metadata, so a broken file is reported
    // in the board rather than shown as a canvas the user cannot open.
    return {
      metadata: readScreenCanvasMetadata(null),
      error: error instanceof Error ? error.message : 'It could not be read.',
      stamp
    }
  }
}

/**
 * The canvas of one design folder: what it frames, and what it still sketches.
 *
 * The listing is passed in when the caller already read it, so the board's sweep
 * of screens and the canvas it pictures are one read of the folder rather than
 * two that could disagree.
 */
export async function readScreenCanvas(input: {
  folderAbsolute: string
  screens?: readonly DesignScreen[]
}): Promise<ScreenCanvasRead> {
  const listed = input.screens ?? (await listDesignScreens(input.folderAbsolute))
  const { metadata, error, stamp } = await readMetadata(input.folderAbsolute)
  const newest = listed.reduce((latest, screen) => Math.max(latest, screen.updatedAt), 0)
  return {
    plan: planScreenCanvas({ screens: screensOf(listed), metadata }),
    metadataError: error,
    stamp: Math.max(newest, stamp)
  }
}

/**
 * The canvas as one more screen of the folder, stamped with what it shows.
 *
 * The board pictures it like a screen, opens it like a screen and caches its
 * picture like a screen's, so it is listed as one: a synthetic entry the sweep
 * asks the server for, whose stamp is the newest screen it frames. Null when the
 * design has nothing to show, because a picture of nothing is not a picture.
 */
export function screenCanvasScreen(read: ScreenCanvasRead): DesignScreen | null {
  if (read.plan.frames.length === 0 && read.plan.sketches.length === 0) return null
  return { entry: SCREEN_CANVAS_PATH, name: 'Screen Canvas', updatedAt: read.stamp }
}

/**
 * The canvas as the board reads it, or null when the folder holds nothing.
 *
 * Null is the whole answer for a design with no screens and no sketches: there
 * is no page to open and nothing to describe, which is a design the agent has
 * not started rather than a canvas that failed.
 */
export async function readScreenCanvasState(input: {
  folderAbsolute: string
  directory: string
  screens: readonly DesignScreen[]
}): Promise<ScreenCanvasState | null> {
  const { metadata, error } = await readMetadata(input.folderAbsolute)
  const plan = planScreenCanvas({ screens: screensOf(input.screens), metadata })
  if (plan.frames.length === 0 && plan.sketches.length === 0) return null
  return {
    directory: input.directory,
    entry: SCREEN_CANVAS_PATH,
    columns: plan.columns,
    screens: plan.frames.map((frame) => frame.entry),
    sketches: plan.sketches,
    orphanFrames: plan.orphanFrames,
    metadataError: error
  }
}

/** Escape one value for an HTML attribute or for text content. */
function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** One attribute pair, or an empty string when the value is nothing. */
function attribute(name: string, value: string | number | null): string {
  return value === null ? '' : ` ${name}="${escapeHtml(String(value))}"`
}

/**
 * The page the app serves at {@link SCREEN_CANVAS_PATH}.
 *
 * It is deliberately thin, because the app owns everything else: the runtime it
 * links from its own reserved path builds the frames, owns pan and zoom and
 * brings its styles with it, so a canvas written last month and a screen added a
 * minute ago are laid out by the same code. All this page says is which screens
 * the canvas frames, in which order and at what size.
 */
export function buildScreenCanvasDocument(input: {
  plan: ScreenCanvasPlan
  /** Folder name, for the page title. */
  title: string
}): string {
  const sections: string[] = []
  for (const frame of input.plan.frames) {
    sections.push(
      [
        '      <section',
        attribute('data-cio-frame', frame.entry),
        attribute('data-cio-title', frame.title),
        attribute('data-cio-caption', frame.caption),
        attribute('data-cio-width', frame.width),
        attribute('data-cio-height', frame.height),
        '></section>'
      ].join('')
    )
  }
  for (const sketch of input.plan.sketches) {
    const note =
      sketch.note === null ? '' : `<p class="cio-canvas-note">${escapeHtml(sketch.note)}</p>`
    sections.push(
      [
        '      <section data-cio-sketch',
        attribute('data-cio-title', sketch.title),
        attribute('data-cio-width', sketch.width),
        '>',
        note,
        '</section>'
      ].join('')
    )
  }
  const head = [
    '<!doctype html>',
    '<html lang="en">',
    '  <head>',
    '    <meta charset="utf-8">',
    '    <meta name="viewport" content="width=device-width, initial-scale=1">',
    `    <title>${escapeHtml(input.title)}</title>`,
    '  </head>',
    '  <body>'
  ]
  const empty = sections.length === 0
  const body = empty
    ? [
        '    <main data-cio-canvas-empty>',
        '      <p>This design has no screens yet. Every screen written into its folder appears here on its own.</p>',
        '    </main>',
        '    <script src="/__cio/canvas.js"></script>'
      ]
    : [
        `    <main data-cio-canvas data-cio-columns="${input.plan.columns || SCREEN_CANVAS_DEFAULT_COLUMNS}">`,
        ...sections,
        '    </main>',
        '    <script src="/__cio/canvas.js"></script>'
      ]
  return [...head, ...body, '  </body>', '</html>', ''].join('\n')
}

/** The canvas page for one served folder, ready to answer a request with. */
export async function renderScreenCanvasPage(folderAbsolute: string): Promise<string> {
  const { plan } = await readScreenCanvas({ folderAbsolute })
  return buildScreenCanvasDocument({ plan, title: `Screen Canvas · ${basename(folderAbsolute)}` })
}
