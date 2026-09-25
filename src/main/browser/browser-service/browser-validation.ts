/**
 * Input validation and shared limits for the embedded browser. Every renderer
 * IPC argument and every page-supplied value passes through one of these
 * validators before the service touches it.
 */

import type {
  BrowserInspectorMarker,
  BrowserPermissionDecision,
  BrowserShortcutAction,
  BrowserShortcutBindings,
  BrowserShortcutChord,
  BrowserSiteDataScope,
  BrowserTransportCommand,
  BrowserViewBounds
} from '../../../lib/ipc-contract'
import { BROWSER_SHORTCUT_ACTIONS } from '../../../lib/ipc-contract'
import type { BrowserViewport } from './browser-types'

export const BROWSER_PARTITION_PREFIX = 'persist:codeinoven-browser:'
export const MAX_BROWSER_URL_LENGTH = 8192
export const MAX_CONSOLE_ENTRIES = 500
export const MAX_TRACKED_DOWNLOADS = 50
export const DOWNLOAD_EVENT_INTERVAL_MS = 150
export const PERMISSION_TIMEOUT_MS = 60_000
const TAB_ID_PATTERN = /^browser:[a-zA-Z0-9:_-]{1,240}$/u
const PROJECT_ID_PATTERN = /^[a-zA-Z0-9:._-]{1,240}$/u
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
  if (typeof value !== 'string' || !TAB_ID_PATTERN.test(value)) {
    throw new TypeError('Browser tab ID is invalid')
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
