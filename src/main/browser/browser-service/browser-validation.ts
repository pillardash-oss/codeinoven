/**
 * Input validation and shared limits for the embedded browser. Every renderer
 * IPC argument and every page-supplied value passes through one of these
 * validators before the service touches it.
 */

import type {
  BrowserInspectorMarker,
  BrowserInspectorTheme,
  BrowserPermissionDecision,
  BrowserScrollbarTheme,
  BrowserShortcutAction,
  BrowserShortcutBindings,
  BrowserShortcutChord,
  BrowserSwitcherBindings,
  BrowserSiteDataScope,
  BrowserTransportCommand,
  BrowserViewBounds
} from '../../../lib/ipc-contract'
import {
  BROWSER_SHORTCUT_ACTIONS,
  isBrowserPopupWindowId,
  isBrowserTabId
} from '../../../lib/ipc-contract'
import {
  buildBrowserSearchUrl,
  MAX_BROWSER_SEARCH_ENGINE_NAME_LENGTH,
  MAX_BROWSER_SEARCH_URL_TEMPLATE_LENGTH,
  type BrowserSearchEngine
} from '../../../lib/browser-search-engines'
import type { BrowserViewport } from './browser-types'
import type {
  ToastOverlayAck,
  ToastOverlayInteraction,
  ToastOverlayInteractionReport,
  ToastOverlayKind,
  ToastOverlayRequest,
  ToastOverlayToast
} from '../../../lib/toast-overlay'

export const BROWSER_PARTITION_PREFIX = 'persist:codeinoven-browser:'

/** Session partition one browser context runs in, boxed or not. The download
 *  manager has to reach the same session the browser's tabs use, so the naming
 *  lives here rather than being spelled out at each caller. */
export function browserPartitionFor(projectId: string, boxId: string | null = null): string {
  return boxId === null
    ? `${BROWSER_PARTITION_PREFIX}${projectId}`
    : `${BROWSER_PARTITION_PREFIX}${projectId}${BROWSER_BOX_PARTITION_INFIX}${boxId}`
}

/** Separates one box's jar from the context's own jar inside a partition name. */
export const BROWSER_BOX_PARTITION_INFIX = ':box:'

/** Ceiling on a box id. The renderer's store mints these, so the shape is an id,
 *  never a name the user typed. */
const MAX_BOX_ID_LENGTH = 64
const BOX_ID_PATTERN = new RegExp(`^[a-zA-Z0-9:._-]{1,${MAX_BOX_ID_LENGTH}}$`, 'u')

/** A box id from the renderer, or null for the context's own jar.
 *
 *  Null is deliberately not a special case downstream: it is what every tab that
 *  predates boxes already is, and it produces today's exact partition string, so
 *  \"no box whatsoever\" is the same code path rather than a branch of its own. */
export function validateOptionalBoxId(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string' || !BOX_ID_PATTERN.test(value)) {
    throw new TypeError('Browser box ID is invalid')
  }
  return value
}

/** Whether a partition string belongs to one context's browser, boxed or not.
 *  Context ids can be prefixes of each other, so this is an exact match plus the
 *  infix, never a bare prefix test. */
export function partitionBelongsToProject(partition: string, projectId: string): boolean {
  const own = browserPartitionFor(projectId)
  return partition === own || partition.startsWith(`${own}${BROWSER_BOX_PARTITION_INFIX}`)
}
export const MAX_BROWSER_URL_LENGTH = 8192
export const MAX_CONSOLE_ENTRIES = 500
export const MAX_TRACKED_DOWNLOADS = 50
export const DOWNLOAD_EVENT_INTERVAL_MS = 150
export const PERMISSION_TIMEOUT_MS = 60_000
const PROJECT_ID_PATTERN = /^[a-zA-Z0-9:._-]{1,240}$/u
/** Ceiling on a search engine id chosen in the settings page and reported here. */
const MAX_SEARCH_ENGINE_ID_LENGTH = 128
const PERMISSION_REQUEST_ID_PATTERN = /^[a-f0-9-]{36}$/u
const DOWNLOAD_ID_PATTERN = /^[a-f0-9-]{36}$/u
/** Character cap for the "<project> - <thread>" context line shown above
 *  page alert/confirm dialogs, so a long thread title cannot dominate them. */
export const MAX_DIALOG_LABEL_LENGTH = 120

/** A capture above this size is re-encoded as JPEG instead of PNG. A flat design
 *  page stays well under it in PNG, which keeps text crisp for review; a
 *  photo-heavy page would otherwise put megabytes of base64 into the transcript. */
