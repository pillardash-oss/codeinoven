/**
 * The Screen Canvas: one page per design that shows every screen at once.
 *
 * A design is a folder of screens, and a folder read one screen at a time hides
 * the product: the board pictures each screen, and the user still cannot see how
 * they sit together. A Screen Canvas is the single page that fixes that, and
 * this module is the contract for it: the file name, the frame declarations the
 * agent writes, the runtime the app serves beside it, and the two requests the
 * board sends when the user asks for one.
 *
 * The page stays thin on purpose. One section per frame names the screen file it
 * shows; the app serves the pan, zoom and frame chrome from its own runtime on
 * the design's own origin, so every canvas behaves the same way and improving
 * that behaviour never means rewriting a canvas that already exists.
 *
 * Shared between main and the renderer because both must agree: main reads the
 * frame declarations to tell the board what is missing, and the renderer builds
 * the request text the user sends from the same frame vocabulary.
 */

/** The one file name that means "this design's canvas" inside a design folder. */
export const SCREEN_CANVAS_FILE = 'canvas.html'

/**
 * Where the app serves the canvas runtime from, on every preview origin.
 *
 * A reserved path rather than a file, because the runtime belongs to the app:
 * the design folder stays exactly the agent's files, and a runtime that improves
 * reaches every canvas without a single design being rewritten.
 */
export const SCREEN_CANVAS_RUNTIME_SCRIPT_PATH = '/__cio/canvas.js'
export const SCREEN_CANVAS_RUNTIME_STYLE_PATH = '/__cio/canvas.css'

/** The attribute prefix every canvas declaration uses. */
const ATTRIBUTE_PREFIX = 'data-cio-'

/** One frame of a canvas, as the page declares it. */
export interface ScreenCanvasFrame {
  /**
   * Screen file the frame shows, project-relative inside the design folder, or
   * null for a sketch that holds its own markup.
   */
  entry: string | null
  /** Label the frame carries, or null when it declares none. */
  title: string | null
  /** A frame with inline markup and no screen file behind it yet. */
  sketch: boolean
}

/** Whether one entry name is the canvas rather than a screen of the design. */
export function isScreenCanvasEntry(entry: unknown): boolean {
  if (typeof entry !== 'string') return false
  return normalizedFrameEntry(entry) === SCREEN_CANVAS_FILE
}

/**
 * The entry a frame names, normalized the way the screen listing spells it.
 *
 * `./index.html`, `/index.html` and `index.html` are the same file, and an agent
 * writing any of the three means the same screen. A path that tries to leave the
 * folder keeps its spelling but never matches a screen, which is what a board
 * comparison should do with it.
 */
export function normalizedFrameEntry(entry: string): string {
  let normalized = entry.trim().replace(/\\/gu, '/')
  while (normalized.startsWith('./') || normalized.startsWith('/')) {
    normalized = normalized.slice(normalized.startsWith('./') ? 2 : 1)
  }
  return normalized.replace(/\/{2,}/gu, '/')
}

/** Whether one `<section>` tag carries the attribute, with or without a value. */
function hasAttribute(tag: string, name: string): boolean {
  return new RegExp(`(?:^|\\s)${name}(?=\\s|=|/?>)`, 'iu').test(tag)
}

/**
 * One attribute's value from a `<section>` tag, or null when it has none.
 *
 * Quoted and unquoted values both count, because a browser reads both: an agent
 * that writes `data-cio-frame=index.html` means the same screen as one that
 * quotes it, and the board must not report a frame the canvas is showing as
 * missing.
 */
function attributeOf(tag: string, name: string): string | null {
  const double = new RegExp(`(?:^|\\s)${name}\\s*=\\s*"([^"]*)"`, 'iu').exec(tag)
  if (double?.[1] !== undefined) return double[1].trim()
  const single = new RegExp(`(?:^|\\s)${name}\\s*=\\s*'([^']*)'`, 'iu').exec(tag)
  if (single?.[1] !== undefined) return single[1].trim()
  const bare = new RegExp(`(?:^|\\s)${name}\\s*=\\s*([^\\s"'=<>\u0060]+)`, 'iu').exec(tag)
  if (bare?.[1] !== undefined) return bare[1].trim()
  return null
}

/**
 * The frames a canvas page declares, in the order it declares them.
 *
 * A read rather than a parse: the board needs the list of screens a canvas
 * promises to show so it can say what is missing, and the page itself is the
 * runtime's business. Section tags are scanned in document order and nothing
 * else is touched, so a canvas with markup the app has never seen still reports
 * its frames correctly.
 */
