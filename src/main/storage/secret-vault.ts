import { safeStorage } from 'electron'
import { uuidv7 } from '../../lib/id'
import { Logger } from '../system/logger'
import { clearRepeatedFailure, reportRepeatedFailure } from '../system/repeated-failure-log'
import {
  VaultCiphertextUnreadableError,
  VaultRecordMissingError,
  VaultUnavailableError
} from './secret-vault-errors'
import { describeVaultWriter, type VaultWriterIdentity } from './secret-vault-writer'
import type { StorageEngine } from './storage-engine'

interface EncryptedSecretRecord {
  value: string
  createdAt: number
  updatedAt: number
  /** The build that wrote this ciphertext; absent on records written before it was recorded. */
  writer?: VaultWriterIdentity
}

type EncryptedSecretStore = Record<string, EncryptedSecretRecord>
const vaultWriteTails = new WeakMap<StorageEngine, Promise<unknown>>()

/**
 * `safeStorage`'s synchronous encryption API is deprecated in Electron 45 and
 * removed in 46, so availability is asked through the async API. Every read and
 * write asks again, which keeps the answer current, and the last answer is cached
 * here because status snapshots, gateway catalogs and utility listings report
 * availability as a plain boolean through the synchronous `isAvailable()`.
 */
let encryptionAvailable = false

async function probeEncryption(): Promise<boolean> {
  try {
    encryptionAvailable = await safeStorage.isAsyncEncryptionAvailable()
  } catch (error: unknown) {
    Logger.error('Secure credential storage availability could not be detected:', error)
    encryptionAvailable = false
  }
  return encryptionAvailable
}

/**
 * Deterministic SecretVault ref under which a provider account's token is
 * stored. The ref is keyed by the global account id only, so one account's
 * token is shared by every project that attaches it   a provider account is
 * created once and reused across projects, not duplicated per project.
 */
function providerTokenRef(accountId: string): string {
  return `deployment_provider_${accountId}`
}

/**
 * Vault ref holding one MCP utility's OAuth state: the tokens, the PKCE
 * verifier, the client registration, and the discovered authorization server
 * metadata. Keyed by utility id, so a server that is authorized once stays
 * authorized across projects and turns.
 */
function mcpOAuthStateRef(utilityId: string): string {
  return `mcp_oauth_state_${utilityId}`
}

/**
 * Vault ref holding the secret of an OAuth client the user registered with an
 * authorization server by hand, for a server that issues no client dynamically.
 */
function mcpOAuthClientRef(utilityId: string): string {
  return `mcp_oauth_client_${utilityId}`
}

/**
 * Main-process-only credential vault.
 *
 * Ciphertext is stored under CodeInOven's config root. Callers persist only
 * the opaque reference returned by `save`; plaintext never crosses IPC.
 *
 * Ciphertext is portable only within one OS keyring identity: `safeStorage`
 * derives its key from the app name, so every launch that shares this vault must
 * report the same name. A record written by a launch that reported another name
 * can never be decrypted here, which is why a read failure is classified and
 * reported (`VaultCiphertextUnreadableError`) instead of surfacing as a bare
 * keyring error, and why the App names every launch identically.
 */
export class SecretVault {
  private readonly storePath = 'secrets/vault.json'

  constructor(private readonly storage: StorageEngine) {
    // Availability is detected as soon as a vault exists so the synchronous
    // `isAvailable()` readers see a settled answer instead of the pre-probe default.
    void probeEncryption()
  }

  /** Cached keyring availability, safe to read synchronously; see `probeEncryption`. */
  isAvailable(): boolean {
    return encryptionAvailable
  }

  async save(value: string, existingRef?: string): Promise<string> {
    if (!(await probeEncryption())) {
      throw new VaultUnavailableError()
    }
    if (!value) throw new TypeError('Credential value must not be empty')
    // Encryption runs before the write is queued so the shared queue only serializes
    // keyring round trips that have already completed.
    const ciphertext = (await safeStorage.encryptStringAsync(value)).toString('base64')

    return this.mutate(async (store) => {
      const ref = existingRef ?? `secret_${uuidv7()}`
      const existing = store[ref]
      const now = Date.now()
      const writer = describeVaultWriter()
      store[ref] = {
        value: ciphertext,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        ...(writer ? { writer } : {})
      }
      await this.storage.write(this.storePath, store)
      // Storing a credential again is the repair for an unreadable one, so it also
      // closes that credential's incident instead of leaving it failing for ever.
      clearRepeatedFailure(unreadableCredentialLabel(ref))
      return ref
    })
  }

  /**
   * Store (or rotate) a provider account's token, encrypted via `safeStorage`.
   *
   * This mirrors the GitHub token storage mechanism: the token is stored under a
   * deterministic, account-keyed ref inside the secure vault and only ciphertext
   * is persisted beneath the CodeInOven config root. The plaintext token is never
   * written to a repo or project file.
   *
   * Keychain-unavailable fallback: when the OS keychain (`safeStorage`) is
   * unavailable, this throws and the account is left unconfigured. The vault
   * deliberately does not degrade to plaintext storage, so a provider token can
   * never be persisted outside the secure store.
   *
   * The ref is keyed by the global `accountId`, so one account's token is shared
   * across every project that attaches it.
   *
   * @returns the opaque ref under which the encrypted token was persisted.
   */
  async saveProviderToken(accountId: string, token: string): Promise<string> {
    return this.save(token, providerTokenRef(accountId))
  }