export const SCREENSHOT_MAX_BYTES = 512 * 1024
/** Quality of the JPEG re-encode used only when a capture exceeds the size cap. */
export const SCREENSHOT_JPEG_QUALITY = 82

/** Viewport a tab is laid out at while parked offscreen, until an agent asks for
 *  another one. 1280x800 is a plain desktop size that most responsive layouts
 *  treat as a full desktop. */
export const DEFAULT_PARKED_VIEWPORT: BrowserViewport = { width: 1280, height: 800 }

/** Ceiling on a marker's CSS path, so a hostile or broken page cannot make the
 *  app carry an unbounded string in its marker set. */
export const MAX_INSPECTOR_SELECTOR_LENGTH = 2_000

/**
 * Most popup windows one browser tab may hold open at once.
 *
 * A popup window is hosted by the app's own view, so a page that opens them in
 * a loop would grow the app's view count without limit. A real page opens one
 * or two (a sign-in, a checkout); past a dozen the page is refused, which is the
 * same answer the app gives any other popup it will not host.
 */
export const MAX_POPUP_WINDOWS_PER_TAB = 12

/**
 * Smallest and largest popup window viewport the app lays an offscreen popup out
 * at. A page chooses its own popup size, so the value is clamped rather than
 * trusted: a zero would leave the page with no viewport at all, and a huge one
 * would lay a hidden page out at a size no display has.
 */
const POPUP_VIEWPORT_MIN = 200
const POPUP_VIEWPORT_MAX = 4_096

/** One step of the browser's own zoom. Chromium's zoom level is logarithmic, so
 *  0.5 is the familiar 120% step Chrome takes per press. */
export const ZOOM_STEP = 0.5
/** Chromium's zoom level range (`-5` is ~33%, `5` is ~300%), which the browser
 *  shortcuts clamp to so held key repeats cannot run past it. */
export const MAX_ZOOM_LEVEL = 5

/** Most pins a page may hold at once, so a stuck loop cannot fill the document
 *  and the marker set the renderer publishes stays bounded. */
export const MAX_INSPECTOR_MARKERS = 40

/** Ceiling on a design comment, matching the prompt-reference comment cap in
 *  `chat-engine-pure.ts`, so a comment the panel accepted can never be refused
 *  by the send path. */
export const MAX_INSPECTOR_COMMENT_LENGTH = 2_000

const INSPECTOR_MARKER_ID_PATTERN = /^[a-f0-9-]{36}$/u

/** Chords an action may carry. The keymap binds one or two alternatives per
 *  action, so a larger list is a caller bug rather than a layout. */
const MAX_SHORTCUT_CHORDS_PER_ACTION = 6
/** The switcher is one gesture, so it carries at most these chords. */
const MAX_SWITCHER_CHORDS = 6
/** Ceiling on a chord's key token, matching the longest DOM key name. */
const MAX_SHORTCUT_KEY_LENGTH = 24

/**
 * Validate the browser shortcut table the renderer pushes.
 *
 * The table decides which keys the browser claims before the application menu
 * sees them, so an unchecked entry could claim every key in the app. Only known
 * actions are accepted, an unknown action is dropped rather than fatal (a newer
 * renderer must not break an older interception path), and every chord is a
 * single key with an explicit modifier set.
 */
export function validateBrowserShortcutBindings(value: unknown): BrowserShortcutBindings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Browser shortcut bindings must be an object')
  }
  const source = value as Record<string, unknown>
  const bindings: BrowserShortcutBindings = {}
  for (const action of BROWSER_SHORTCUT_ACTIONS) {
    const rawChords = source[action]
    if (rawChords === undefined || rawChords === null) continue
    if (!Array.isArray(rawChords)) {
      throw new TypeError('Browser shortcut chords must be an array')
    }
    if (rawChords.length > MAX_SHORTCUT_CHORDS_PER_ACTION) {
      throw new TypeError('Browser shortcut chord count exceeds the cap')
    }
    bindings[action as BrowserShortcutAction] = rawChords.map((entry) =>
      validateBrowserShortcutChord(entry)
    )
  }
  return bindings
}

/**
 * Validate the Ctrl+Tab switcher chords pushed by the renderer.
 *
 * The same trust boundary as the action table applies: a bad chord could claim
 * any key in every page, so every entry is a single key with an explicit
 * modifier set, and the list is capped.
 */
export function validateBrowserSwitcherBindings(value: unknown): BrowserSwitcherBindings {
  if (!Array.isArray(value)) {
    throw new TypeError('Browser switcher bindings must be an array')
  }
  if (value.length > MAX_SWITCHER_CHORDS) {
    throw new TypeError('Browser switcher chord count exceeds the cap')
  }
  return value.map((entry) => validateBrowserShortcutChord(entry))
}

