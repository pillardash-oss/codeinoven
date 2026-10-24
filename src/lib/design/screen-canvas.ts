/**
 * The Screen Canvas: one page per design that shows every screen at once.
 *
 * A design is a folder of screens, and a folder read one screen at a time hides
 * the product: the board pictures each screen, and the user still cannot see how
 * they sit together. The Screen Canvas is the single page that fixes that, and
 * it belongs to the app rather than to the design folder.
 *
 * The app owns it because the canvas is derivable. The folder already says which
 * screens exist, the app already serves a runtime that frames them, and a page
 * that is written by hand is a page that falls behind the design and costs a
 * turn to repair. So the canvas is served at a reserved path on the design's own
 * origin, generated from the folder every time it is asked for: a screen added,
 * removed or reshaped appears, moves or disappears on its own, and nothing about
 * the design is ever out of step with it.
 *
 * What the folder cannot say is intent: which screen leads, which states deserve
 * a place, at what width a state is worth framing, and which states are still
 * only an idea. That is what `canvas.json` is for. It is optional, it never
 * decides what exists, and it can only reorder, relabel, size and annotate the
 * screens the folder holds: a frame it names that no longer exists is dropped
 * instead of breaking the canvas.
 *
 * Shared between main and the renderer because both must agree: main generates
 * the page and the board's state, and the renderer asks for the same page and
 * describes the same frames to the agent in the user's own words.
 */

/**
 * Where the app serves a design's canvas, relative to the design's own origin.
 *
 * A reserved path rather than a file, because the page belongs to the app: the
 * design folder stays exactly the agent's files, and a canvas that improves
 * reaches every design without a single screen being rewritten.
 */
export const SCREEN_CANVAS_PATH = '__cio/canvas.html'

/**
 * The file name that has meant "this design's canvas" in a design folder.
 *
 * Kept because designs written before the canvas was app-owned still hold one.
 * The app serves its generated canvas at {@link SCREEN_CANVAS_PATH} and reads
 * this file as nothing at all: it is not a screen, so it is never pictured,
 * listed, framed or exported as one.
 */
export const SCREEN_CANVAS_FILE = 'canvas.html'

/** The one file an agent may write to steer the generated canvas. */
export const SCREEN_CANVAS_METADATA_FILE = 'canvas.json'

/** Where the app serves the canvas runtime from, on every preview origin. */
export const SCREEN_CANVAS_RUNTIME_SCRIPT_PATH = '/__cio/canvas.js'
export const SCREEN_CANVAS_RUNTIME_STYLE_PATH = '/__cio/canvas.css'

/** How many frames sit side by side, unless the design's metadata says otherwise. */
export const SCREEN_CANVAS_DEFAULT_COLUMNS = 2
export const SCREEN_CANVAS_MIN_COLUMNS = 1
export const SCREEN_CANVAS_MAX_COLUMNS = 4

/**
 * Ceilings on what a hand-written `canvas.json` may declare.
 *
 * A canvas is read on every request for the page, and a file that names ten
 * thousand frames would turn one refresh into ten thousand iframes. The lists
 * are bounded far above any design a board shows and far below the point where
 * the page stops being a page.
 */
const MAX_DECLARED_FRAMES = 200
const MAX_DECLARED_SKETCHES = 48

/** Ceiling on a selector a frame may name, and on a query or fragment. */
const MAX_STATE_SELECTOR_LENGTH = 300
const MAX_STATE_URL_LENGTH = 512
const MAX_STATE_WAIT_MS = 10_000

/**
 * What a frame does to its screen before the reader sees it.
 *
 * Most of a design's states are not files: a dropdown is closed or open, a menu
 * is expanded, a dialog is up. A canvas exists to show those side by side rather
 * than to make the reader click through them, so a frame may say how to reach
 * its state: the canvas loads the screen and performs the interaction inside it,
 * in the frame, before it is shown. Nothing is captured and nothing is written
 * back, so a state frame follows the design as it changes.
 */
export interface ScreenCanvasFrameState {
  /** Selector the canvas clicks inside the screen, or null. */
  click: string | null
  /** Selector the canvas focuses inside the screen, or null. */
  focus: string | null
  /** Offset the screen is scrolled to, in px, or null. */
  scroll: number | null
  /** Fragment the frame loads with, without its `#`, or null. */
  hash: string | null
  /** Query the frame loads with, without its `?`, or null. */
  search: string | null
  /** Milliseconds to wait after load before the interactions, or null. */
  wait: number | null
}

