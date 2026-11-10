import { readFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { applyEdits, modify } from 'jsonc-parser'
import { atomicWrite } from '../../lib/utils'
import type { HarnessAuthAccount, HarnessAuthStatus } from '../drivers/driver.interface'
import { readHarnessHomeFile, writeHarnessHomeFile } from '../drivers/harness-runtime'
import { accountId } from './provider-account-status-parsers'

/**
 * Cline's credential store: `providers.json` is the only auth state the CLI
 * keeps, so both the status read and the single-provider disconnect edit that
 * file directly, preserving every other entry and setting.
 */

/** Cline keeps provider/API-key state in JSON; the CLI has no status subcommand. */
const CLINE_SETTINGS_DIR = join(homedir(), '.cline', 'data', 'settings')

/**
 * Cline stores provider auth state in `~/.cline/data/settings/providers.json` and the
 * CLI exposes no `auth status` subcommand (`cline auth <name>` only configures a
 * provider). Each configured provider is reported as an authenticated account.
 */
export async function readClineStatus(projectPath?: string): Promise<HarnessAuthStatus> {
  let stored: Record<string, unknown>
  try {
    const wslRaw = await readHarnessHomeFile(
      'cline',
      '.cline/data/settings/providers.json',
      projectPath
    )
    const raw =
      wslRaw === undefined
        ? await readFile(join(CLINE_SETTINGS_DIR, 'providers.json'), 'utf8')
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
  const lastUsed =
    typeof stored['lastUsedProvider'] === 'string' ? stored['lastUsedProvider'] : undefined
  const accounts: HarnessAuthAccount[] = []
  for (const [providerId, rawEntry] of Object.entries(providers as Record<string, unknown>)) {
    const entry = rawEntry as Record<string, unknown> | null
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const method = typeof entry['tokenSource'] === 'string' ? entry['tokenSource'] : undefined
    accounts.push({
      id: accountId(providerId),
      providerId,
      label: providerId,
      ...(method === undefined ? {} : { method }),
      active: providerId === lastUsed
    })
  }
  return {
    state: accounts.length > 0 ? 'authenticated' : 'unauthenticated',
    accounts
  }
}

/** Remove only the selected Cline provider, preserving every other account and setting. */
export async function removeClineCredential(providerId: string): Promise<void> {
  const relativePath = '.cline/data/settings/providers.json'
  const filePath = join(CLINE_SETTINGS_DIR, 'providers.json')
  const wslRaw = await readHarnessHomeFile('cline', relativePath)
  if (wslRaw === null) {
    throw new Error('Cline credentials could not be read. Disconnect was not performed.')
  }
  let raw: string
  try {
    raw = wslRaw ?? (await readFile(filePath, 'utf8'))
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
    throw error
  }
  let stored: unknown
  try {
    stored = JSON.parse(raw)
  } catch {
    throw new Error('Cline credentials have an invalid format. Disconnect was not performed.')
  }
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) {
    throw new Error('Cline credentials have an invalid format. Disconnect was not performed.')
  }
  const record = stored as Record<string, unknown>
  const providers = record['providers']
  if (typeof providers !== 'object' || providers === null || Array.isArray(providers)) {
    throw new Error('Cline providers have an invalid format. Disconnect was not performed.')
  }
  if (!Object.hasOwn(providers, providerId)) return
  let content = applyEdits(raw, modify(raw, ['providers', providerId], undefined, {}))
  if (record['lastUsedProvider'] === providerId) {
    content = applyEdits(content, modify(content, ['lastUsedProvider'], undefined, {}))
  }
  if (wslRaw !== undefined) {
    if (!(await writeHarnessHomeFile('cline', relativePath, content))) {
      throw new Error('Cline credential runtime changed. Retry disconnect.')
    }
    return
  }
  await atomicWrite(filePath, content)
}