  /**
   * Resolve a provider account's token from the secure vault.
   *
   * Keychain-unavailable fallback: when the OS keychain is unavailable this
   * throws rather than exposing stored ciphertext, keeping token access bound to
   * a working secure store.
   */
  async resolveProviderToken(accountId: string): Promise<string> {
    return this.resolve(providerTokenRef(accountId))
  }

  /** Whether a provider account token is stored in the vault. */
  async hasProviderToken(accountId: string): Promise<boolean> {
    return this.exists(providerTokenRef(accountId))
  }

  /** Remove the stored provider account token from the vault. */
  async removeProviderToken(accountId: string): Promise<void> {
    await this.remove(providerTokenRef(accountId))
  }

  /**
   * Persist one MCP utility's OAuth state, encrypted.
   *
   * The state is stored as an opaque string because it belongs to the MCP OAuth
   * client that produced it; the vault's job is to keep the ciphertext, not to
   * know the shape. It is keyed deterministically by utility id so a grant can
   * be replaced, read, or forgotten without a reference being persisted in a
   * utility definition.
   */
  async saveMcpOAuthState(utilityId: string, state: string): Promise<void> {
    await this.save(state, mcpOAuthStateRef(utilityId))
  }

  /** One MCP utility's stored OAuth state, or null when it has none or the vault is locked. */
  async resolveMcpOAuthState(utilityId: string): Promise<string | null> {
    if (!(await probeEncryption())) return null
    try {
      return await this.resolve(mcpOAuthStateRef(utilityId))
    } catch {
      return null
    }
  }

  async removeMcpOAuthState(utilityId: string): Promise<void> {
    await this.remove(mcpOAuthStateRef(utilityId))
  }

  /** Store the secret of an OAuth client the user registered by hand. */
  async saveMcpOAuthClientSecret(utilityId: string, secret: string): Promise<void> {
    await this.save(secret, mcpOAuthClientRef(utilityId))
  }

  /** The stored client secret for one MCP utility, or null when none is stored. */
  async resolveMcpOAuthClientSecret(utilityId: string): Promise<string | null> {
    if (!(await probeEncryption())) return null
    try {
      return await this.resolve(mcpOAuthClientRef(utilityId))
    } catch {
      return null
    }
  }

  async removeMcpOAuthClientSecret(utilityId: string): Promise<void> {
    await this.remove(mcpOAuthClientRef(utilityId))
  }

  async resolve(ref: string): Promise<string> {
    if (!(await probeEncryption())) {
      throw new VaultUnavailableError()
    }
    const record = (await this.load())[ref]
    if (!record) throw new VaultRecordMissingError(ref)

    try {
      const decrypted = await safeStorage.decryptStringAsync(Buffer.from(record.value, 'base64'))
      clearRepeatedFailure(unreadableCredentialLabel(ref))
      if (decrypted.shouldReEncrypt) {
        await this.rotateCiphertext(ref, decrypted.result).catch((error: unknown) => {
          // A failed rewrite costs one more rotation attempt on the next read.
          Logger.dev('Vault record could not be re-encrypted after a key rotation:', error)
        })
      }
      return decrypted.result
    } catch (failure) {
      // The Git sidebar polls a status that reads this vault every few seconds, so
      // one unreadable credential reports itself once at error level and repeats at
      // dev level until it is stored again.
      const unreadable = new VaultCiphertextUnreadableError(
        ref,
        record.writer ?? null,
        describeVaultWriter(),
        failure
      )
      reportRepeatedFailure(unreadableCredentialLabel(ref), unreadable)
      throw unreadable
    }
  }

  async remove(ref: string): Promise<void> {
    await this.mutate(async (store) => {
      if (!(ref in store)) return
      delete store[ref]
      await this.storage.write(this.storePath, store)
    })
  }

  /**
   * Rewrite one record's ciphertext after the OS keyring rotated its key, which
   * `decryptStringAsync` reports through `shouldReEncrypt`. The rewrite goes through
   * the shared write queue so a concurrent save cannot be lost.
   */
  private async rotateCiphertext(ref: string, plaintext: string): Promise<void> {
    const value = (await safeStorage.encryptStringAsync(plaintext)).toString('base64')
    await this.mutate(async (store) => {
      const existing = store[ref]
      if (!existing) return
      store[ref] = { ...existing, value, updatedAt: Date.now() }
      await this.storage.write(this.storePath, store)
    })
  }

  async exists(ref: string): Promise<boolean> {
    return ref in (await this.load())
  }

  private async load(): Promise<EncryptedSecretStore> {
    return (await this.storage.read<EncryptedSecretStore>(this.storePath)) ?? {}
  }

  /** All vault users share this queue so saving Oven keys cannot lose an account token. */
  private async mutate<T>(operation: (store: EncryptedSecretStore) => Promise<T>): Promise<T> {
    const previous = vaultWriteTails.get(this.storage) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(async () => operation(await this.load()))
    vaultWriteTails.set(this.storage, current)
    return current
  }
}

/**
 * One incident per credential, so a second unreadable ref reports on its own and
 * repairing one credential does not silence another.
 */
function unreadableCredentialLabel(ref: string): string {
  return `Credential "${ref}" could not be decrypted with this launch's OS keyring key`
}
