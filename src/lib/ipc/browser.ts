/** Native browser content rectangle in BrowserWindow density-independent pixels. */
export interface BrowserViewBounds {
  x: number
  y: number
  width: number
  height: number
}

/** Navigation state mirrored from an app-scoped browser WebContentsView. */
export interface BrowserPageState {
  tabId: string
  url: string
  title: string
  /** Favicon data URL reported by the page, or null until the page declares one. */
  favicon: string | null
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** True while the page is emitting audio to the output device. Drives the
   *  tab's speaker indicator. */
  audible: boolean
  /** True while the user muted this tab's audio output. */
  muted: boolean
  /** True while the page holds a live microphone, camera or screen capture.
   *  Drives the tab's recording indicator. */
  capturing: boolean
  /** The design folder this tab is rendering, when the design capability opened
   *  it. Non-null is what arms the element inspector, so a tab showing a normal
   *  site never offers it. */
  design: BrowserDesignTab | null
  /** The video composition this tab is rendering, when its served folder holds a
   *  `composition.json`. Non-null is what puts the transport in the panel: the
   *  app owns the playhead, so a composition is paused, scrubbed and stopped the
   *  way a video is. */
  composition: BrowserCompositionTab | null
}

/**
 * A design folder rendered in a browser tab.
 *
 * A design is served from `.cio/designs/<name>/` on a loopback origin by the
 * same directory preview server the file explorer uses
 * (`src/main/preview/design-preview-executor.ts`). Recording which folder and
 * origin the tab is showing is what lets the panel offer inspection for a
 * design without offering it for every page.
 */
export interface BrowserDesignTab {
  /** Project-relative folder being served, e.g. `.cio/designs/hero`. */
  directory: string
  /** Loopback origin the folder is served on, e.g. `http://127.0.0.1:51234`. */
  origin: string
}

/**
 * A video composition rendered in a browser tab, with the timeline the app needs
 * to drive it.
 *
 * A composition is a served folder holding `index.html` and `composition.json`
 * (`src/lib/video/project.ts`). The manifest is read before the tab is armed,
 * because how long the composition runs is what a transport needs first, and the
 * duration published here is the one the page was armed with rather than a second
 * reading that could disagree with it.
 */
export interface BrowserCompositionTab extends BrowserDesignTab {
  /** Seconds the composition runs, from `composition.json`. */
  duration: number
  /** Frames per second, which is the step one frame button moves by. */
  fps: number
  /** Frame size in pixels, from the manifest. */
  width: number
  /** Frame size in pixels, from the manifest. */
  height: number
}

/**
 * Where a composition's playhead is, as the page reports it.
 *
 * The app owns the clock but the page owns the frame, so playback state lives
 * inside the tab and is read back rather than assumed: a composition that reached
 * its end without looping reports `playing` false without the app deciding that.
 */
export interface BrowserCompositionPlayback {
  /** Seconds into the timeline. */
  time: number
  /** Whether the playhead is moving. */
  playing: boolean
  /** Seconds the composition runs, echoed so one read answers the whole question. */
  duration: number
  /** Whether the playhead returns to the start at the end. */
  loop: boolean
  /** The message from a frame that threw, which is why playback stopped. */
  error: string | null
}

/**
 * One playback action on a composition tab.
 *
 * `seek` and `loop` carry a value; the rest take none. The set is closed and a
 * command names a function the transport defines, so no part of a caller's input
 * is ever evaluated as code.
 */
export type BrowserTransportCommand = 'play' | 'pause' | 'toggle' | 'stop' | 'seek' | 'loop'

/**
 * One element the user picked from a design, reported by the injected inspector.
 *
 * The descriptor is what the model reads, so it carries identity (selector, id,
 * classes, ancestors), a little text, and a clipped opening tag: enough to find
 * the element in the source without shipping the whole subtree to the prompt.
 */
export interface BrowserInspectorTarget {
  /** CSS path from the nearest ancestor with a unique id, or from the body. */
  selector: string
  tag: string
  id: string | null
  classes: string[]
  role: string | null
  /** Trimmed visible text of the element, clipped. */
  text: string
  /** Trimmed opening markup of the element, clipped. */
  html: string
  /** Ancestor names, outermost first, for a breadcrumb. */
  ancestors: string[]
  /** Viewport rectangle at pick time, in CSS pixels. */
  rect: BrowserInspectorRect
}

/** A viewport rectangle in CSS pixels. */
export interface BrowserInspectorRect {
  x: number
  y: number
  width: number
  height: number
}

/** One pinned element the page draws a numbered bubble for. */
export interface BrowserInspectorMarker {
  id: string
  /** One-based number, matching the reference's order in the composer. */
  number: number
  /** The user's comment, empty until they write one. */
  comment: string
  /** CSS path the page re-resolves the element by after a layout shift. */
  selector: string
}