function validateBrowserShortcutChord(value: unknown): BrowserShortcutChord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Browser shortcut chord must be an object')
  }
  const chord = value as Record<string, unknown>
  const key = chord['key']
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_SHORTCUT_KEY_LENGTH) {
    throw new TypeError('Browser shortcut chord needs a bounded key')
  }
  for (const modifier of ['meta', 'control', 'shift', 'alt']) {
    if (typeof chord[modifier] !== 'boolean') {
      throw new TypeError('Browser shortcut chord modifiers must be booleans')
    }
  }
  return {
    key: key.toLowerCase(),
    meta: chord['meta'] as boolean,
    control: chord['control'] as boolean,
    shift: chord['shift'] as boolean,
    alt: chord['alt'] as boolean
  }
}

/**
 * Validate the marker set the renderer publishes for a tab.
 *
 * The renderer owns the truth about which elements are commented, and this is
 * the boundary it crosses, so every field is checked rather than trusted: the
 * shape goes straight into an injected page script.
 */
export function validateInspectorMarkers(value: unknown): BrowserInspectorMarker[] {
  if (!Array.isArray(value)) throw new TypeError('Inspector markers must be an array')
  if (value.length > MAX_INSPECTOR_MARKERS) {
    throw new TypeError('Inspector marker count exceeds the cap')
  }
  return value.map((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new TypeError('Inspector marker must be an object')
    }
    const record = entry as Record<string, unknown>
    const id = record['id']
    if (typeof id !== 'string' || !INSPECTOR_MARKER_ID_PATTERN.test(id)) {
      throw new TypeError('Inspector marker id is invalid')
    }
    const number = record['number']
    if (
      typeof number !== 'number' ||
      !Number.isInteger(number) ||
      number < 1 ||
      number > MAX_INSPECTOR_MARKERS
    ) {
      throw new TypeError('Inspector marker number is invalid')
    }
    const comment = record['comment']
    if (typeof comment !== 'string' || comment.length > MAX_INSPECTOR_COMMENT_LENGTH) {
      throw new TypeError('Inspector marker comment is invalid')
    }
    const selector = record['selector']
    if (typeof selector !== 'string' || selector.length > MAX_INSPECTOR_SELECTOR_LENGTH) {
      throw new TypeError('Inspector marker selector is invalid')
    }
    return { id, number, comment, selector }
  })
}

/** The theme tokens the page overlay draws itself with. */
const INSPECTOR_THEME_KEYS = [
  'surface',
  'elevated',
  'border',
  'foreground',
  'muted',
  'accent'
] as const satisfies readonly (keyof BrowserInspectorTheme)[]

/** Ceiling on one token. A CSS colour or a `var()` reference is short; anything
 *  longer is not a colour, and the value ends up in an injected page script. */
const MAX_INSPECTOR_THEME_VALUE_LENGTH = 120

/**
 * Validate the application theme pushed for a tab's page overlay.
 *
 * These values are set as CSS custom properties inside an injected script, so
 * each one is bounded and every expected token is required: a partial theme
 * would leave the overlay half-drawn in the wrong palette, which is the exact
 * bug this push exists to fix.
 */
export function validateInspectorTheme(value: unknown): BrowserInspectorTheme {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Inspector theme must be an object')
  }
  const record = value as Record<string, unknown>
  const theme = {} as BrowserInspectorTheme
  for (const key of INSPECTOR_THEME_KEYS) {
    const raw = record[key]
    if (
      typeof raw !== 'string' ||
      raw.length === 0 ||
      raw.length > MAX_INSPECTOR_THEME_VALUE_LENGTH
    ) {
      throw new TypeError(`Inspector theme token "${key}" is invalid`)
    }
    theme[key] = raw
  }
  return theme
}

/** The two colours the page's default scrollbar is drawn with. */
const SCROLLBAR_THEME_KEYS = [
  'thumb',
  'thumbHover'
] as const satisfies readonly (keyof BrowserScrollbarTheme)[]

/**
 * Validate the app scrollbar colours pushed for every browser tab's page.
 *
 * The values become a user-origin stylesheet, so each one is bounded and checked
 * against the characters that could end the rule it is placed in.
 */
export function validateScrollbarTheme(value: unknown): BrowserScrollbarTheme {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Scrollbar theme must be an object')
  }
  const record = value as Record<string, unknown>
  const theme = {} as BrowserScrollbarTheme
  for (const key of SCROLLBAR_THEME_KEYS) {
    const raw = record[key]
    if (
      typeof raw !== 'string' ||
      raw.length === 0 ||
      raw.length > MAX_INSPECTOR_THEME_VALUE_LENGTH ||
      /[;{}]|<\//u.test(raw)
    ) {
      throw new TypeError(`Scrollbar theme token "${key}" is invalid`)
    }
    theme[key] = raw
  }
  return theme
}

