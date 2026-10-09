/**
 * The catalog of site permissions the embedded browser exposes.
 *
 * A page asks Chromium for a permission; the browser session's handlers answer
 * from a decision ledger keyed by `origin\npermission\nscope`. This module is the
 * one place that knows how a human-facing permission ("Camera", "Screen sharing")
 * maps onto those ledger keys, so three surfaces cannot drift apart:
 *
 *   - the main-process session handlers that read and write the ledger,
 *   - the padlock's Site Permissions modal that sets a decision by hand,
 *   - the permission prompt that names what a page is asking for.
 *
 * It is deliberately free of Electron and SvelteKit imports: main, the renderer,
 * and the tests all import it.
 */

import type { BrowserPermissionRequest } from '../ipc-contract'

/**
 * The ledger permission id screen capture is remembered under.
 *
 * Electron delivers `navigator.mediaDevices.getDisplayMedia()` as a `media`
 * request with an *empty* `mediaTypes` list, which is indistinguishable from a
 * bare media check and would collide with the camera/microphone keys. The request
 * is therefore mapped onto this dedicated id, so allowing a screen share can
 * never silently allow the camera.
 */
export const SCREEN_CAPTURE_PERMISSION = 'display-capture'

/** The ledger key for one origin, permission and scope. */
export function permissionKey(origin: string, permission: string, scope = ''): string {
  return `${origin}\n${permission}\n${scope}`
}

/** The origin of a URL, or null when it is not an http(s) site. */
export function permissionOrigin(value: string): string | null {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null
  } catch {
    return null
  }
}

/**
 * True when a `media` permission request is a screen share rather than a camera
 * or microphone request. Electron gives display capture an empty `mediaTypes`
 * list; every device request names at least one type.
 */
export function isScreenCaptureRequest(permission: string, mediaTypes: readonly string[]): boolean {
  return permission === 'media' && mediaTypes.length === 0
}

/**
 * The keys a permission *request* is decided against.
 *
 * Camera and microphone keep one key per media type, so a site can be allowed the
 * microphone and refused the camera. A screen share maps to
 * {@link SCREEN_CAPTURE_PERMISSION}, and every other permission is its own key.
 */
export function permissionKeysForRequest(request: {
  origin: string
  permission: string
  mediaTypes: readonly string[]
}): string[] {
  if (request.permission === 'media') {
    if (isScreenCaptureRequest(request.permission, request.mediaTypes)) {
      return [permissionKey(request.origin, SCREEN_CAPTURE_PERMISSION)]
    }
    return [...new Set(request.mediaTypes)].map((mediaType) =>
      permissionKey(request.origin, request.permission, mediaType)
    )
  }
  return [permissionKey(request.origin, request.permission)]
}

/** The request-shaped convenience the session handlers use. */
export function permissionGrantKeys(request: BrowserPermissionRequest): string[] {
  return permissionKeysForRequest(request)
}

/**
 * The key a synchronous permission check is decided against.
 *
 * Electron reports the media scope as `mediaType` on checks and as `mediaTypes`
 * on requests. A bare `media` check (no type) is left as its own key and is never
 * granted, because it cannot be told apart from a screen-share check; the request
 * handler is what resolves those.
 */
export function permissionCheckKey(origin: string, permission: string, mediaType: unknown): string {
  return permissionKey(origin, permission, typeof mediaType === 'string' ? mediaType : '')
}

/** What a request needs from the browser's remembered decisions. */
export type RememberedPermissionOutcome = 'grant' | 'deny' | 'ask'

/**
 * How a request resolves against what the user already decided.
 *
 * A remembered "Don't allow" wins; a decision that covers every scope of the
 * request grants silently; anything else still needs the user.
 */
export function rememberedPermissionOutcome(
  keys: readonly string[],
  grants: ReadonlySet<string> | undefined,
  denies: ReadonlySet<string> | undefined
): RememberedPermissionOutcome {
  if (keys.some((key) => denies?.has(key) === true)) return 'deny'
  if (keys.length > 0 && keys.every((key) => grants?.has(key) === true)) return 'grant'
  return 'ask'
}

/** One site permission's state, as the modal and the ledger read it. */
export type SitePermissionState = 'allow' | 'block' | 'ask'

/** Read one permission's state from the live ledgers. A remembered refusal wins
 *  over a grant, mirroring {@link rememberedPermissionOutcome}. */
