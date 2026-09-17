/**
 * Input validation and shared limits for the embedded browser. Every renderer
 * IPC argument and every page-supplied value passes through one of these
 * validators before the service touches it.
 */

import type {
  BrowserPermissionDecision,
  BrowserSiteDataScope,
  BrowserViewBounds
} from '../../../lib/ipc-contract'
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

/** Viewport a tab is laid out at while parked offscreen, until an agent asks for
 *  another one. 1280x800 is a plain desktop size that most responsive layouts
 *  treat as a full desktop. */
export const DEFAULT_PARKED_VIEWPORT: BrowserViewport = { width: 1280, height: 800 }

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