/** One framed screen, as the canvas shows it. */
export interface ScreenCanvasFrame {
  /** Screen file the frame shows, project-relative inside the design folder. */
  entry: string
  /** Label the frame carries, or null to use the screen's own name. */
  title: string | null
  /** A line under the label, or null. */
  caption: string | null
  /** Width the frame renders at, or null for the runtime's default. */
  width: number | null
  /** Fixed height, or null to measure the frame's content. */
  height: number | null
  /** The interaction that reaches this frame's state, or null for the screen as written. */
  state: ScreenCanvasFrameState | null
}

/** One state that is still an idea rather than a screen file. */
export interface ScreenCanvasSketch {
  /** What the frame is called in the board and in the request that builds it. */
  title: string
  /** What the state is meant to become, or null. */
  note: string | null
  /** Width the placeholder is drawn at, or null for the runtime's default. */
  width: number | null
}

/** The parts of a canvas a design's `canvas.json` may declare. */
export interface ScreenCanvasMetadata {
  /** Frames side by side, or null for the default. */
  columns: number | null
  /** Frames the file orders, labels or sizes, in the order it declares them. */
  frames: ScreenCanvasFrame[]
  /** States declared but not built yet, in the order the file declares them. */
  sketches: ScreenCanvasSketch[]
}

/** One screen of the folder, as the canvas needs it. */
export interface ScreenCanvasScreen {
  /** Entry inside the design folder, as the board spells it. */
  entry: string
  /** The screen's own name, which is what a frame is labelled with by default. */
  name: string
}

/** The canvas one design folder is served as, once metadata is merged in. */
export interface ScreenCanvasPlan {
  /** Frames side by side, clamped to what the runtime accepts. */
  columns: number
  /** Live frames, in the order the canvas shows them. */
  frames: ScreenCanvasFrame[]
  /** States that are still only an idea. */
  sketches: ScreenCanvasSketch[]
  /** Entries `canvas.json` names that the folder no longer holds. */
  orphanFrames: string[]
}

/**
 * `./index.html`, `/index.html` and `index.html` are the same screen.
 *
 * An agent that writes any of the three means the same file, and a metadata
 * frame must match the screen the folder lists rather than a second spelling of
 * it. A path that tries to leave the folder keeps its spelling and simply never
 * matches a screen, which is what a comparison should do with it.
 */
export function normalizedFrameEntry(entry: string): string {
  let normalized = entry.trim().replace(/\\/gu, '/')
  while (normalized.startsWith('./') || normalized.startsWith('/')) {
    normalized = normalized.slice(normalized.startsWith('./') ? 2 : 1)
  }
  return normalized.replace(/\/{2,}/gu, '/')
}

/** Whether one entry names the canvas rather than a screen of the design. */
export function isScreenCanvasEntry(entry: unknown): boolean {
  if (typeof entry !== 'string') return false
  const normalized = normalizedFrameEntry(entry)
  return normalized === SCREEN_CANVAS_PATH || normalized === SCREEN_CANVAS_FILE
}

/** Whether a declared value carries anything a single-line attribute cannot. */
function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) < 0x20) return true
  }
  return false
}

/** A selector a frame may name, bounded and single-line, or null. */
function selectorOf(value: unknown): string | null {
  const trimmed = textOf(value)
  if (trimmed === null || trimmed.length > MAX_STATE_SELECTOR_LENGTH) return null
  return hasControlCharacters(trimmed) ? null : trimmed
}

/** A query or fragment a frame may load with, or null. */
function urlPartOf(value: unknown, strip: string): string | null {
  const trimmed = textOf(value)
  if (trimmed === null || trimmed.length > MAX_STATE_URL_LENGTH) return null
  if (hasControlCharacters(trimmed)) return null
  const bare = trimmed.startsWith(strip) ? trimmed.slice(1) : trimmed
  return bare === '' ? null : bare
}

/** One declared frame state, or null when it declares no interaction at all. */
function stateOf(value: unknown): ScreenCanvasFrameState | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const scroll = dimensionOf(record.scroll)
  const wait = dimensionOf(record.wait)
  const state: ScreenCanvasFrameState = {
    click: selectorOf(record.click),
    focus: selectorOf(record.focus),
    scroll,
    hash: urlPartOf(record.hash, '#'),
    search: urlPartOf(record.search, '?'),
    wait: wait === null ? null : Math.min(MAX_STATE_WAIT_MS, wait)
  }
  const declared =
    state.click !== null ||
    state.focus !== null ||
    state.scroll !== null ||
    state.hash !== null ||
    state.search !== null
  return declared ? state : null
}

/**
 * The attribute a canvas page carries one frame's state in.
 *
 * The runtime reads this, so the shape is the contract between the page the app
 * builds and the script it serves: a JSON object of the same keys, with the
 * fields that were not declared left out rather than written as null.
 */