export function sitePermissionState(
  keys: readonly string[],
  grants: ReadonlySet<string> | undefined,
  denies: ReadonlySet<string> | undefined
): SitePermissionState {
  const outcome = rememberedPermissionOutcome(keys, grants, denies)
  if (outcome === 'grant') return 'allow'
  if (outcome === 'deny') return 'block'
  return 'ask'
}

/** True when a remembered refusal covers this origin's screen share. The display
 *  handler consults it as a second gate behind the permission request handler. */
export function screenCaptureDeniedInLedger(
  denies: ReadonlySet<string> | undefined,
  origin: string
): boolean {
  return denies?.has(permissionKey(origin, SCREEN_CAPTURE_PERMISSION)) === true
}

/** A `keysFor` helper for the common one-permission, one-scope permission. */
function simpleKeys(permission: string, scope = ''): (origin: string) => string[] {
  return (origin) => [permissionKey(origin, permission, scope)]
}

/** A `keysFor` helper for a permission decided across several ledger keys. */
function multiKeys(permissions: readonly string[]): (origin: string) => string[] {
  return (origin) => permissions.map((permission) => permissionKey(origin, permission))
}

/** The sections the Site Permissions modal draws, in order. */
export type SitePermissionGroupId =
  'capture' | 'location' | 'notifications' | 'devices' | 'display' | 'storage' | 'content'

export interface SitePermissionGroup {
  id: SitePermissionGroupId
  label: string
}

export const SITE_PERMISSION_GROUPS: readonly SitePermissionGroup[] = [
  { id: 'capture', label: 'Camera, microphone and screen' },
  { id: 'location', label: 'Location' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'devices', label: 'Connected devices and sensors' },
  { id: 'display', label: 'Display and input' },
  { id: 'storage', label: 'Storage and background' },
  { id: 'content', label: 'Content and data' }
]

/** One site permission a decision can be remembered for. */
export interface SitePermissionDescriptor {
  /** Stable id, used by the modal and the IPC contract. */
  id: string
  label: string
  description: string
  group: SitePermissionGroupId
  /** The Chromium permission names this decision covers, for prompt copy. */
  permissions: readonly string[]
  /** The ledger keys one origin's decision covers. */
  keysFor: (origin: string) => string[]
}

/**
 * Every Chromium site permission the browser exposes, grouped the way a user
 * thinks about them rather than the way Chromium names them. Deliberately broad:
 * a permission the app has no UI for is one a page can ask for but the user can
 * never inspect or reset.
 */