/**
 * Validate the reference a renderer asks the page to highlight, or null for
 * "nothing in particular". It is matched against the marker set the page holds,
 * so it is the same uuid the marker boundary already accepts.
 */
export function validateInspectorReferenceId(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' || !INSPECTOR_MARKER_ID_PATTERN.test(value)) {
    throw new TypeError('Inspector reference id is invalid')
  }
  return value
}

/** How many tabs may render offscreen at once. A parked tab renders exactly like
 *  a displayed one, so the set stays bounded and evicts least-recently-used
 *  first. */
export const MAX_PARKED_TABS = 6
/** A tab the agent just revealed that the user leaves within this window counts
 *  as an ignored reveal. */
export const AGENT_REVEAL_GRACE_MS = 8_000
/** Ignored reveals tolerated before the agent's reveals are muted for a thread. */
export const MAX_ABANDONED_REVEALS = 2
/** How long agent reveals stay muted for a thread after that. */
export const RELAX_COOLDOWN_MS = 5 * 60_000
/** How long a hide the renderer asked for is held before it parks a view.
 *
 *  The renderer detaches a page the moment its visibility answer stops coming out
 *  for it, and that answer is recomputed every frame from state that moves: a
 *  surface mid-transition, an overlay whose rectangle is being re-measured, a
 *  claim published one frame after the surface that needs it. Those answers flap,
 *  and a flap that reaches main pairs a park with a re-attach a few milliseconds
 *  later, which pulls the page off screen for a frame and paints it back: a
 *  flicker of a page nothing asked to move. Holding the hide over a couple of
 *  frames lets the show that follows it cancel it outright, so a page that is
 *  still wanted never leaves the screen, while a page that is genuinely going
 *  still parks a few frames after the click that decided it. */
export const RENDERER_PARK_GRACE_MS = 80
/** Bounds for a requested parked viewport: below the minimum no layout is
 *  meaningful, above the maximum a single page would waste main memory. */
export const MIN_VIEWPORT_SIDE = 240
export const MAX_VIEWPORT_SIDE = 3840
/** Named viewports agents use for responsive checks. */
export const VIEWPORT_PRESETS: Record<string, BrowserViewport> = {
  phone: { width: 390, height: 844 },
  'phone-large': { width: 430, height: 932 },
  tablet: { width: 834, height: 1112 },
  laptop: { width: 1440, height: 900 },
  desktop: { width: 1920, height: 1080 }
}

export const SITE_DATA_SCOPES: readonly BrowserSiteDataScope[] = [
  'cookies',
  'site-data',
  'cache',
  'permissions'
]

/** Storage buckets cleared by `session.clearStorageData()` for each scope.
 *  Cookies get their own scope so "cookies" and "site data" stay separable. */
export const SCOPE_STORAGE_TYPES: Record<
  'cookies' | 'site-data',
  Array<
    | 'cookies'
    | 'filesystem'
    | 'indexdb'
    | 'localstorage'
    | 'shadercache'
    | 'serviceworkers'
    | 'cachestorage'
  >
> = {
  cookies: ['cookies'],
  'site-data': ['cachestorage', 'filesystem', 'indexdb', 'localstorage', 'serviceworkers']
}

/** How many frames of one tab may hold a capture observer at once. A recording
 *  lives in the top document or in one embedded widget, and every observed frame
 *  costs an injected observer plus one pending promise. */
export const MAX_CAPTURED_FRAMES = 48

/** Minimum spacing between two re-arms of one tab's capture observer. A page can
 *  start and stop a capture in a tight loop, and every change costs a
 *  main-process message and a renderer state event. */
export const CAPTURE_REARM_INTERVAL_MS = 120

/** Consecutive failed arms tolerated for one frame before it is abandoned, so a
 *  frame that cannot run the observer is not retried forever. */
export const MAX_CAPTURE_ARM_FAILURES = 3

/** Minimum spacing between two re-arms of one tab's design inspector. Each
 *  answer costs a main-process message and a renderer state event, and a design
 *  reload can end a document mid-wait, so a floor keeps a reload loop from
 *  driving arm/catch cycles without pause. */
export const INSPECTOR_REARM_INTERVAL_MS = 120

/** Consecutive failed arms tolerated for one tab before inspect mode is dropped,
 *  so a page that cannot run the injected script is not retried forever. */
export const MAX_INSPECTOR_ARM_FAILURES = 4