export function screenCanvasFrameStateAttribute(state: ScreenCanvasFrameState): string | null {
  const payload: Record<string, string | number> = {}
  if (state.click !== null) payload.click = state.click
  if (state.focus !== null) payload.focus = state.focus
  if (state.scroll !== null) payload.scroll = state.scroll
  if (state.hash !== null) payload.hash = state.hash
  if (state.search !== null) payload.search = state.search
  if (state.wait !== null) payload.wait = state.wait
  return Object.keys(payload).length === 0 ? null : JSON.stringify(payload)
}

/** A finite width from a declared number, or null when it declares none. */
function dimensionOf(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const rounded = Math.round(value)
  return rounded > 0 ? rounded : null
}

/** A trimmed non-empty string, or null. */
function textOf(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/** The columns a declared value asks for, or null when it asks for none. */
function columnsOf(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.min(SCREEN_CANVAS_MAX_COLUMNS, Math.max(SCREEN_CANVAS_MIN_COLUMNS, Math.round(value)))
}

/**
 * One `canvas.json`, read into the parts a canvas uses.
 *
 * Written as a read rather than a validation because the file is optional and
 * hand-written: a key the app does not know, a frame with no entry and no title,
 * and a file that is not an object at all are all answered with an empty
 * declaration instead of a canvas that refuses to load. The screen listing
 * decides what exists, so a bad metadata file can never hide a screen.
 */
export function readScreenCanvasMetadata(raw: unknown): ScreenCanvasMetadata {
  const empty: ScreenCanvasMetadata = { columns: null, frames: [], sketches: [] }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return empty
  const record = raw as Record<string, unknown>
  const frames: ScreenCanvasFrame[] = []
  const sketches: ScreenCanvasSketch[] = []
  const declared = Array.isArray(record.frames) ? record.frames : []
  for (const item of declared) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const frame = item as Record<string, unknown>
    const entry = textOf(frame.entry)
    if (entry === null) {
      // A frame with no file behind it is a state somebody drew for themselves:
      // it keeps its place, and its title is what the board asks to have built.
      const title = textOf(frame.title)
      if (title === null || sketches.length >= MAX_DECLARED_SKETCHES) continue
      sketches.push({
        title,
        note: textOf(frame.note) ?? textOf(frame.caption),
        width: dimensionOf(frame.width)
      })
      continue
    }
    if (frames.length >= MAX_DECLARED_FRAMES) continue
    frames.push({
      entry: normalizedFrameEntry(entry),
      title: textOf(frame.title),
      caption: textOf(frame.caption),
      width: dimensionOf(frame.width),
      height: dimensionOf(frame.height),
      state: stateOf(frame.state)
    })
  }
  return { columns: columnsOf(record.columns), frames, sketches }
}

/**
 * The canvas the folder is served as: declared intent first, then every screen.
 *
 * The order is what a canvas is for. Frames `canvas.json` declares come first,
 * in the file's own order, because that order is a person saying what leads.
 * Every screen the file does not mention follows in listing order, which is the
 * index file first and then the folder's own order, so a screen written a minute
 * ago is on the canvas without anyone touching the metadata. A declared frame
 * that names a screen the folder no longer holds is dropped and reported, never
 * rendered as an error page.
 */
export function planScreenCanvas(input: {
  screens: readonly ScreenCanvasScreen[]
  metadata: ScreenCanvasMetadata
}): ScreenCanvasPlan {
  const listed = new Map<string, ScreenCanvasScreen>()
  for (const screen of input.screens) {
    const entry = normalizedFrameEntry(screen.entry)
    if (entry === '' || isScreenCanvasEntry(entry)) continue
    if (!listed.has(entry)) listed.set(entry, screen)
  }
  const frames: ScreenCanvasFrame[] = []
  const framed = new Set<string>()
  const orphanFrames: string[] = []
  for (const frame of input.metadata.frames) {
    const screen = listed.get(frame.entry)
    if (screen === undefined) {
      if (frame.entry !== '') orphanFrames.push(frame.entry)
      continue
    }
    frames.push(frame)
    framed.add(frame.entry)
  }
  for (const [entry, screen] of listed) {
    if (framed.has(entry)) continue
    frames.push({
      entry,
      title: screen.name,
      caption: null,
      width: null,
      height: null,
      state: null
    })
  }
  return {
    columns: input.metadata.columns ?? SCREEN_CANVAS_DEFAULT_COLUMNS,
    frames,
    sketches: input.metadata.sketches,
    orphanFrames
  }
}

/**
 * What the user sends when they press "Make this design live".
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
      'Build each one as a real screen file beside the design: the page the frame sketched, working rather than drawn, following the same layout, states and copy the sketch shows. The canvas shows every screen in the folder on its own, so a file is all the frame needs, and its sketch entry in canvas.json should go once the state is built.'
    )
  }
  return parts.join('\n\n')
}
