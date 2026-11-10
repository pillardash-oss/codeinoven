import { readFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { atomicWrite } from '../../lib/utils'
import { readHarnessHomeFile, writeHarnessHomeFile } from '../drivers/harness-runtime'
import {
  openCodeCredentialDatabasePaths,
  readOpenCodeV2StoredCredentials
} from '../drivers/opencode-account-usage'
import { openCodeAuthPaths } from '../drivers/opencode/opencode-values'
import { backgroundIo } from '../system/background-io'
import {
  OPENCODE_RENAMED_INTEGRATIONS,
  canonicalOpenCodeIntegrationId
} from './provider-account-opencode-identity'
import { accountId } from './provider-account-status-parsers'

/**
 * OpenCode's credential stores (V1 `auth.json`, V2's own SQLite file) as
 * CodeInOven reads and edits them: which integration and credential a CLI
 * command has to name, and the legacy rows a stale rename leaves behind.
 */

/** OpenCode's credential store; its keys are the real provider ids the CLI expects. */
const OPENCODE_AUTH_PATH = join(homedir(), '.local', 'share', 'opencode', 'auth.json')
const OPENCODE_AUTH_RELATIVE_PATH = '.local/share/opencode/auth.json'

/** Read a config file as text, or `{}` when it does not exist. */
async function readFileOrEmpty(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return '{}\n'
    throw error
  }
}

/** Real credential keys from OpenCode's own auth store (empty when unreadable). */
async function readOpencodeCredentialKeys(): Promise<string[]> {
  const remote = await readHarnessHomeFile('opencode', OPENCODE_AUTH_RELATIVE_PATH)
  const content = typeof remote === 'string' ? remote : await readFileOrEmpty(OPENCODE_AUTH_PATH)
  try {
    const parsed = JSON.parse(content) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
    return Object.keys(parsed as Record<string, unknown>)
  } catch {
    return []
  }
}

/**
 * Stored opencode account ids are slugs of the catalog display label
 * ('Z.AI' -> 'z-ai'), while the CLI accepts only real credential keys
 * ('zai') or catalog names. Resolve through the auth store first, then
 * fall back to the display name, which the CLI resolves itself.
 *
 * A renamed integration maps to its canonical id first: `opencode-zen`
 * became `opencode`, so a stale row resolves against the key the CLI knows.
 */
export async function resolveOpencodeLogoutTarget(
  providerId: string,
  providerHint?: string
): Promise<string | undefined> {
  const keys = await readOpencodeCredentialKeys()
  const lowered = providerId.toLowerCase()
  const exact = keys.find((key) => key.toLowerCase() === lowered)
  if (exact) return canonicalOpenCodeIntegrationId(exact)
  const slugged = keys.find((key) => accountId(key) === lowered)
  if (slugged) return canonicalOpenCodeIntegrationId(slugged)
  const canonical = canonicalOpenCodeIntegrationId(providerId)
  if (canonical.toLowerCase() !== lowered) {
    const canonicalExact = keys.find((key) => key.toLowerCase() === canonical.toLowerCase())
    if (canonicalExact) return canonicalExact
  }
  const hint = providerHint?.trim()
  return hint ? canonicalOpenCodeIntegrationId(hint) : undefined
}

/**
 * Resolve the credential selector OpenCode V2's logout requires.
 *
 * V2 holds several credentials per integration and refuses to run
 * non-interactively without one, so the integration id alone is not enough.
 * The account's own store is read to turn the hint (the account's credential id
 * when the registry kept one, else its store label) into a credential the CLI
 * accepts. A single stored credential for the integration is unambiguous and is
 * used when the hint matches nothing.
 */
export async function resolveOpenCodeV2LogoutCredential(
  providerId: string,
  credentialHint: string | undefined,
  environment: NodeJS.ProcessEnv
): Promise<string | undefined> {
  const stored = await readOpenCodeV2StoredCredentials(environment)
  const forIntegration = stored.filter((credential) => credential.integrationId === providerId)
  const hint = credentialHint?.trim()
  if (hint) {
    const byId = forIntegration.find((credential) => credential.id === hint)
    if (byId) return byId.id
    const lowered = hint.toLowerCase()
    const byLabel = forIntegration.find((credential) => credential.label?.toLowerCase() === lowered)
    if (byLabel) return byLabel.id
  }
  if (forIntegration.length === 1) return forIntegration[0]?.id
  return hint || undefined
}

