import type { SecretInventoryEntry } from '../../lib/secrets'
import { SECRET_SCOPE_LABELS } from '../../lib/secrets'
import type { StoredSecretSummary } from './secret-store'
import { describeSecretWriter } from './secret-writer'

/**
 * What the app can resolve about a ref's owner.
 *
 * The inventory is built from the store alone, so an owner is named by looking it
 * up when that service is available: a utility credential shows its capability
 * and variable, a project credential shows its project, and a thread secret shows
 * its thread. An owner that cannot be named falls back to the ref itself rather
 * than disappearing from the list.
 */
export interface SecretOwnerHint {
  utilityName?: string
  credentialLabel?: string
  variable?: string
  projectName?: string
  threadTitle?: string
}

/** Resolves the owner names a stored record points at. */
export type SecretOwnerLookup = (summary: StoredSecretSummary) => Promise<SecretOwnerHint>

/**
 * Turn stored records into rows, newest write first.
 *
 * Pure apart from the owner lookup the service supplies, so it stays easy to
 * reason about and never touches the vault's crypto.
 */
export async function buildSecretInventory(
  summaries: readonly StoredSecretSummary[],
  describeOwner: SecretOwnerLookup
): Promise<SecretInventoryEntry[]> {
  const entries = await Promise.all(
    summaries.map(async (summary) => {
      const hint = await describeOwner(summary).catch(() => ({}))
      return describeEntry(summary, hint)
    })
  )
  return entries.sort((left, right) => right.updatedAt - left.updatedAt)
}

function describeEntry(summary: StoredSecretSummary, hint: SecretOwnerHint): SecretInventoryEntry {
  const scopeLabel = SECRET_SCOPE_LABELS[summary.scope]
  const title = summary.label ?? hint.credentialLabel ?? scopeLabel
  return {
    ref: summary.ref,
    title,
    detail: describeDetail(summary, hint),
    scope: summary.scope,
    scopeLabel,
    ...(summary.ownerId ? { ownerId: summary.ownerId } : {}),
    ...(hint.variable ? { environmentVariable: hint.variable } : {}),
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    readable: isReadableByThisLaunch(summary)
  }
}

function describeDetail(summary: StoredSecretSummary, hint: SecretOwnerHint): string {
  const owner = hint.utilityName ?? hint.projectName ?? hint.threadTitle
  const parts: string[] = []
  if (owner) parts.push(owner)
  else if (summary.ownerId) parts.push(shortOwnerId(summary.ownerId))
  if (hint.variable) parts.push(hint.variable)
  if (parts.length === 0) parts.push(summary.ref)
  return parts.join(' · ')
}

/** An id is not a name: show a short, stable suffix instead of a bare uuid. */
function shortOwnerId(ownerId: string): string {
  return ownerId.length <= 12 ? ownerId : `…${ownerId.slice(-10)}`
}

/**
 * A record written by another build can never be decrypted here, because the
 * keyring key is derived from the app name. The page says so instead of offering
 * an action that would fail.
 */
function isReadableByThisLaunch(summary: StoredSecretSummary): boolean {
  const writer = summary.writer
  if (!writer) return true
  const current = describeSecretWriter()
  return !current || writer.app === current.app
}