export const SITE_PERMISSION_CATALOG: readonly SitePermissionDescriptor[] = [
  {
    id: 'camera',
    label: 'Camera',
    description: 'Take photos and record video from your camera.',
    group: 'capture',
    permissions: ['media'],
    keysFor: simpleKeys('media', 'video')
  },
  {
    id: 'microphone',
    label: 'Microphone',
    description: 'Record audio from your microphone.',
    group: 'capture',
    permissions: ['media'],
    keysFor: simpleKeys('media', 'audio')
  },
  {
    id: 'screen-share',
    label: 'Screen sharing',
    description: 'Capture your screen or a window to share it.',
    group: 'capture',
    permissions: [SCREEN_CAPTURE_PERMISSION, 'media'],
    keysFor: simpleKeys(SCREEN_CAPTURE_PERMISSION)
  },
  {
    id: 'location',
    label: 'Location',
    description: 'Read your precise location.',
    group: 'location',
    permissions: ['geolocation'],
    keysFor: simpleKeys('geolocation')
  },
  {
    id: 'approximate-location',
    label: 'Approximate location',
    description: 'Read an approximate location derived from your network.',
    group: 'location',
    permissions: ['geolocation-approximate'],
    keysFor: simpleKeys('geolocation-approximate')
  },
  {
    id: 'notifications',
    label: 'Notifications',
    description: 'Show desktop notifications.',
    group: 'notifications',
    permissions: ['notifications'],
    keysFor: simpleKeys('notifications')
  },
  {
    id: 'midi',
    label: 'MIDI devices',
    description: 'Use connected MIDI input and output devices.',
    group: 'devices',
    permissions: ['midi'],
    keysFor: simpleKeys('midi')
  },
  {
    id: 'midi-sysex',
    label: 'MIDI system exclusive messages',
    description: 'Send privileged system messages to MIDI devices.',
    group: 'devices',
    permissions: ['midiSysex'],
    keysFor: simpleKeys('midiSysex')
  },
  {
    id: 'hid',
    label: 'HID devices',
    description: 'Use connected human interface devices.',
    group: 'devices',
    permissions: ['hid'],
    keysFor: simpleKeys('hid')
  },
  {
    id: 'usb',
    label: 'USB devices',
    description: 'Use connected USB devices.',
    group: 'devices',
    permissions: ['usb'],
    keysFor: simpleKeys('usb')
  },
  {
    id: 'serial',
    label: 'Serial ports',
    description: 'Use connected serial devices.',
    group: 'devices',
    permissions: ['serial'],
    keysFor: simpleKeys('serial')
  },
  {
    id: 'nfc',
    label: 'NFC devices',
    description: 'Read from and write to nearby NFC tags.',
    group: 'devices',
    permissions: ['nfc'],
    keysFor: simpleKeys('nfc')
  },
  {
    id: 'smart-card',
    label: 'Smart cards',
    description: 'Use connected smart card readers.',
    group: 'devices',
    permissions: ['smart-card'],
    keysFor: simpleKeys('smart-card')
  },
  {
    id: 'local-fonts',
    label: 'Local fonts',
    description: 'Read the fonts installed on this computer.',
    group: 'devices',
    permissions: ['local-fonts'],
    keysFor: simpleKeys('local-fonts')
  },
  {
    id: 'sensors',
    label: 'Motion sensors',
    description: 'Read accelerometer, gyroscope and similar sensors.',
    group: 'devices',
    permissions: ['sensors'],
    keysFor: simpleKeys('sensors')
  },
  {
    id: 'idle-detection',
    label: 'Idle detection',
    description: 'Know when you are present at the computer.',
    group: 'devices',
    permissions: ['idle-detection'],
    keysFor: simpleKeys('idle-detection')
  },
  {
    id: 'vr',
    label: 'Virtual reality',
    description: 'Use connected virtual reality hardware.',
    group: 'devices',
    permissions: ['vr'],
    keysFor: simpleKeys('vr')
  },
  {
    id: 'ar',
    label: 'Augmented reality',
    description: 'Use augmented reality features on this device.',
    group: 'devices',
    permissions: ['ar'],
    keysFor: simpleKeys('ar')
  },
  {
    id: 'hand-tracking',
    label: 'Hand tracking',
    description: 'Track your hands through a camera.',
    group: 'devices',
    permissions: ['hand-tracking'],
    keysFor: simpleKeys('hand-tracking')
  },
  {
    id: 'speaker-selection',
    label: 'Speaker selection',
    description: 'Choose which audio output device plays sound.',
    group: 'devices',
    permissions: ['speaker-selection'],
    keysFor: simpleKeys('speaker-selection')
  },
  {
    id: 'fullscreen',
    label: 'Full screen',
    description: 'Take over the whole display in full screen.',
    group: 'display',
    permissions: ['fullscreen'],
    keysFor: simpleKeys('fullscreen')
  },
  {
    id: 'automatic-fullscreen',
    label: 'Automatic full screen',
    description: 'Enter full screen without a click.',
    group: 'display',
    permissions: ['automatic-fullscreen'],
    keysFor: simpleKeys('automatic-fullscreen')
  },
  {
    id: 'pointer-lock',
    label: 'Pointer lock',
    description: 'Hide the cursor and capture pointer movement.',
    group: 'display',
    permissions: ['pointerLock'],
    keysFor: simpleKeys('pointerLock')
  },
  {
    id: 'keyboard-lock',
    label: 'Keyboard lock',
    description: 'Capture keys such as Escape and Function keys.',
    group: 'display',
    permissions: ['keyboardLock'],
    keysFor: simpleKeys('keyboardLock')
  },
  {
    id: 'window-management',
    label: 'Window management',
    description: 'Place and size windows across your displays.',
    group: 'display',
    permissions: ['window-management'],
    keysFor: simpleKeys('window-management')
  },
  {
    id: 'screen-wake-lock',
    label: 'Screen wake lock',
    description: 'Keep the screen awake while the page is active.',
    group: 'display',
    permissions: ['screen-wake-lock'],
    keysFor: simpleKeys('screen-wake-lock')
  },
  {
    id: 'system-wake-lock',
    label: 'System wake lock',
    description: 'Keep the system from sleeping.',
    group: 'display',
    permissions: ['system-wake-lock'],
    keysFor: simpleKeys('system-wake-lock')
  },
  {
    id: 'captured-surface-control',
    label: 'Captured surface control',
    description: 'Control a tab you are sharing.',
    group: 'display',
    permissions: ['captured-surface-control'],
    keysFor: simpleKeys('captured-surface-control')
  },
  {
    id: 'persistent-storage',
    label: 'Persistent storage',
    description: 'Keep site data from being evicted under pressure.',
    group: 'storage',
    permissions: ['persistent-storage'],
    keysFor: simpleKeys('persistent-storage')
  },
  {
    id: 'background-sync',
    label: 'Background sync',
    description: 'Finish uploads after the page is closed.',
    group: 'storage',
    permissions: ['background-sync'],
    keysFor: simpleKeys('background-sync')
  },
  {
    id: 'periodic-background-sync',
    label: 'Periodic background sync',
    description: 'Refresh content in the background on a schedule.',
    group: 'storage',
    permissions: ['periodic-background-sync'],
    keysFor: simpleKeys('periodic-background-sync')
  },
  {
    id: 'background-fetch',
    label: 'Background fetch',
    description: 'Download large files in the background.',
    group: 'storage',
    permissions: ['background-fetch'],
    keysFor: simpleKeys('background-fetch')
  },
  {
    id: 'storage-access',
    label: 'Storage access',
    description: 'Read storage that was set in another context.',
    group: 'storage',
    permissions: ['storage-access'],
    keysFor: simpleKeys('storage-access')
  },
  {
    id: 'top-level-storage-access',
    label: 'Top-level storage access',
    description: 'Read top-level storage from an embedded page.',
    group: 'storage',
    permissions: ['top-level-storage-access'],
    keysFor: simpleKeys('top-level-storage-access')
  },
  {
    id: 'clipboard-read',
    label: 'Read clipboard',
    description: 'Read text and images from the clipboard.',
    group: 'content',
    permissions: ['clipboard-read'],
    keysFor: multiKeys(['clipboard-read', 'deprecated-sync-clipboard-read'])
  },
  {
    id: 'clipboard-write',
    label: 'Write clipboard',
    description: 'Write text and images to the clipboard.',
    group: 'content',
    permissions: ['clipboard-sanitized-write'],
    keysFor: simpleKeys('clipboard-sanitized-write')
  },
  {
    id: 'file-system',
    label: 'File system',
    description: 'Read and write files you pick from disk.',
    group: 'content',
    permissions: ['fileSystem'],
    keysFor: simpleKeys('fileSystem')
  },
  {
    id: 'local-network',
    label: 'Local network',
    description: 'Reach devices on your local network.',
    group: 'content',
    permissions: ['local-network'],
    keysFor: multiKeys(['local-network', 'local-network-access', 'loopback-network'])
  },
  {
    id: 'payment-handler',
    label: 'Payment handler',
    description: 'Offer itself as a payment handler.',
    group: 'content',
    permissions: ['payment-handler'],
    keysFor: simpleKeys('payment-handler')
  },
  {
    id: 'protected-media',
    label: 'Protected media',
    description: 'Play DRM-protected audio and video.',
    group: 'content',
    permissions: ['mediaKeySystem'],
    keysFor: simpleKeys('mediaKeySystem')
  },
  {
    id: 'web-printing',
    label: 'Printing',
    description: 'Print content to a printer.',
    group: 'content',
    permissions: ['web-printing'],
    keysFor: simpleKeys('web-printing')
  },
  {
    id: 'web-app-installation',
    label: 'App installation',
    description: 'Install itself as a desktop app.',
    group: 'content',
    permissions: ['web-app-installation'],
    keysFor: simpleKeys('web-app-installation')
  }
]

