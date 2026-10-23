/**
 * The reserved ownership context of the global (personal) browser workspace.
 *
 * Every browser tab is keyed by a `(projectId, threadId)` pair in the main
 * process, and its session partition is normally derived from `projectId`. A tab
 * that names a box is the exception: a box is one jar for the whole profile, so
 * every context that picks it joins the one Chromium profile it names. The
 * global browser deliberately rides the same machinery with one reserved pair,
 * which gives its own jar a single durable profile
 * (`persist:codeinoven-browser:browser-global`) shared by every global tab,
 * isolated from every project's own jar and from the agent-controlled project
 * sessions.
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
  /** Changes when an extension action explicitly asks the app to show this page. */
  activationSequence: number
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
 * An extension's own side panel, hosted in the rail.
 *
 * Electron compiles `chrome.sidePanel` out, so an extension that declares a panel
 * has no host of its own. The app hosts the extension's own document, loaded from
 * its own origin in the jar the extension runs in, over the rectangle the rail
 * measures for it, exactly as it hosts an extension's action popup. This record is
 * metadata about the panel, never its content.
 */
export interface BrowserExtensionSidePanel {
  extensionId: string
  /** Display name, so the rail names the panel without a second lookup. */
  extensionName: string
  /** The app browser tab this panel belongs to. */
  appTabId: string
  /** The project whose tab hosts the panel, so the rail scopes it. The panel's
   *  jar is whatever that tab runs in, the project's own or a shared box. */
  projectId: string
  /** The extension-relative path it asked to show. */
  path: string
  /** Absolute `chrome-extension://` address the panel document is loaded from. */
  url: string
  /** Title of the panel document, or the extension's name until it sets one. */
  title: string
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

/**
 * The page a conversation's thread browser is in use on.
 *
 * The thread browser is the browser a conversation shares with its agent, so
 * main has to know which tab it is on: without this binding an agent could only
 * reach a page it opened itself, and the page the user is reading would be
 * invisible to it. It is a reference to a tab rather than to an address, so a
 * navigation under it keeps answering, and it carries what main needs to mount
 * that page when this process holds no view for it (a tab restored from a
 * previous launch). The renderer reports it; no agent operation changes which
 * tab the thread browser is on.
 */
export interface BrowserThreadBrowserPage {
  tabId: string
  /** The project and thread that own the tab the browser is on. */
  projectId: string
  threadId: string
  /** The cookie box the tab runs in, or null for the conversation's own jar. */
  boxId: string | null
  /** The address the tab is on, or the empty string for a blank tab. */
  url: string
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
  /** Selected cookie box, or null for this context's own jar. */
  boxId: string | null
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
 * One exact frame of a composition, kept as a picture the user can draw on.
 *
 * A composition is a page rather than a video file, so its frame exists on
 * screen for one repaint and nowhere on disk. Answering a note on one therefore
 * needs the frame itself: the second it was drawn at, written out as a still the
 * annotation surface can show and the send path can read back.
 *
 * The second is the frame's identity, so it travels with the picture rather than
 * being re-derived from a playhead that has since moved. It is reported to the
 * millisecond, which is the resolution a frame boundary is decided at.
 */
export interface CompositionFrameSnapshot {
  /** Project-relative path of the written PNG, e.g. `.cio/work/video-frames/hero/…` */
  path: string
  /** Serve URL for the same file, which is what the renderer displays. */
  url: string
  /** The exact second the frame was drawn at. */
  seconds: number
  /** That second as `M:SS.mmm`, the form a descriptor and a label show. */
  timecode: string
  /** The frame index the second falls on, so a reader can name it exactly. */
  frame: number
  /** Frames per second the composition declares. */
  fps: number
  /** How long the composition runs, in seconds. */
  duration: number
  /** The composition folder the frame belongs to, project-relative. */
  directory: string
  /** Pixels the picture was captured at. */
  width: number
  height: number
}

/**
 * One playback action on a composition tab.
 *
 * `seek` and `loop` carry a value; the rest take none. The set is closed and a
 * command names a function the transport defines, so no part of a caller's input
 * is ever evaluated as code.
 */
export type BrowserTransportCommand =
  'play' | 'pause' | 'toggle' | 'stop' | 'seek' | 'freeze' | 'loop'

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
  /**
   * The page's own viewport at pick time, in CSS pixels.
   *
   * An element's rectangle says how big it was, not what it was laid out
   * against: the same card is 360 wide on a phone and 1280 wide on a desktop,
   * and a comment written against one of them is a comment about that layout.
   * Carrying the viewport with the pick is what lets a model read "this looks
   * cramped" as a phone-width problem instead of asking which size it was.
   */
  viewport: BrowserInspectorViewport
}

/** The page's viewport size in CSS pixels. */
export interface BrowserInspectorViewport {
  width: number
  height: number
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
 * instead, which is what keeps a pin and the hover label the same colour and the
 * same type as the app in light and dark mode rather than a hardcoded white box
 * on a dark application.
 */
export interface BrowserInspectorTheme {
  /** Panel and pin background. */
  surface: string
  /** Raised background (the hovered pin). */
  elevated: string
  /** Hairline border. */
  border: string
  /** Primary text. */
  foreground: string
  /** Secondary text. */
  muted: string
  /** The app's accent, used for a pin that carries a comment. */
  accent: string
  /** The app's own font stack, which the label is set in. */
  font: string
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
 * `pick` is a fresh element selection, carrying the element's place in the app
 * window's own coordinates (`anchor`) so the app can put its comment bubble next
 * to it. `open` is the user clicking an existing pin to read or edit that
 * comment. `closed` is inspect mode ending on its own (Escape, or the script
 * giving up) so the surface showing the tab can reset its toggle.
 *
 * The comment text is deliberately absent: the bubble is the app's own
 * component, so the text is written and owned by the renderer and never travels
 * through the page.
 */
export type BrowserInspectorEvent =
  | { kind: 'pick'; id: string; target: BrowserInspectorTarget; anchor: BrowserInspectorRect }
  | { kind: 'open'; id: string; anchor: BrowserInspectorRect }
  | { kind: 'closed' }

/** DevTools open/closed state for a browser tab. */
export interface BrowserDevToolsState {
  tabId: string
  open: boolean
}

/**
 * What the browser surface claims while it owns the keyboard.
 *
 * The set is the chords a browser reserves and no page can answer: reload and
 * hard reload, history back and forward, focusing the address bar, zoom,
 * DevTools, and the tab actions. A page holds the keyboard through its own view,
 * so a key pressed in a page would otherwise reach the application menu; these
 * are claimed so it acts on the page instead.
 *
 * Most of the set is the browser's reserved chrome, which no page can answer and
 * which the app therefore claims whether or not the user lets a site override the
 * app's keymaps. `savePage` is the one page-overridable member: a site that draws
 * its own Save handler keeps `mod+s` and this only runs for a site that does not.
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
  'designUndo',
  'designRedo',
  'closeTab',
  'newTab',
  'reopenTab'
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
 * One keyboard chord a page did not handle, reported up so the app can act on it.
 *
 * The page is a native `WebContentsView`, so a key pressed in it never reaches the
 * renderer's DOM handlers, and a page that draws its own shortcut (its own find,
 * its own save) must keep the chord. An injected page script therefore reports a
 * chord only when the page's own handlers left it unhandled, and main replays it as
 * this shape: enough of the DOM event to rebuild one the app's keymap can match.
 */
export interface BrowserPageKey {
  /** Lowercase `KeyboardEvent.key` the chord ends on, e.g. `'k'`. */
  key: string
  /** `KeyboardEvent.code`, for the handlers that read a physical key. */
  code: string
  meta: boolean
  control: boolean
  shift: boolean
  alt: boolean
  /** True for an auto-repeated press while the key is held. */
  repeat: boolean
}

/**
 * A browser action the renderer owns, because only the renderer knows the tab
 * strip or holds the address field: focusing the address bar, closing, opening
 * or reopening a tab, and the design screen history.
 */
export type BrowserPanelShortcutAction =
  'design-undo' | 'design-redo' | 'focus-address' | 'close-tab' | 'new-tab' | 'reopen-tab'

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
  /** Start a new Chromium find session; false steps within the current one. */
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
  /** Ephemeral native page, adopted into the saved tab list only on expansion. */
  peek?: boolean
  /** Browser tab whose page opened this peek or sibling. */
  sourceTabId?: string
  projectId: string
  threadId: string
  requestedTabId?: string
  reveal: boolean
  /**
   * The rectangle on screen a peek's opening flight starts from, in the window's
   * own pixels: the link the user clicked, or a box around the click when the
   * page named no link. Absent for a tab, which has no source to grow out of.
   */
  origin?: BrowserViewBounds | null
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
  /** macOS denied access after the user allowed the site-level request. */
  systemAccessDenied: boolean
}

/** A permission a page can be granted or blocked, and the state it holds. */
export type BrowserSitePermissionState = 'allow' | 'block' | 'ask'

/** What the renderer needs to open the Site Permissions modal for one origin.
 *  `states` is keyed by the shared catalog's permission id. */
export interface BrowserSitePermissionsPrompt {
  projectId: string
  boxId: string | null
  host: string
  origin: string
  states: Record<string, BrowserSitePermissionState>
}

/** One capture source the in-app screen-share picker offers. */
export interface BrowserScreenShareSource {
  id: string
  name: string
  /** A `data:` URL thumbnail, or null when the platform gave none. */
  thumbnailDataUrl: string | null
  kind: 'screen' | 'window'
}

/** What the renderer needs to draw the in-app screen-share picker. The system
 *  picker is preferred where the platform has one; this is the fallback. */
export interface BrowserScreenSharePrompt {
  requestId: string
  origin: string
  host: string
  sources: BrowserScreenShareSource[]
}

/** A permission requested by a page inside the project-scoped browser session. */
export interface BrowserPermissionRequest {
  id: string
  tabId: string
  projectId: string
  origin: string
  permission: string
  mediaTypes: string[]
  /**
   * The external address the page asked the operating system to open, present
   * only for a handoff (`permission` is `external-protocol`). A request that
   * carries it is confirmed by the same prompt card as a permission and, when
   * allowed, opens through the OS instead of granting anything to the page.
   */
  externalUrl?: string
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
  /** A newer Web Store version found by the background check, or null. */
  updateAvailableVersion: string | null
  /** A data URL of the extension's own manifest icon, or null when it declares
   *  none. The extension supplies the bytes, so it is drawn as an image only. */
  iconDataUrl: string | null
  /** Whether it is loaded into any jar at all. */
  enabled: boolean
  /**
   * The jars it runs in: box ids, with the empty string standing for the
   * context's own jar (no box). A box id is one identity of the profile rather
   * than of a context, so every context that picks that box loads the extension
   * in the same shared jar. A jar it is not listed in never loads it, which is
   * the whole point of containing an extension per box: an extension costs a
   * renderer in each jar that loads it. An empty list means installed but loaded
   * nowhere yet, which is how every install starts.
   */
  boxes: string[]
  /** The popup document the extension declares, or null when it has none. */
  popupPath: string | null
  /** The options document the extension declares, or null when it has none. */
  optionsPath: string | null
  /** Hosts where this extension never runs. Empty means no per-site block. */
  blockedHosts: string[]
  /** When non-empty, the only hosts where this extension runs. */
  allowedHosts: string[]
  /**
   * Whether the user pinned it into the browser view's header.
   *
   * A pin is a place in that view's chrome, so it is bounded
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
  /**
   * The caller's own id for this install, and the key every progress line for it
   * carries.
   *
   * Installs run two at a time and queue behind each other, so a stream of
   * unlabelled steps would no longer say which extension it was describing. The
   * renderer mints this before the call so it can name the install from the
   * moment the user clicks, rather than waiting for main to read a name out of
   * the package.
   */
  installId: string
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
  /** The install this line belongs to, exactly as the caller of
   *  {@link BrowserExtensionInstallInput} named it. */
  installId: string
  /** The Web Store id or folder name the install is for, so a progress line can be
   *  attributed before the extension has an id. */
  label: string
  /** The Web Store id this install is for, or null when it came from a folder.
   *  The store page's own surfaces match their offer to its install with this. */
  webstoreId: string | null
  phase:
    /** Accepted and waiting for one of the running installs to finish. */
    | 'queued'
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
 * One extension's action state for one tab, as the extension itself set it.
 *
 * Only the fields the extension actually set are present: a tab's entry is
 * merged over the extension's own, so an absent field means "inherit", while an
 * empty string is a badge the extension cleared. It is drawn on the extension's
 * pin in the browser view's header, which is the toolbar this browser has none
 * of.
 */
export interface BrowserExtensionActivity {
  badgeText?: string
  badgeColor?: string
  /**
   * The extension's own icon for its action, as a data URL, or null.
   *
   * The extension records a `chrome-extension://` address for `setIcon`, and that
   * address cannot be drawn where this is drawn: the renderer is a different
   * session with no such extension loaded, and an action icon is not a
   * web-accessible resource. Main reads the bytes out of the extension's own folder
   * instead, so what arrives here is already drawable.
   *
   * Null covers both "it set no icon" and "the app cannot draw the one it set",
   * which the pin reads the same way: fall back to the extension's manifest icon.
   */
  iconUrl?: string | null
  title?: string | null
  /** Epoch milliseconds of the snapshot this entry came from. */
  updatedAt: number
}

/**
 * One action-state change, as it crosses to the renderer.
 *
 * `tabId` null is the extension's state for every tab of its box. `reset` means
 * the worker restarted and forgot everything it had recorded, so the renderer
 * drops the extension's entries before applying whatever follows.
 */
export interface BrowserExtensionActivityUpdate {
  boxId: string
  extensionId: string
  tabId: string | null
  activity: BrowserExtensionActivity | null
  reset?: boolean
}

/**
 * One menu item as an extension recorded it through `contextMenus.create`.
 *
 * The tree is forwarded to the native context menu of the page the extension
 * runs beside, and a chosen item travels back as `contextMenus.onClicked`.
 */
export interface BrowserExtensionMenuRecord {
  id: string
  /** The value `create` answered with, so a click carries back exactly what the
   *  extension compared against. */
  rawId: string | number
  parentId: string | null
  title: string
  type: string
  contexts: string[]
  enabled: boolean
  checked: boolean
  documentUrlPatterns: string[]
  targetUrlPatterns: string[]
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