/**
 * What the injected inspector reports back to the app.
 *
 * `pick` is a fresh selection, `comment` is the user finishing a comment box,
 * `remove` is the user deleting a pin, and `closed` is inspect mode ending on
 * its own (Escape, or the script giving up) so the panel can reset its toggle.
 */
export type BrowserInspectorEvent =
  | { kind: 'pick'; id: string; target: BrowserInspectorTarget }
  | { kind: 'comment'; id: string; comment: string }
  | { kind: 'remove'; id: string }
  | { kind: 'closed' }

/** DevTools open/closed state for a browser tab. */
export interface BrowserDevToolsState {
  tabId: string
  open: boolean
}

/**
 * What the browser surface claims while it owns the keyboard.
 *
 * The set is Chrome's, scoped to the browser and nothing else: a key pressed
 * inside a browser tab must act on that tab, never on the application around
 * it, and an unbound action leaves the key to the rest of the app.
 */
export const BROWSER_SHORTCUT_ACTIONS = [
  'reload',
  'hardReload',
  'back',
  'forward',
  'focusAddress',
  'savePage',
  'zoomIn',
  'zoomOut',
  'zoomReset',
  'toggleDevTools',
  'closeTab',
  'newTab'
] as const

export type BrowserShortcutAction = (typeof BROWSER_SHORTCUT_ACTIONS)[number]

/**
 * One key chord an action answers to, with `mod` already resolved for the
 * platform the renderer is running on. Main matches Electron's `Input` against
 * this directly, so it never has to know the keymap's trigger grammar.
 */
export interface BrowserShortcutChord {
  /** Lowercase `KeyboardEvent.key` the chord ends on, e.g. `'r'` or `'arrowleft'`. */
  key: string
  meta: boolean
  control: boolean
  shift: boolean
  alt: boolean
}

/** Chords per action, resolved from the keymap. A missing action is unbound. */
export type BrowserShortcutBindings = Partial<Record<BrowserShortcutAction, BrowserShortcutChord[]>>

/**
 * A browser action the renderer owns, because only the renderer knows the tab
 * strip: focusing the address bar, and closing or opening a tab.
 */
export type BrowserPanelShortcutAction = 'focus-address' | 'close-tab' | 'new-tab'

/** Ownership metadata for a browser tab requested by the main process. */
export interface BrowserOpenRequestContext {
  projectId: string
  threadId: string
  requestedTabId?: string
  reveal: boolean
}

/** What the permission popup displays for one pending request. Main resolves
 *  `browser:popupCurrent` with this; the document pulls it on load so the
 *  first prompt can never be lost to push-delivery load-state races. */
export interface BrowserPermissionPromptContext {
  request: BrowserPermissionRequest
  queueSize: number
  /** Owning project (and thread) label; null shows only the website. */
  projectLabel: string | null
}

/** A permission requested by a page inside the project-scoped browser session. */
export interface BrowserPermissionRequest {
  id: string
  tabId: string
  projectId: string
  origin: string
  permission: string
  mediaTypes: string[]
}

/**
 * How the user answered a browser permission prompt.
 * - `allow`: grant for this origin+permission for the app session (remembered).
 * - `allow-once`: grant only the request at hand; the next request re-prompts.
 * - `deny`: refuse and remember the denial so future requests auto-deny.
 * - `dismiss`: refuse only this request (e.g. closing the modal) without remembering.
 */
export type BrowserPermissionDecision = 'allow' | 'allow-once' | 'deny' | 'dismiss'

/**
 * Selectable scopes for clearing an in-app browser session's stored state.
 * - `cookies`: HTTP cookies for visited sites.
 * - `site-data`: persistent site data (storage, service workers, IndexedDB)
 *   excluding cookies.
 * - `cache`: HTTP disk and memory caches.
 * - `permissions`: remembered permission grants and denials.
 */
export type BrowserSiteDataScope = 'cookies' | 'site-data' | 'cache' | 'permissions'

export type BrowserConsoleLevel = 'debug' | 'info' | 'warning' | 'error'

/** A console or runtime diagnostic emitted by one app-scoped browser tab. */
export interface BrowserConsoleEntry {
  id: string
  tabId: string
  level: BrowserConsoleLevel
  message: string
  sourceId: string
  lineNumber: number
  timestamp: number
}

/** Lifecycle state of a download started by an app-scoped browser tab. */
export type BrowserDownloadState = 'progressing' | 'interrupted' | 'completed' | 'cancelled'

/**
 * Metadata for a download started inside the app-scoped browser. Contains no
 * cookies, headers, or page content: only what the download manager needs to
 * render progress and offer cancel/pause/open/reveal actions.
 */
export interface BrowserDownload {
  id: string
  tabId: string
  projectId: string
  fileName: string
  url: string
  mimeType: string
  receivedBytes: number
  totalBytes: number
  speedBytes: number
  progress: number
  state: BrowserDownloadState
  paused: boolean
  savePath: string
  error: string
}
