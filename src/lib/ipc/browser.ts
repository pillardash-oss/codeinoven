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

/**
 * The shape of one popup window's id.
 *
 * A popup window is not a tab: it belongs to the tab whose page opened it, it
 * is hosted by the app's own view rather than by an operating-system window, and
 * it lives exactly as long as the page inside it does. Its id names that
 * lifetime, so every handler that takes one can read the rule from here rather
 * than keep a copy.
 */
export const BROWSER_POPUP_WINDOW_ID_PATTERN = /^popup:[a-zA-Z0-9:_-]{1,240}$/u

export function isBrowserPopupWindowId(value: unknown): value is string {
  return typeof value === 'string' && BROWSER_POPUP_WINDOW_ID_PATTERN.test(value)
}

/**
 * One popup window a page opened, as the rail renders it.
 *
 * A popup window is a page's own `window.open` with a window in it: a sign-in,
 * a checkout, a share dialog. The app hosts the page itself instead of letting
 * the operating system open a window, so the rail can show one tab per popup.
 * This record is metadata about that page, never its content.
 */
export interface BrowserPopupWindow {
  id: string
  /**
   * The browser tab whose page opened this popup. The rail panel belongs to
   * that tab, and closing it closes what it opened.
   */
  tabId: string
  projectId: string
  /** Address the popup is showing, or `about:blank` while it has none yet. */
  url: string
  title: string
  /** Favicon data URL the popup reported, or null until it declares one. */
  favicon: string | null
  loading: boolean
  /**
   * The extension whose own popup this is, or null when a page opened it with
   * `window.open`.
   *
   * An extension's popup has no window to come from, because Electron draws no
   * toolbar and no action popup for one to hang from: the rail itself is its host.
   * The id is carried so the rail can name the popup after the extension and draw
   * the extension's own icon rather than a page title its page may never set.
   */
  extensionId: string | null
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
  /**
   * The surface the tab belongs to: its project and the thread that owns it.
   *
   * A tab's page state is the one report every browser store sees, whichever
   * surface is showing the tab, so a reader that has to tell a thread browser's
   * page from the global browser's needs the ownership here rather than having to
   * look the tab up. `browser-global` is the global browser's own project id.
   */
  projectId: string
  threadId: string
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
 * The app's scrollbar colours, pushed to every browser tab so a page's own
 * scrollbar is drawn in the application's palette instead of the platform
 * default.
 *
 * It is installed as a *user-origin* stylesheet, which is the whole point: author
 * styles outrank user styles in the cascade, so a site that styles its own
 * `::-webkit-scrollbar` (or `scrollbar-color`) keeps it, and only the default
 * scrollbar is brought on brand.
 */
export interface BrowserScrollbarTheme {
  /** The thumb, matching the app's own `::-webkit-scrollbar-thumb`. */
  thumb: string
  /** The thumb on hover, matching the app's own hover rule. */
  thumbHover: string
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
  'toggleNotes',
  'find',
  'findNext',
  'findPrevious'
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
 * The Ctrl+Tab switcher chords, resolved per platform.
 *
 * The switcher is a renderer DOM surface, but a key pressed in a native browser
 * page never reaches it. Main claims these chords in the page and forwards the
 * gesture, so the app's switcher opens from inside a page too. It is a flat list
 * rather than a per-action table because the switcher has one gesture: main only
 * reports whether Shift was held, and the renderer decides the direction.
 */
export type BrowserSwitcherBindings = BrowserShortcutChord[]

/** One switcher gesture forwarded from a key pressed in a native page. */
export interface BrowserSwitcherKey {
  /** Whether Shift was held, i.e. the user is cycling backward. */
  backward: boolean
}

/**
 * A browser action the renderer owns, because only the renderer knows the tab
 * strip or holds the find bar: focusing the address bar, closing or opening a
 * tab, showing the tab's notes, and find.
 */
export type BrowserPanelShortcutAction =
  | 'focus-address'
  | 'close-tab'
  | 'new-tab'
  | 'toggle-notes'
  | 'find'
  | 'find-next'
  | 'find-previous'

/**
 * One find request for a tab's page.
 *
 * The page is a native `WebContentsView`, so the search itself is Chromium's
 * own and the renderer can only ask for it. `findNext` asks the page to keep the
 * session it already has and move within it, which is what makes next/previous a
 * step rather than a fresh search; a new query sends `findNext: false` so the
 * session restarts at the first match.
 */
export interface BrowserFindRequest {
  /** The text to find. An empty text clears the page's highlight. */
  text: string
  /** The direction the session moves in. */
  forward: boolean
  /** Continue the existing session instead of starting a new one. */
  findNext: boolean
  /** Match the text case-sensitively. */
  matchCase: boolean
}

/**
 * What Chromium's find reported for a tab, as the find bar draws it.
 *
 * `matches` is the page's own count of every match and `activeMatchOrdinal` is
 * the 1-based position of the one the page is scrolled to, so `0/0` is the
 * honest reading of a page with no match rather than an assumed empty result.
 */
export interface BrowserFindResult {
  tabId: string
  /** The text this result belongs to, so a bar that has moved on can ignore it. */
  text: string
  matches: number
  activeMatchOrdinal: number
}

/**
 * How a find session ends.
 *
 * `clearSelection` drops the page's highlight, which is what closing the bar
 * means; `keepSelection` leaves the highlight on screen, which is what stepping
 * away from the field means; `activateSelection` leaves it and focuses the
 * match, which is what a page wants when the bar closes onto its result.
 */
export type BrowserFindStopAction = 'clearSelection' | 'keepSelection' | 'activateSelection'

/** Ownership metadata for a browser tab requested by the main process. */
export interface BrowserOpenRequestContext {
  projectId: string
  threadId: string
  requestedTabId?: string
  reveal: boolean
  /**
   * The box the created or revealed tab runs in, or null/absent for the
   * context's own jar. Main resolves it from the owning tab, so the renderer's
   * row and the session agree about which jar the page lives in.
   */
  boxId?: string | null
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
 * Why a tab is being destroyed, which decides what happens to its history.
 *
 * The same channel serves both outcomes, and they are opposites: `hibernated`
 * frees the page while the tab itself stays in the strip, so its Back/Forward
 * stack is written down first; `closed` removes the tab, so its stack goes with
 * it. Main cannot tell the two apart on its own, so the surface that decided says
 * which one it is.
 */
export type BrowserTabDestroyReason = 'closed' | 'hibernated'

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
  /**
   * URL of the frame that logged the message, or null when the event named no
   * frame (a failed navigation, a renderer that stopped).
   *
   * `sourceId` names the script and is not a substitute: it is empty for a
   * document that has no address of its own, and one page logs from several
   * frames. Which frame spoke is the whole answer for a message that says
   * something was refused for "the document" rather than for a script, because
   * the frame URL is what names that document.
   */
  frameUrl: string | null
}

/** Lifecycle state of a download started by an app-scoped browser tab.
 *  `interrupted` covers both a download the server cut short and one the app
 *  itself stopped keeping (a quit, or a restart that found bytes on disk); a
 *  `resumable` interrupted download has its bytes kept and can continue, while a
 *  `cancelled` one discarded them and can only be started again. */
export type BrowserDownloadState = 'progressing' | 'interrupted' | 'completed' | 'cancelled'

/** Where an installed extension's files came from. */
export type BrowserExtensionSource = 'webstore' | 'folder'

/**
 * How the install-time compatibility preamble reached the extension's service
 * worker.
 *
 * Electron compiles out several `chrome.*` namespaces and an extension's worker
 * has no other injection point, so the preamble is written into the copy the app
 * owns. Which shape it takes is forced by the manifest: a module worker evaluates
 * its hoisted imports before any statement in its own body, so it needs a
 * bootstrap module that imports the preamble first, while a classic worker gets
 * the preamble prepended.
 */
export type BrowserExtensionInjection =
  'module-bootstrap' | 'prepend-classic' | 'prepend-mv2' | 'none'

/**
 * One installed browser extension as the renderer sees it.
 *
 * Deliberately carries no filesystem paths: the extension store owns where the
 * files live, and the surface only needs what it draws and what the user can
 * change. `missingCapabilities` is populated from what the extension itself
 * reported, so a row can say which capabilities the runtime could not give it
 * rather than implying it is whole.
 */
export interface BrowserExtension {
  /** The Chromium id, pinned at install so it is the publisher's official one and
   *  not a hash of wherever the app happened to unpack it. */
  id: string
  name: string
  version: string
  description: string
  source: BrowserExtensionSource
  /** The Web Store id it was fetched by, or null for a folder install. */
  webstoreId: string | null
  /** A data URL of the extension's own manifest icon, or null when it declares
   *  none. The extension supplies the bytes, so it is drawn as an image only. */
  iconDataUrl: string | null
  /** Whether it is loaded into any jar at all. */
  enabled: boolean
  /**
   * The jars it runs in: box ids, with the empty string standing for the
   * context's own jar (no box). A jar it is not listed in never loads it, which is
   * the whole point of containing an extension per box: an extension costs a
   * renderer in each jar that loads it. An empty list means installed but loaded
   * nowhere yet, which is how every install starts.
   */
  boxes: string[]
  /** The popup document the extension declares, or null when it has none. */
  popupPath: string | null
  /**
   * Whether the user pinned it into the app header.
   *
   * A pin is a place in the app's own chrome, so it is bounded
   * (`MAX_PINNED_EXTENSIONS`) and it only means something for an extension that
   * declares a popup: opening that popup is the only thing a pin can do.
   */
  pinned: boolean
  /** Namespaces the runtime lacks that this extension declares or reaches for, so
   *  the row can state what it cannot do. */
  missingCapabilities: string[]
  /** Anything that went wrong without being fatal: an update that could not be
   *  re-injected, an icon that could not be read, and so on. */
  warnings: string[]
  /** Which preamble shape was injected, or 'none'. */
  injected: BrowserExtensionInjection
  /** Epoch milliseconds, for ordering the list. */
  installedAt: number
}

/** What an install asks for. */
export interface BrowserExtensionInstallInput {
  source: BrowserExtensionSource
  /** A Web Store id, a Web Store URL, or the folder to install from. */
  value: string
  /**
   * The jars it is loaded into as soon as it is installed: box ids, with the empty
   * string for the context's own jar.
   *
   * Explicit and always a list. An install lands in the jar the user was looking at
   * and nowhere else, and the other jars are turned on from the extension's own
   * settings, so no install can load a copy into every box by omission. An empty
   * list means installed and loaded nowhere yet.
   */
  boxes?: string[]
}

/** One step of an install, so a fetch and an unpack that take seconds are not a
 *  silent freeze and a failure says which step failed. */
export interface BrowserExtensionProgress {
  /** The Web Store id or folder name the install is for, so a progress line can be
   *  attributed before the extension has an id. */
  label: string
  phase:
    | 'resolving'
    | 'downloading'
    | 'unpacking'
    | 'pinning'
    | 'compat'
    | 'registering'
    | 'done'
    | 'failed'
  detail: string
  receivedBytes: number
  totalBytes: number
}

/**
 * Metadata for a download started inside the app-scoped browser. Contains no
 * cookies, headers, or page content: only what the download manager needs to
 * render progress and offer resume/retry/cancel/open/reveal actions.
 *
 * Records survive quitting and reopening the app, so this describes a download
 * the current run never watched as well as one it is downloading right now.
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
  /**
   * Whether the bytes already downloaded are still on disk, so `Resume`
   * continues this download instead of starting it over. False while a download
   * is cancelled or finished, and for an interrupted one whose partial file is
   * gone (deleted by hand, or discarded by a crash).
   */
  resumable: boolean
  /** Epoch milliseconds the download started, so a record kept from an earlier
   *  run can say when it began rather than looking brand new. */
  startedAt: number
}