export function validateTabId(value: unknown): string {
  if (!isBrowserTabId(value)) {
    throw new TypeError('Browser tab ID is invalid')
  }
  return value
}

export function validatePopupWindowId(value: unknown): string {
  if (!isBrowserPopupWindowId(value)) {
    throw new TypeError('Browser popup window ID is invalid')
  }
  return value
}

export function validateProjectId(value: unknown): string {
  if (typeof value !== 'string' || !PROJECT_ID_PATTERN.test(value)) {
    throw new TypeError('Browser project ID is invalid')
  }
  return value
}

export function validateThreadId(value: unknown): string {
  if (typeof value !== 'string' || !PROJECT_ID_PATTERN.test(value)) {
    throw new TypeError('Browser thread ID is invalid')
  }
  return value
}

export function browserContextKey(projectId: string, threadId: string): string {
  return `${projectId}:${threadId}`
}

/**
 * Ceiling on one attempt to draw and settle a composition frame.
 *
 * A page that never defines the frame it was asked for, or one whose animation
 * frames are throttled because the tab is parked, would otherwise leave the call
 * outstanding forever and hang the agent's turn on a capture that can never
 * finish. Bounded, the attempt reports and the capture retries or fails with a
 * sentence.
 */
export const FRAME_RENDER_TIMEOUT_MS = 4_000

/**
 * Ceiling on the transport command set, so the shared contract and the runtime
 * that answers it cannot drift apart: a command the union declares but the page
 * does not define would be an eval of an unknown name.
 */
const TRANSPORT_COMMANDS = ['play', 'pause', 'toggle', 'stop', 'seek', 'loop'] as const

/** Ceiling on a playback error, so a page that throws a novel on every frame
 *  cannot push an unbounded message into published tab state. */
export const MAX_TRANSPORT_ERROR_LENGTH = 400

/**
 * Validate one playback action on a composition tab.
 *
 * The set is closed and every member names a function the injected transport
 * defines, so a caller's input selects a command rather than becoming code.
 */
export function validateTransportCommand(value: unknown): BrowserTransportCommand {
  if (typeof value !== 'string' || !(TRANSPORT_COMMANDS as readonly string[]).includes(value)) {
    throw new TypeError('Browser transport command is not a defined playback action')
  }
  return value as BrowserTransportCommand
}

/**
 * Validate the value one command carries.
 *
 * A seek names a non-negative second and a loop change names a boolean, checked
 * rather than coerced: a seek silently read as zero would look like the scrubber
 * jumping to the start, which is a bug report about the wrong thing.
 */
export function validateTransportValue(
  command: BrowserTransportCommand,
  value: unknown
): number | boolean {
  if (command === 'seek') {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new TypeError('A browser seek must name a non-negative number of seconds')
    }
    return value
  }
  if (command === 'loop') {
    if (typeof value !== 'boolean') throw new TypeError('A browser loop change must be a boolean')
    return value
  }
  return 0
}

export function validatePermissionRequestId(value: unknown): string {
  if (typeof value !== 'string' || !PERMISSION_REQUEST_ID_PATTERN.test(value)) {
    throw new TypeError('Browser permission request ID is invalid')
  }
  return value
}

export function validatePermissionDecision(value: unknown): BrowserPermissionDecision {
  if (
    typeof value !== 'string' ||
    (value !== 'allow' && value !== 'allow-once' && value !== 'deny' && value !== 'dismiss')
  ) {
    throw new TypeError('Browser permission decision is invalid')
  }
  return value
}

export function validateDownloadId(value: unknown): string {
  if (typeof value !== 'string' || !DOWNLOAD_ID_PATTERN.test(value)) {
    throw new TypeError('Browser download ID is invalid')
  }
  return value
}

export function validateSiteDataScopes(value: unknown): BrowserSiteDataScope[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > SITE_DATA_SCOPES.length) {
    throw new TypeError('Browser site data scopes must be a non-empty array')
  }
  const unique = new Set(value)
  for (const scope of unique) {
    if (!SITE_DATA_SCOPES.includes(scope as BrowserSiteDataScope)) {
      throw new TypeError(`Browser site data scope is invalid: ${String(scope)}`)
    }
  }
  return [...unique]
}

export function validateSiteMenuPoint(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100_000) {
    throw new TypeError(`Browser site menu ${label} is invalid`)
  }
  return Math.round(value)
}

/** Validate the display host shown at the top of the site-settings menu. */
export function validateBoundedHost(value: unknown): string {
  if (typeof value !== 'string' || value.length > 260 || value.includes('\0')) {
    throw new TypeError('Browser site menu host is invalid')
  }
  return value
}

