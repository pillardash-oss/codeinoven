/**
 * The reserved ownership context of the global (personal) browser workspace.
 *
 * Every browser tab is keyed by a `(projectId, threadId)` pair in the main
 * process, and the session partition is derived from `projectId`. The global
 * browser deliberately rides the same machinery with one reserved pair, which
 * gives it a single durable profile (`persist:codeinoven-browser:browser-global`)
 * shared by every global tab, isolated from every project's browser and from
 * the agent-controlled project sessions.
 *
 * The pair names no user-visible project or thread, so `BrowserService` treats
 * a global tab as project-less and main resolves its dialog and permission
 * labels to null. It does name a reserved hidden project and one hidden parent
 * thread (see `ProjectManager.ensureGlobalBrowserSpace` and
 * `ThreadManager.ensureGlobalBrowserThread`), which is what lets a per-tab agent
 * conversation resolve its scope through the ordinary chat pipeline. Because
 * that container is a scope anchor rather than a conversation, every thread
 * listing and search excludes its threads.
 */
export { GLOBAL_BROWSER_PROJECT_ID, GLOBAL_BROWSER_THREAD_ID } from '../types/project'

/**
 * The shape of one global browser tab's id. A tab's note is keyed by this same
 * id, so the main-process validators, the note handlers and the renderer's own
 * persistence all read the rule from here instead of keeping a copy each.
 */
export const BROWSER_TAB_ID_PATTERN = /^browser:[a-zA-Z0-9:_-]{1,240}$/u

export function isBrowserTabId(value: unknown): value is string {
  return typeof value === 'string' && BROWSER_TAB_ID_PATTERN.test(value)
}

/** Native browser content rectangle in BrowserWindow density-independent pixels. */
export interface BrowserViewBounds {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Why one browser tab's page could not be shown.
 *
 * `kind` names the layer that failed so a surface picks its copy without
 * re-deriving Chromium's numbering: `network` is a net error, `http` is a
 * status the server answered with, and `crashed` is a renderer that stopped.
 */
export type BrowserLoadFailureKind = 'network' | 'http' | 'crashed'

/**
 * A failure that left a browser tab with no page to show.
 *
 * This is metadata about the load, never page content: the raw code and the
 * text Chromium or the server reported. The renderer turns it into copy.
 */
export interface BrowserLoadError {
  kind: BrowserLoadFailureKind
  /**
   * Chromium's net error code (negative), or the HTTP status the server answered
   * with, or the renderer's exit code. `0` when the layer reported none.
   */
  code: number
  /** Chromium's own text: the net error name, the HTTP status text, or the crash reason. */
  description: string
}

/** Navigation state mirrored from an app-scoped browser WebContentsView. */
export interface BrowserPageState {
  tabId: string
  url: string
  title: string
  /** Favicon data URL reported by the page, or null until the page declares one. */
  favicon: string | null
  loading: boolean
  /** The failure that left this tab with no page, or null while it has one. */
  loadError: BrowserLoadError | null
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
 * The app's own theme tokens, which the page overlay draws itself with.
 *
 * The overlay is injected page script, so it cannot read the application's
 * stylesheet. It is handed the resolved values of the app's design tokens
 * instead, which is what keeps a pin and the comment it belongs to the same
 * colour in light and dark mode rather than a hardcoded white box on a dark
 * application.
 */
export interface BrowserInspectorTheme {
  /** Panel and pin background. */
  surface: string
  /** Raised background (the comment field, hovered buttons). */
  elevated: string
  /** Hairline border. */
  border: string
  /** Primary text. */
  foreground: string
  /** Secondary text. */
  muted: string
  /** The app's accent, used for a pin that carries a comment. */
  accent: string
}

/**
 * What the injected inspector reports back to the app.
 *
 * `pick` is a fresh element selection, `open` is the user clicking an existing
 * pin to read or edit its comment, and `closed` is inspect mode ending on its
 * own (Escape, or the script giving up) so the surface showing the tab can
 * reset its toggle.
 *
 * There is deliberately no `comment` event. A comment is written in the app's
 * own editor, which is the component the rest of the application already uses
 * for the same job, so the page never owns comment text and never reports one.
 */
export type BrowserInspectorEvent =
  | { kind: 'pick'; id: string; target: BrowserInspectorTarget }
  | { kind: 'open'; id: string }
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
  'newTab',
  'toggleNotes'
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
export type BrowserPanelShortcutAction = 'focus-address' | 'close-tab' | 'new-tab' | 'toggle-notes'

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
