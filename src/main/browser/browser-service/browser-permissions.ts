/**
 * Permission bookkeeping for the embedded browser: how a site's origin and
 * permission map to a remembered key, and how a user decision affects what the
 * browser keeps.
 *
 * The catalog that maps the human-facing permissions onto ledger keys, and the
 * pure key/state helpers, live in the shared `src/lib/browser/site-permissions`
 * module so the renderer's Site Permissions modal and the prompt read the very
 * same definitions. This module keeps only what is process-local: the resolution
 * table and the live-ledger lookup.
 */

import type { BrowserPermissionDecision } from '../../../lib/ipc-contract'

export {
  SCREEN_CAPTURE_PERMISSION,
  SITE_PERMISSION_CATALOG,
  SITE_PERMISSION_GROUPS,
  descriptorForPermission,
  isScreenCaptureRequest,
  permissionCheckKey,
  permissionGrantKeys,
  permissionKey,
  permissionKeysForRequest,
  permissionOrigin,
  rememberedPermissionOutcome,
  screenCaptureDeniedInLedger,
  sitePermissionDescriptor,
  sitePermissionRequestSummary,
  sitePermissionState
} from '../../../lib/browser/site-permissions'
export type {
  RememberedPermissionOutcome,
  SitePermissionDescriptor,
  SitePermissionGroup,
  SitePermissionGroupId,
  SitePermissionState
} from '../../../lib/browser/site-permissions'

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