export async function resolveOpenCodeV2StoredIntegration(
  providerId: string,
  environment: NodeJS.ProcessEnv
): Promise<string | undefined> {
  const stored = await readOpenCodeV2StoredCredentials(environment)
  const integrations = [...new Set(stored.map((credential) => credential.integrationId))]
  const lowered = providerId.toLowerCase()
  const exact = integrations.find((integration) => integration.toLowerCase() === lowered)
  if (exact) return canonicalOpenCodeIntegrationId(exact)
  const slugged = integrations.find((integration) => accountId(integration) === lowered)
  if (slugged) return canonicalOpenCodeIntegrationId(slugged)
  // A renamed integration maps to its canonical id even when the store holds
  // several integrations: `opencode-zen` became `opencode`, so a stale row
  // must target the id the CLI knows instead of failing with
  // "Integration not found: opencode-zen".
  const canonical = canonicalOpenCodeIntegrationId(providerId)
  if (canonical.toLowerCase() !== lowered) {
    const canonicalExact = integrations.find(
      (integration) => integration.toLowerCase() === canonical.toLowerCase()
    )
    if (canonicalExact) return canonicalExact
    // The store may hold nothing under either name (a V1-only key, or an
    // already-removed credential). Target the canonical id anyway so the CLI
    // reports the credential state instead of an unknown integration.
    return canonical
  }
  // A renamed integration is the one case left: the store holds a single
  // integration that shares the stale id's stem. Matching on a shared stem
  // keeps the resolution off an unrelated provider, so a command can never land
  // on an integration the user did not name; anything else stays unresolved and
  // the CLI's own error is reported instead.
  if (integrations.length !== 1) return undefined
  const only = integrations[0] as string
  const onlyLowered = only.toLowerCase()
  return lowered.startsWith(onlyLowered) || onlyLowered.startsWith(lowered) ? only : undefined
}

/**
 * Candidate integration ids for a stale OpenCode logout: the requested id, the
 * resolved CLI target, and every known rename alias, so a V1 `auth.json` key
 * and a V2 SQLite row are both matched however the rename left them stored.
 */
export function openCodeLogoutCandidates(requested?: string, resolved?: string): Set<string> {
  const candidates = new Set<string>()
  for (const value of [requested, resolved]) {
    const trimmed = value?.trim()
    if (!trimmed) continue
    candidates.add(trimmed.toLowerCase())
    const canonical = canonicalOpenCodeIntegrationId(trimmed)
    candidates.add(canonical.toLowerCase())
    for (const [stale, current] of Object.entries(OPENCODE_RENAMED_INTEGRATIONS)) {
      if (current.toLowerCase() === canonical.toLowerCase()) candidates.add(stale.toLowerCase())
    }
  }
  return candidates
}

/**
 * Remove matching keys from OpenCode V1 `auth.json` stores. Returns how many
 * keys were removed. Scoped to the account container when the environment
 * isolates one; otherwise every default-home store is cleaned.
 */
export async function removeOpenCodeV1CredentialsFor(
  environment: NodeJS.ProcessEnv,
  candidates: Set<string>
): Promise<number> {
  if (candidates.size === 0) return 0
  const scoped = Boolean(environment['XDG_DATA_HOME'])
  const paths = openCodeAuthPaths(environment, { scopedToDataHome: scoped })
  // WSL harnesses own their files; the host filesystem has no authority there.
  const wslRaw = await readHarnessHomeFile('opencode', OPENCODE_AUTH_RELATIVE_PATH)
  if (wslRaw !== undefined) {
    if (wslRaw === null) return 0
    const removed = removeMatchingAuthKeys(wslRaw, candidates)
    if (removed === null) return 0
    if (removed.keys.length === 0) return 0
    const content = removed.content.endsWith('\n') ? removed.content : `${removed.content}\n`
    if (!(await writeHarnessHomeFile('opencode', OPENCODE_AUTH_RELATIVE_PATH, content))) return 0
    return removed.keys.length
  }
  let removed = 0
  for (const filePath of paths) {
    let raw: string
    try {
      raw = await readFile(filePath, 'utf8')
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue
      throw error
    }
    const result = removeMatchingAuthKeys(raw, candidates)
    if (!result || result.keys.length === 0) continue
    const content = result.content.endsWith('\n') ? result.content : `${result.content}\n`
    await atomicWrite(filePath, content)
    removed += result.keys.length
  }
  return removed
}

