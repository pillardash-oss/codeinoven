import { readFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { isCodeInOvenCustomProviderId } from '../../lib/custom-provider-id'
import type { HarnessAuthAccount, HarnessAuthStatus } from '../drivers/driver.interface'
import { readHarnessHomeFile } from '../drivers/harness-runtime'
import { PiAuthConfigService, piAuthFileIo } from './pi-auth-config'
import { listPiCatalogProviders } from './pi-catalog'
import { accountId } from './provider-account-status-parsers'

/**
 * Pi's file-backed auth. `models.json` names the configured providers and
 * `auth.json` holds their credentials; the shared service below is also what the
 * in-app sign-in and the headless API-key flows write through.
 */

/** Shared headless store for harnesses whose credentials live in files (Pi). */
export const fileBackedAuth = new PiAuthConfigService(undefined, piAuthFileIo)

/** Pi keeps configured providers in models.json; the CLI has no status subcommand. */
const PI_AGENT_DIR = join(homedir(), '.pi', 'agent')

/**
 * Pi stores configured providers in `~/.pi/agent/models.json` and credentials
 * (api keys and OAuth tokens written by both the TUI and CodeInOven) in
 * `auth.json`   a record keyed by provider id. A provider is reported as an
 * authenticated account when its models.json entry carries an API key or a
 * credential exists in auth.json; credentials without a models.json entry are
 * still connected providers and must be listed.
 */
export async function readPiStatus(
  projectPath?: string,
  environment: NodeJS.ProcessEnv = {}
): Promise<HarnessAuthStatus> {
  let providerNames = new Map<string, string>()
  try {
    providerNames = new Map(
      (await listPiCatalogProviders()).map((provider) => [provider.id, provider.name])
    )
  } catch {
    // Auth status remains useful when Pi's optional catalog cannot load.
  }
  const isolatedAgentDir = environment['PI_CODING_AGENT_DIR']
  const auth = isolatedAgentDir
    ? new PiAuthConfigService(join(isolatedAgentDir, 'auth.json'))
    : fileBackedAuth
  const credentialIds = await auth.credentialIds()
  for (const providerId of credentialIds) {
    if (isCodeInOvenCustomProviderId(providerId)) credentialIds.delete(providerId)
  }
  let stored: Record<string, unknown> = {}
  let configReadable = false
  try {
    const wslRaw = isolatedAgentDir
      ? undefined
      : await readHarnessHomeFile('pi', '.pi/agent/models.json', projectPath)
    const raw =
      wslRaw === undefined
        ? await readFile(join(isolatedAgentDir ?? PI_AGENT_DIR, 'models.json'), 'utf8')
        : wslRaw
    if (raw !== null) {
      stored = JSON.parse(raw) as Record<string, unknown>
      configReadable = true
    }
  } catch {
    stored = {}
  }
  const providers = record(stored['providers']) ?? {}
  const accounts: HarnessAuthAccount[] = []
  let connected = 0
  for (const [providerId, rawEntry] of Object.entries(providers)) {
    if (isCodeInOvenCustomProviderId(providerId)) continue
    const entry = record(rawEntry)
    if (!entry) continue
    const apiKey = typeof entry['apiKey'] === 'string' ? entry['apiKey'] : undefined
    // Credential-less native entries are model configuration, not accounts.
    if (!apiKey || apiKey === 'none') {
      if (!credentialIds.has(providerId)) continue
    }
    accounts.push({
      id: accountId(providerId),
      providerId,
      label: providerNames.get(providerId) ?? providerId,
      active: true
    })
    connected += 1
  }
  // Credentials stored directly in auth.json (catalog providers connected via
  // CodeInOven or pi's own sign-in) are connected even without a models.json
  // entry.
  for (const providerId of credentialIds) {
    if (accounts.some((account) => account.providerId === providerId)) continue
    accounts.push({
      id: accountId(providerId),
      providerId,
      label: providerNames.get(providerId) ?? providerId,
      ...((await auth.isOauth(providerId)) ? { method: 'oauth' } : {}),
      active: true
    })
    connected += 1
  }
  // A fresh install with nothing configured is honestly "unauthenticated"
  // reporting `unknown` here made the status pill look permanently stuck and
  // the re-check button appear dead. `unknown` is reserved for installs where
  // Pi's config file could not be read at all.
  return {
    state:
      connected > 0
        ? 'authenticated'
        : accounts.length > 0 || configReadable
          ? 'unauthenticated'
          : 'unknown',
    accounts
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