/** Reduce a server-suggested filename to a safe, absolute-path-free basename. */
export function safeBasename(value: string): string {
  // Substitute every path separator, drive-part, or control character with an
  // underscore, then collapse dots/whitespace so the result is a plain basename.
  let cleaned = ''
  for (const char of value) {
    const code = char.charCodeAt(0)
    const substitute =
      code === 0x2f || // '/'
      code === 0x5c || // '\'
      code === 0x3a || // ':'
      code === 0x2a || // '*'
      code === 0x3f || // '?'
      code === 0x22 || // '"'
      code === 0x3c || // '<'
      code === 0x3e || // '>'
      code === 0x7c || // '|'
      code < 0x20 ||
      code === 0x7f
    cleaned += substitute ? '_' : char
  }
  const normalized = cleaned.replace(/\s+/g, ' ').trim().replace(/^\.+/, '')
  const base = normalized.length > 0 ? normalized.slice(0, 240) : 'download'
  return base
}

/** Like `validateBrowserUrl`, but an absent value means "no URL": a blank tab
 *  is created without an address and must not fail the show handshake. Any
 *  value that is present goes through the full validation. */
export function validateOptionalBrowserUrl(value: unknown): string {
  if (value === undefined || value === null || value === '') return ''
  return validateBrowserUrl(value)
}

export function validateBrowserUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_BROWSER_URL_LENGTH) {
    throw new TypeError('Browser URL must be a string of at most 8192 characters')
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new TypeError('Browser URL is malformed')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError('Browser URL must use http or https')
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new TypeError('Browser URL must not contain credentials')
  }
  return parsed.href
}

/**
 * Whether a popup window may be opened on, and later navigate to, this address.
 *
 * A popup is allowed one document the rest of the browser refuses: `about:blank`.
 * Pages open blank popups deliberately   a checkout or a sign-in writes its form
 * into the new window itself   and refusing that document would break the flow
 * before the popup ever had an address to validate.
 */
export function isAllowedPopupWindowUrl(value: unknown): value is string {
  if (value === 'about:blank') return true
  try {
    validateBrowserUrl(value)
    return true
  } catch {
    return false
  }
}

/**
 * The viewport a popup window asked for in its `window.open` features, or null
 * when it asked for none the app can use.
 *
 * The size is the page's own claim, so it is clamped rather than trusted: it is
 * only ever used to lay the page out at a size while it is off screen, and a
 * page must not be able to ask for a viewport no display has.
 */
export function popupWindowViewport(features: unknown): BrowserViewport | null {
  if (typeof features !== 'string' || features.length === 0) return null
  let width: number | null = null
  let height: number | null = null
  for (const part of features.split(',')) {
    const [rawKey, rawValue] = part.split('=', 2)
    if (rawValue === undefined) continue
    const key = rawKey.trim().toLowerCase()
    if (key !== 'width' && key !== 'height' && key !== 'innerwidth' && key !== 'innerheight') {
      continue
    }
    const value = Number.parseInt(rawValue.trim(), 10)
    if (!Number.isInteger(value)) continue
    const clamped = Math.min(POPUP_VIEWPORT_MAX, Math.max(POPUP_VIEWPORT_MIN, value))
    if (key === 'width' || key === 'innerwidth') width = clamped
    if (key === 'height' || key === 'innerheight') height = clamped
  }
  if (width === null && height === null) return null
  return {
    width: width ?? DEFAULT_PARKED_VIEWPORT.width,
    height: height ?? DEFAULT_PARKED_VIEWPORT.height
  }
}

/**
 * Validate the search engine the renderer reports for the browser's native
 * context menu.
 *
 * Main builds the "Search <engine> for ..." item and the URL it opens, and it
 * holds no config of its own, so the resolved engine arrives over IPC. The
 * template must be able to produce a navigable http(s) URL, which is the same
 * contract the browser's own navigation validation enforces; anything else is
 * refused rather than turned into a dead menu item.
 */
export function validateBrowserSearchEngine(value: unknown): BrowserSearchEngine {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Browser search engine must be an object')
  }
  const record = value as Record<string, unknown>
  const id = record['id']
  const name = record['name']
  const template = record['searchUrlTemplate']
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_SEARCH_ENGINE_ID_LENGTH) {
    throw new TypeError('Browser search engine needs a bounded id')
  }
  if (
    typeof name !== 'string' ||
    name.trim().length === 0 ||
    name.length > MAX_BROWSER_SEARCH_ENGINE_NAME_LENGTH
  ) {
    throw new TypeError('Browser search engine needs a bounded name')
  }
  if (
    typeof template !== 'string' ||
    template.length === 0 ||
    template.length > MAX_BROWSER_SEARCH_URL_TEMPLATE_LENGTH
  ) {
    throw new TypeError('Browser search engine needs a bounded URL template')
  }
  const engine: BrowserSearchEngine = { id, name, searchUrlTemplate: template }
  if (buildBrowserSearchUrl(engine, 'query') === null) {
    throw new TypeError('Browser search engine template cannot produce an http or https URL')
  }
  return engine
}