/** Drop matching top-level keys from an `auth.json` document, or null when invalid. */
function removeMatchingAuthKeys(
  raw: string,
  candidates: Set<string>
): { content: string; keys: string[] } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  const matched = Object.keys(record).filter(
    (key) => candidates.has(key.toLowerCase()) || candidates.has(accountId(key))
  )
  if (matched.length === 0) return { content: raw, keys: [] }
  for (const key of matched) delete record[key]
  return { content: JSON.stringify(record, null, 2), keys: matched }
}

/**
 * Delete V2 credential rows whose integration matches a stale logout target.
 * Scoped to the account container when the environment isolates one, so a
 * managed disconnect can never delete the default home's credentials.
 */
export async function deleteOpenCodeV2CredentialsFor(
  environment: NodeJS.ProcessEnv,
  candidates: Set<string>
): Promise<number> {
  if (candidates.size === 0) return 0
  // WSL stores live behind the harness runtime; the host cannot open them.
  const wslProbe = await readHarnessHomeFile('opencode', OPENCODE_AUTH_RELATIVE_PATH)
  if (wslProbe !== undefined) return 0
  const scopedRoot = environment['XDG_DATA_HOME']
    ? `${environment['XDG_DATA_HOME']}/opencode`
    : undefined
  const databasePaths = (await openCodeCredentialDatabasePaths(environment)).filter(
    (path) => !scopedRoot || path.startsWith(`${scopedRoot}/`) || path.startsWith(scopedRoot)
  )
  let deleted = 0
  for (const databasePath of databasePaths) {
    deleted += await backgroundIo<number>({
      kind: 'credential-delete',
      databasePath,
      candidates: [...candidates]
    })
  }

  return deleted
}

/** Whether any credential remains for the candidate integrations in either store. */
export async function hasRemainingOpenCodeCredentials(
  environment: NodeJS.ProcessEnv,
  candidates: Set<string>
): Promise<boolean> {
  if (candidates.size === 0) return false
  try {
    const wslRaw = await readHarnessHomeFile('opencode', OPENCODE_AUTH_RELATIVE_PATH)
    if (typeof wslRaw === 'string') {
      try {
        const parsed = JSON.parse(wslRaw) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          if (
            Object.keys(parsed as Record<string, unknown>).some(
              (key) => candidates.has(key.toLowerCase()) || candidates.has(accountId(key))
            )
          )
            return true
        }
      } catch {
        // Fall through to the V2 store check.
      }
    } else if (wslRaw === undefined) {
      const scoped = Boolean(environment['XDG_DATA_HOME'])
      for (const filePath of openCodeAuthPaths(environment, { scopedToDataHome: scoped })) {
        try {
          const parsed = JSON.parse(await readFile(filePath, 'utf8')) as unknown
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
          if (
            Object.keys(parsed as Record<string, unknown>).some(
              (key) => candidates.has(key.toLowerCase()) || candidates.has(accountId(key))
            )
          )
            return true
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue
        }
      }
    }
  } catch {
    // A store read failure must not block an explicit disconnect.
  }
  try {
    for (const credential of await readOpenCodeV2StoredCredentials(environment)) {
      if (
        candidates.has(credential.integrationId.toLowerCase()) ||
        candidates.has(accountId(credential.integrationId))
      )
        return true
    }
  } catch {
    // Same: logout stays idempotent when the store cannot be read.
  }
  return false
}
