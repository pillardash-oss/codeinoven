/**
 * The shape of a secret as the renderer knows it.
 *
 * A plaintext value is deliberately absent: the renderer lists, describes,
 * rotates and revokes credentials, and never receives one.
 */

/** Where a stored secret belongs, as the Secrets page groups it. */
export type SecretScope =
  | 'cloud-provider'
  | 'git'
  | 'utility'
  | 'mcp-oauth'
  | 'media'
  | 'typesafe'
  | 'github'
  | 'oven'
  | 'agent'
  | 'base-url-provider'
  | 'unknown'

/** Human name for a scope. */
export const SECRET_SCOPE_LABELS: Readonly<Record<SecretScope, string>> = {
  'cloud-provider': 'Cloud deployment',
  git: 'Project git credential',
  utility: 'Capability credential',
  'mcp-oauth': 'Capability sign-in',
  media: 'Media provider',
  typesafe: 'TypeSafe',
  github: 'GitHub',
  oven: 'Oven machine',
  agent: 'Thread secret',
  'base-url-provider': 'Provider API key',
  unknown: 'Other credential'
}

/** Every scope, in the order the page lists its groups. */
export const SECRET_SCOPE_ORDER: readonly SecretScope[] = [
  'utility',
  'mcp-oauth',
  'agent',
  'git',
  'cloud-provider',
  'base-url-provider',
  'media',
  'typesafe',
  'github',
  'oven',
  'unknown'
]

/** One stored secret, described for the Secrets page. */
export interface SecretInventoryEntry {
  ref: string
  /** Short human title. */
  title: string
  /** Secondary line: the owner the value belongs to, and its variable. */
  detail: string
  scope: SecretScope
  scopeLabel: string
  ownerId?: string
  environmentVariable?: string
  createdAt: number
  updatedAt: number
  /** False when this launch cannot decrypt the record (another build wrote it). */
  readable: boolean
}

/** Why the OS cannot hold an encrypted secret for this launch. */
export type SecretStorageUnavailableReason =
  'unattended-launch' | 'probe-failed' | 'plaintext-backend' | 'unavailable'

/** Whether secrets can be stored, and why not when they cannot. */
export type SecretStorageAvailability =
  { available: true } | { available: false; reason: SecretStorageUnavailableReason }

/** What the Secrets page reads in one call. */
export interface SecretsOverview {
  availability: SecretStorageAvailability
  secrets: SecretInventoryEntry[]
}

/** What a rotate request needs: which record, and the new value. */
export interface SecretRotateRequest {
  ref: string
  value: string
}

/** What a delete request needs. */
export interface SecretDeleteRequest {
  ref: string
}
