import { readFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import type { HarnessAuthAccount, HarnessAuthStatus } from '../drivers/driver.interface'
import { readHarnessHomeFile } from '../drivers/harness-runtime'
import { accountId } from './provider-account-status-parsers'

/**
 * Muse Code's auth state: the CLI exposes no `auth status` subcommand, so the
 * provider credentials it keeps on disk are read directly.
 */

/** Muse Code stores OAuth credentials here (or $XDG_CONFIG_HOME/muse/auth.json). */
const MUSE_AUTH_PATH = join(homedir(), '.config', 'muse', 'auth.json')

/**
 * Muse keeps OAuth credentials in `~/.config/muse/auth.json` (or
 * `$XDG_CONFIG_HOME/muse/auth.json`) and honors a `META_API_KEY` env var that
 * takes priority over a logged-in session. The CLI exposes no `auth status`
 * subcommand, so the auth file is read directly. Its shape is
 * `{ schema_version, providers: { <id>: { access_token, api_key, ... } } }`  
 * a provider is authenticated when it carries an `access_token` or `api_key`.
 */
export async function readMuseStatus(
  projectPath?: string,
  environment: NodeJS.ProcessEnv = {}
): Promise<HarnessAuthStatus> {
  if (environment['META_API_KEY'] ?? process.env['META_API_KEY']) {
    return {
      state: 'authenticated',
      accounts: [{ id: 'meta', providerId: 'meta', label: 'Meta', method: 'api-key', active: true }]
    }
  }
  let stored: Record<string, unknown>
  try {
    const isolatedConfigHome = environment['XDG_CONFIG_HOME']
    const wslRaw = isolatedConfigHome
      ? undefined
      : await readHarnessHomeFile('muse', '.config/muse/auth.json', projectPath)
    const raw =
      wslRaw === undefined
        ? await readFile(
            isolatedConfigHome ? join(isolatedConfigHome, 'muse', 'auth.json') : MUSE_AUTH_PATH,
            'utf8'
          )
        : wslRaw
    if (raw === null) return { state: 'unauthenticated', accounts: [] }
    stored = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return { state: 'unauthenticated', accounts: [] }
  }
  const providers = stored['providers']
  if (typeof providers !== 'object' || providers === null || Array.isArray(providers)) {
    return { state: 'unauthenticated', accounts: [] }
  }
  const accounts: HarnessAuthAccount[] = []
  let signedIn = 0
  for (const [providerId, rawEntry] of Object.entries(providers as Record<string, unknown>)) {
    const entry = rawEntry as Record<string, unknown> | null
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const token = typeof entry['access_token'] === 'string' ? entry['access_token'] : undefined
    const apiKey = typeof entry['api_key'] === 'string' ? entry['api_key'] : undefined
    const authenticated = Boolean((token && token.length > 0) || (apiKey && apiKey.length > 0))
    const method =
      typeof entry['mechanism'] === 'string'
        ? entry['mechanism']
        : typeof entry['obtained_via'] === 'string'
          ? entry['obtained_via']
          : authenticated
            ? 'oauth'
            : undefined
    accounts.push({
      id: accountId(providerId),
      providerId,
      label: (typeof entry['user_full_name'] === 'string' && entry['user_full_name']) || providerId,
      ...(method === undefined ? {} : { method }),
      active: authenticated
    })
    if (authenticated) signedIn += 1
  }
  return {
    state: signedIn > 0 ? 'authenticated' : 'unauthenticated',
    accounts
  }
}
