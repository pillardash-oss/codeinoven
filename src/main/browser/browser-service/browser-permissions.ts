/**
 * Permission bookkeeping for the embedded browser: how a site's origin and
 * permission map to a remembered key, and how a user decision affects what the
 * browser keeps.
 */

import type { BrowserPermissionDecision, BrowserPermissionRequest } from '../../../lib/ipc-contract'

/** How a permission reply affects what the browser remembers. */
export interface PermissionResolution {
  granted: boolean
  rememberGrant: boolean
  rememberDeny: boolean
}

export const permissionResolutions: Record<BrowserPermissionDecision, PermissionResolution> = {
  allow: { granted: true, rememberGrant: true, rememberDeny: false },
  'allow-once': { granted: true, rememberGrant: false, rememberDeny: false },
  deny: { granted: false, rememberGrant: false, rememberDeny: true },
  dismiss: { granted: false, rememberGrant: false, rememberDeny: false }
}

/** Answer a request from a decision the memory already holds: the grant is real,
 *  but there is nothing new to write. */
export const permissionSilentGrant: PermissionResolution = {
  granted: true,
  rememberGrant: false,
  rememberDeny: false
}

/**
 * The live decision ledger for one session partition.
 *
 * A session's handlers must keep observing the very same `Set` the durable
 * memory loaded into {@link PermissionMemoryLedgers}, so this returns the
 * existing ledger instead of replacing it. Replacing it silently threw away
 * every decision the user had already made (`hydratePermissionMemory()` reads
 * the file into these maps, so a fresh set discarded the whole run's memory and
 * re-prompted for permissions that were granted earlier).
 */
export function permissionLedgerForPartition(
  ledger: Map<string, Set<string>>,
  partition: string
): Set<string> {
  const existing = ledger.get(partition)
  if (existing) return existing
  const created = new Set<string>()
  ledger.set(partition, created)
  return created
}

export function permissionOrigin(value: string): string | null {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null
  } catch {
    return null
  }
}

export function permissionKey(origin: string, permission: string, scope = ''): string {
  return `${origin}\n${permission}\n${scope}`
}

export function permissionGrantKeys(request: BrowserPermissionRequest): string[] {
  if (request.permission === 'media' && request.mediaTypes.length > 0) {
    return [...new Set(request.mediaTypes)].map((mediaType) =>
      permissionKey(request.origin, request.permission, mediaType)
    )
  }
  return [permissionKey(request.origin, request.permission)]
}

/** The key a synchronous permission check uses. Electron reports the media
 *  scope as `mediaType` on checks and as `mediaTypes` on requests, so both
 *  paths have to reduce to the same key for a remembered decision to apply. */
export function permissionCheckKey(origin: string, permission: string, mediaType: unknown): string {
  return permissionKey(origin, permission, typeof mediaType === 'string' ? mediaType : '')
}

/** What a request needs from the browser's remembered decisions. */
export type RememberedPermissionOutcome = 'grant' | 'deny' | 'ask'
/**
 * How a request resolves against what the user already decided.
 *
 * Electron calls the permission *request* handler for every web API call, even
 * when the synchronous check handler already answered, so this is the only
 * place a remembered decision can actually spare the user a prompt. A
 * remembered "Don't allow" wins; a decision that covers every scope of the
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

/** One site permission the padlock menu can set manually, without waiting for
 *  the page to ask. The keys are exactly the ledger keys the prompt path reads
 *  and writes, so a manual decision and a prompt decision are the same thing. */
export interface SitePermissionDescriptor {
  id: 'camera' | 'microphone' | 'location' | 'notifications'
  /** Menu label for the submenu, e.g. "Camera". */
  label: string
  /** Ledger keys one origin's decision covers. */
  keysFor: (origin: string) => string[]
}

export const SITE_PERMISSION_DESCRIPTORS: readonly SitePermissionDescriptor[] = [
  {
    id: 'camera',
    label: 'Camera',
    keysFor: (origin) => [permissionKey(origin, 'media', 'video')]
  },
  {
    id: 'microphone',
    label: 'Microphone',
    keysFor: (origin) => [permissionKey(origin, 'media', 'audio')]
  },
  {
    id: 'location',
    label: 'Location',
    keysFor: (origin) => [permissionKey(origin, 'geolocation', '')]
  },
  {
    id: 'notifications',
    label: 'Notifications',
    keysFor: (origin) => [permissionKey(origin, 'notifications', '')]
  }
]

/** The padlock menu's reading of one descriptor for one origin. */
export type SitePermissionState = 'allowed' | 'blocked' | 'ask'

/** Read one descriptor's state from the live ledgers. A remembered refusal
 *  wins over a grant, mirroring {@link rememberedPermissionOutcome}. */
export function sitePermissionState(
  keys: readonly string[],
  grants: ReadonlySet<string> | undefined,
  denies: ReadonlySet<string> | undefined
): SitePermissionState {
  const outcome = rememberedPermissionOutcome(keys, grants, denies)
  if (outcome === 'grant') return 'allowed'
  if (outcome === 'deny') return 'blocked'
  return 'ask'
}