function validatedViewportSide(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`Browser viewport ${label} must be a number`)
  }
  const rounded = Math.round(value)
  if (rounded < MIN_VIEWPORT_SIDE || rounded > MAX_VIEWPORT_SIDE) {
    throw new TypeError(
      `Browser viewport ${label} must be between ${MIN_VIEWPORT_SIDE} and ${MAX_VIEWPORT_SIDE}`
    )
  }
  return rounded
}

/** Resolve an agent-supplied viewport request: a named preset, or explicit
 *  sides, or nothing at all (which keeps the tab's current viewport). */
export function validateViewportRequest(value: unknown, current: BrowserViewport): BrowserViewport {
  if (value === undefined || value === null) return current
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Browser viewport must be an object')
  }
  const request = value as Record<string, unknown>
  const preset = request['preset']
  const width = request['width']
  const height = request['height']
  if (preset !== undefined) {
    // Own properties only: `in` would accept prototype keys like "toString" and
    // hand back a viewport with no sides at all.
    if (typeof preset !== 'string' || !Object.hasOwn(VIEWPORT_PRESETS, preset)) {
      throw new TypeError(
        `Browser viewport preset must be one of: ${Object.keys(VIEWPORT_PRESETS).join(', ')}`
      )
    }
    return { ...VIEWPORT_PRESETS[preset] }
  }
  if (width === undefined && height === undefined) return current
  if (width === undefined || height === undefined) {
    throw new TypeError('Browser viewport needs both a width and a height')
  }
  return {
    width: validatedViewportSide(width, 'width'),
    height: validatedViewportSide(height, 'height')
  }
}

/** Attention an agent asked for when it opened a page. */
export function validateAttention(value: unknown): BrowserOpenAttention {
  if (value === undefined || value === null) return 'focus'
  if (typeof value !== 'string' || (value !== 'focus' && value !== 'background')) {
    throw new TypeError('Browser attention must be "focus" or "background"')
  }
  return value
}

export type BrowserOpenAttention = 'focus' | 'background'

export function validateBounds(value: unknown): BrowserViewBounds {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Browser bounds must be an object')
  }
  const bounds = value as Record<string, unknown>
  const result: BrowserViewBounds = {
    x: bounds['x'] as number,
    y: bounds['y'] as number,
    width: bounds['width'] as number,
    height: bounds['height'] as number
  }
  for (const coordinate of Object.values(result)) {
    if (!Number.isInteger(coordinate) || coordinate < 0 || coordinate > 100_000) {
      throw new TypeError('Browser bounds must contain non-negative integer coordinates')
    }
  }
  return result
}

/**
 * Whether two validated frames place a view at exactly the same rectangle.
 *
 * Used to tell an actual move from a repeat report: the renderer re-measures its
 * panel once per animation frame while it aligns the native view with an entry
 * transform, and re-parenting or re-sizing a view to the frame it already has is
 * a compositor commit for no difference on screen.
 */
export function isSameBounds(a: BrowserViewBounds, b: BrowserViewBounds): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

/**
 * Whether two viewports lay a page out at the same size. A park that keeps the
 * page at the size it was already laid out at costs it nothing; a park that
 * changes it re-runs layout, which is a reflow the user can see when the view
 * comes back on screen.
 */
export function isSameViewport(a: BrowserViewport | undefined | null, b: BrowserViewport): boolean {
  return a !== undefined && a !== null && a.width === b.width && a.height === b.height
}

/**
 * The most cards the overlay is ever asked to draw. svelte-sonner keeps three on
 * screen at once, and the stack is projected whole, so this only bounds a
 * payload that would otherwise be free to fill a whole window.
 */
export const MAX_OVERLAY_TOASTS = 16

/** Characters kept from one projected text field. A toast is a line or two; the
 *  ceiling is here so a pathological message cannot cross IPC whole. */
const MAX_OVERLAY_TEXT_LENGTH = 4_000

const OVERLAY_KINDS: ReadonlySet<string> = new Set([
  'default',
  'success',
  'error',
  'warning',
  'info',
  'loading'
])

function overlayText(value: unknown, limit = MAX_OVERLAY_TEXT_LENGTH): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  return value.slice(0, limit)
}

