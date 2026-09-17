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
    return request.mediaTypes.map((mediaType) =>
      permissionKey(request.origin, request.permission, mediaType)
    )
  }
  return [permissionKey(request.origin, request.permission)]
}
