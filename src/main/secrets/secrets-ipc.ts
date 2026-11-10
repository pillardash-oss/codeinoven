import { trustedIpcMain as ipcMain } from '../ipc/trusted-ipc-main'
import type { SecretDeleteRequest, SecretRotateRequest, SecretsOverview } from '../../lib/secrets'
import type { SecretInventoryEntry } from '../../lib/secrets'
import { Logger } from '../system/logger'
import type { SecretsService } from './secrets-service'
import type { SecretOwnerLookup } from './secret-inventory'

/** Longest value the Secrets page may submit for a rotation. */
const SECRET_VALUE_LIMIT = 16_384
/** Longest ref the page may name; refs are short ids with a namespace prefix. */
const SECRET_REF_LIMIT = 256

export interface SecretsIpcOptions {
  /** Names the owner of a stored value, so the page can say what it belongs to. */
  describeOwner?: SecretOwnerLookup
  /**
   * Called after a value is deleted, so the surface that owns the reference can
   * forget it. A reference pointing at nothing would otherwise make a capability
   * or a machine fail at launch instead of simply asking to be set up again.
   */
  onRevoked?: (entry: SecretInventoryEntry) => Promise<void>
}

function requireRef(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('Secret reference must be a string')
  const ref = value.trim()
  if (!ref || ref.length > SECRET_REF_LIMIT) throw new TypeError('Secret reference is invalid')
  return ref
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

/**
 * The renderer boundary for the Secrets page.
 *
 * Every handler answers with the full described inventory, so the page never
 * applies a mutation to its own copy and cannot drift from what is stored.
 */
export function registerSecretsIpc(secrets: SecretsService, options: SecretsIpcOptions = {}): void {
  const describeOwner: SecretOwnerLookup = options.describeOwner ?? (async () => ({}))

  async function overview(): Promise<SecretsOverview> {
    return {
      availability: secrets.availability(),
      secrets: await secrets.inventory(describeOwner)
    }
  }

  async function entryFor(ref: string): Promise<SecretInventoryEntry> {
    const entries = await secrets.inventory(describeOwner)
    const entry = entries.find((candidate) => candidate.ref === ref)
    if (!entry) throw new Error('That secret is no longer stored')
    return entry
  }

  ipcMain.handle('secrets:overview', () => overview())

  ipcMain.handle('secrets:rotate', async (_, request: SecretRotateRequest) => {
    const input = requireRecord(request, 'Secret rotation')
    const ref = requireRef(input['ref'])
    const value = input['value']
    if (typeof value !== 'string') throw new TypeError('Secret value must be a string')
    if (!value) throw new TypeError('Secret value must not be empty')
    if (value.length > SECRET_VALUE_LIMIT) throw new TypeError('Secret value is too long')
    // Rotating in place keeps the reference every owner already holds.
    if (!(await secrets.exists(ref))) throw new Error('That secret is no longer stored')
    await secrets.save(value, ref)
    return await overview()
  })

  ipcMain.handle('secrets:delete', async (_, request: SecretDeleteRequest) => {
    const input = requireRecord(request, 'Secret deletion')
    const ref = requireRef(input['ref'])
    if (await secrets.exists(ref)) {
      const entry = await entryFor(ref)
      await secrets.remove(ref)
      try {
        await options.onRevoked?.(entry)
      } catch (error: unknown) {
        // The value is already gone; a stale owner reference costs a re-prompt,
        // so it is reported rather than made into a failed deletion.
        Logger.dev('Secret revocation could not be applied to its owner:', error)
      }
    }
    return await overview()
  })
}