export function parseScreenCanvasFrames(html: string): ScreenCanvasFrame[] {
  const frames: ScreenCanvasFrame[] = []
  const sectionPattern = /<section\b[^>]*>/giu
  let tag = sectionPattern.exec(html)
  while (tag !== null) {
    const declaration = tag[0]
    const rawEntry = attributeOf(declaration, `${ATTRIBUTE_PREFIX}frame`)
    // A frame attribute with nothing in it names no screen, and the runtime
    // draws no frame for it: counting it here would make a canvas that shows
    // nothing read as one that shows a screen.
    const namedEntry = rawEntry === null ? null : normalizedFrameEntry(rawEntry)
    const entry = namedEntry === '' ? null : namedEntry
    const sketch = entry === null && hasAttribute(declaration, `${ATTRIBUTE_PREFIX}sketch`)
    if (entry !== null || sketch) {
      frames.push({
        entry,
        title: attributeOf(declaration, `${ATTRIBUTE_PREFIX}title`),
        sketch
      })
    }
    tag = sectionPattern.exec(html)
  }
  return frames
}

/**
 * What the user sends when they press "Create Screen Canvas" or "Update Screen
 * Canvas".
 *
 * Written as the user's own request, because that is what it becomes: a message
 * in the thread, on the record, that the agent answers. The details are the
 * answer to "why now", which is the one thing the agent cannot read off the
 * folder: a screen that was written after the canvas, or one the canvas does not
 * frame at all.
 */
export function screenCanvasRequestMessage(input: {
  /** Project-relative design folder the canvas belongs to. */
  directory: string
  /** True when the design already has a canvas, so this asks for an update. */
  updating: boolean
  /** Screens the folder holds that no live frame of the canvas shows. */
  missingScreens: string[]
  /** Screens written after the canvas was last written. */
  changedScreens: string[]
  /** Screens the canvas frames that the folder no longer holds. */
  orphanFrames: string[]
  /** Titles of sketch frames still waiting for a real screen. */
  sketchTitles: string[]
}): string {
  const details: string[] = []
  if (input.missingScreens.length > 0) {
    details.push(`Not on the canvas yet: ${input.missingScreens.join(', ')}.`)
  }
  if (input.changedScreens.length > 0) {
    details.push(`Changed since the canvas was written: ${input.changedScreens.join(', ')}.`)
  }
  if (input.orphanFrames.length > 0) {
    details.push(
      `Framed but no longer in the design: ${input.orphanFrames.join(', ')}. Remove those frames or restore the screens.`
    )
  }
  if (input.sketchTitles.length > 0) {
    details.push(
      `Still sketches, with no screen file behind them: ${input.sketchTitles.join(', ')}.`
    )
  }
  const subject = input.updating
    ? `Update the Screen Canvas in ${input.directory}, the canvas.html in that design folder, so it shows the current design.`
    : `Create the Screen Canvas for the design in ${input.directory}: the canvas.html in that design folder.`
  return [
    subject,
    'It is the one page that shows every screen and its meaningful states on a single pannable canvas, and the design playbook has a Screen Canvas section for it: frame each screen live with a data-cio-frame section naming its file, add a data-cio-sketch section for a state with no screen file behind it, and load the runtime from its reserved path so the canvas pans and zooms.',
    ...details,
    'Keep it in step from now on: when a screen or a state changes, change its frame in the same pass.'
  ].join('\n\n')
}

/**
 * What the user sends when they press "Generate live preview": the request that
 * gives the design something to show live.
 *
 * A live preview is the design's own entry page served in the browser, so it can
 * be missing in two ways, and both are ordinary screen work. A design with no
 * `index.html` has no page for the preview to open at all. A canvas whose frames
 * are still sketches has states the design never built, and each frame already
 * says which screen it is meant to become.
 */
export function screenCanvasLivePreviewMessage(input: {
  directory: string
  /** The sketch frames to turn into real screens, by title or by what they show. */
  sketchTitles: string[]
  /** True when the design has no `index.html` for the live preview to open. */
  needsEntry: boolean
}): string {
  const parts = [
    `Make the design in ${input.directory} live, so it can be previewed in the browser.`
  ]
  if (input.needsEntry) {
    parts.push(
      'The design has no entry page yet: write the `index.html` a visitor lands on, following the screens the folder already holds.'
    )
  }
  if (input.sketchTitles.length > 0) {
    parts.push(`These canvas frames are still sketches: ${input.sketchTitles.join(', ')}.`)
    parts.push(
      'Build each one as a real screen file beside the design: the page the frame sketched, working rather than drawn, following the same layout, states and copy the sketch shows. Then point its frame at that file so the canvas shows the live screen, and link it from the design where it belongs. Do not leave a sketch frame behind for a state you have built.'
    )
  }
  return parts.join('\n\n')
}