function overlayLabel(value: unknown): { label: string } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const label = overlayText((value as Record<string, unknown>)['label'], 120)
  return label === undefined ? undefined : { label }
}

const OVERLAY_INTERACTIONS: ReadonlySet<string> = new Set([
  'action',
  'cancel',
  'dismiss',
  'autoclose'
])

/**
 * Validate one interaction the overlay reports for a card it drew.
 *
 * The overlay cannot run a handler, so this is only ever a fact about what the
 * user did. It is checked because it arrives from a window of its own, and a
 * report naming a toast that no longer exists must be answerable rather than
 * trusted: the app renderer looks the toast up and drops the report when it has
 * already gone.
 */
export function validateToastOverlayInteraction(value: unknown): ToastOverlayInteractionReport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('A toast overlay interaction must be an object')
  }
  const report = value as Record<string, unknown>
  const id = report['id']
  if (typeof id !== 'number' && typeof id !== 'string') {
    throw new TypeError('A toast overlay interaction must name the toast it belongs to')
  }
  const interaction = report['interaction']
  if (typeof interaction !== 'string' || !OVERLAY_INTERACTIONS.has(interaction)) {
    throw new TypeError('A toast overlay interaction must name a known interaction')
  }
  return { id, interaction: interaction as ToastOverlayInteraction }
}

/**
 * Validate the toast stack the app renderer points the overlay at.
 *
 * `null` is a real request: nothing covers the toaster's corner any more, so the
 * overlay takes itself down. Every field is optional in the projection, so a
 * malformed card is dropped rather than rejected whole: one odd toast must never
 * cost the renderer its stack.
 */
export function validateToastOverlayRequest(value: unknown): ToastOverlayRequest {
  if (value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('The toast overlay request must be an object or null')
  }
  const stack = value as Record<string, unknown>
  const rawToasts = stack['toasts']
  if (!Array.isArray(rawToasts)) {
    throw new TypeError('The toast overlay request must carry a toast list')
  }
  if (rawToasts.length > MAX_OVERLAY_TOASTS) {
    throw new TypeError('The toast overlay request carries too many toasts')
  }
  const toasts: ToastOverlayToast[] = []
  for (const raw of rawToasts) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const entry = raw as Record<string, unknown>
    const id = entry['id']
    if (typeof id !== 'number' && typeof id !== 'string') continue
    const title = overlayText(entry['title'])
    if (title === undefined) continue
    const kind = entry['kind']
    const duration = entry['duration']
    toasts.push({
      id,
      kind:
        typeof kind === 'string' && OVERLAY_KINDS.has(kind)
          ? (kind as ToastOverlayKind)
          : 'default',
      title,
      description: overlayText(entry['description']),
      duration:
        typeof duration === 'number' && Number.isFinite(duration) && duration > 0
          ? Math.min(duration, 60_000)
          : undefined,
      style: overlayText(entry['style']),
      closeButton: entry['closeButton'] === true ? true : undefined,
      dismissible: typeof entry['dismissible'] === 'boolean' ? entry['dismissible'] : undefined,
      action: overlayLabel(entry['action']),
      cancel: overlayLabel(entry['cancel'])
    })
  }
  return {
    toasts,
    theme: stack['theme'] === 'dark' ? 'dark' : 'light',
    // The revision the overlay echoes back once these cards are drawn. A request
    // without one is not rejected: revision 0 simply never matches what the
    // renderer waits for, so the stack falls back rather than being trusted.
    revision: overlayRevision(stack['revision'])
  }
}

/** The revision a stack is stamped with, or 0 when it carries none. */
function overlayRevision(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0
}

/**
 * Validate the overlay's confirmation that it drew a stack.
 *
 * The ids are not compared against the request here: main is a relay for this
 * one, and the renderer that published the stack is the only place that knows
 * what it published. A malformed acknowledgement is refused rather than passed
 * on, so a broken overlay can never look like a healthy one.
 */
export function validateToastOverlayAck(value: unknown): ToastOverlayAck {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('A toast overlay acknowledgement must be an object')
  }
  const ack = value as Record<string, unknown>
  const revision = ack['revision']
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision <= 0) {
    throw new TypeError('A toast overlay acknowledgement must name the revision it drew')
  }
  const rawDrawn = ack['drawn']
  if (!Array.isArray(rawDrawn) || rawDrawn.length > MAX_OVERLAY_TOASTS) {
    throw new TypeError('A toast overlay acknowledgement must carry the cards it drew')
  }
  const drawn: Array<number | string> = []
  for (const id of rawDrawn) {
    if (typeof id === 'number' || typeof id === 'string') drawn.push(id)
  }
  return { revision, drawn }
}