const DESCRIPTORS_BY_ID = new Map<string, SitePermissionDescriptor>(
  SITE_PERMISSION_CATALOG.map((descriptor) => [descriptor.id, descriptor])
)

/** One catalog entry by id, or null. */
export function sitePermissionDescriptor(id: string): SitePermissionDescriptor | null {
  return DESCRIPTORS_BY_ID.get(id) ?? null
}

/** The catalog entry that owns a Chromium permission name, or null. */
export function descriptorForPermission(permission: string): SitePermissionDescriptor | null {
  for (const descriptor of SITE_PERMISSION_CATALOG) {
    if (descriptor.permissions.includes(permission)) return descriptor
  }
  return null
}

/** What a page is asking for, in the app's own words, for the prompt card. */
export function sitePermissionRequestSummary(
  permission: string,
  mediaTypes: readonly string[]
): string {
  if (permission === 'media' && mediaTypes.length > 0) {
    return mediaTypes
      .map((mediaType) => {
        if (mediaType === 'video') return 'the camera'
        if (mediaType === 'audio') return 'the microphone'
        return mediaType
      })
      .join(' and ')
  }
  if (isScreenCaptureRequest(permission, mediaTypes)) return 'your screen'
  return descriptorForPermission(permission)?.label ?? permission.replace(/-/g, ' ')
}
