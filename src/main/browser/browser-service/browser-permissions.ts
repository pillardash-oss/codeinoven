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
