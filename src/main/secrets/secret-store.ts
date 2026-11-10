import { safeStorage } from 'electron'
import { uuidv7 } from '../../lib/id'
import { skipsOsKeyring } from '../../lib/utils'
import { Logger } from '../system/logger'
import { clearRepeatedFailure, reportRepeatedFailure } from '../system/repeated-failure-log'
import {
  VaultCiphertextUnreadableError,
  VaultRecordMissingError,
  VaultUnavailableError
} from './secret-errors'
import { describeSecretRef, generatedSecretRef } from './secret-refs'
import type { SecretScope } from '../../lib/secrets'
import { describeSecretWriter, type SecretWriterIdentity } from './secret-writer'
import type { SecretStorageAvailability, SecretStorageUnavailableReason } from '../../lib/secrets'
import type { StorageEngine } from '../storage/storage-engine'

/** What a caller knows about the value it is storing, kept beside the ciphertext. */
export interface SecretMetadata {
  scope?: SecretScope
  /** Id of the account, project, utility, thread or machine the value belongs to. */
  ownerId?: string
  /** Human label shown wherever the secret is listed. */
  label?: string
}

interface EncryptedSecretRecord {
  value: string
  createdAt: number
  updatedAt: number
  /** The build that wrote this ciphertext; absent on records written before it was recorded. */
  writer?: SecretWriterIdentity
  scope?: SecretScope
  ownerId?: string
  label?: string
}

/** One stored value as the inventory reads it: never the plaintext. */
export interface StoredSecretSummary {
  ref: string
  createdAt: number
  updatedAt: number
  scope: SecretScope
  ownerId?: string
  label?: string
  writer?: SecretWriterIdentity
}

type EncryptedSecretStore = Record<string, EncryptedSecretRecord>

const STORE_PATH = 'secrets/vault.json'
const vaultWriteTails = new WeakMap<StorageEngine, Promise<unknown>>()

/**
 * `safeStorage`'s synchronous encryption API is deprecated in Electron 45 and
 * removed in 46, so availability is asked through the async API. Every read and
 * write asks again, which keeps the answer current, and the last answer is cached
 * here because status snapshots, gateway catalogs and utility listings report
 * availability as a plain boolean through the synchronous `isAvailable()`.
 */
let encryptionAvailable = false
let encryptionUnavailableReason: SecretStorageUnavailableReason = 'unavailable'

/**
 * Whether the OS can encrypt a value for this launch.
 *
 * Two conditions make the answer no:
 *
 * - A launch the build starts by itself proves that the artifact boots, and it
 *   runs unattended. Asking `safeStorage` for anything initializes its keyring
 *   item, which macOS answers with a password prompt for a bundle whose ad-hoc
 *   signature is not the one that stored the item, so every freshly packaged
 *   build would stop and wait for a human to unlock the keychain.
 * - On Linux, Chromium falls back to its `basic_text` backend when no keyring is
 *   available, which is a plaintext password store wearing the name of an
 *   encrypted one. A credential kept there is not encrypted, so the store reports
 *   itself unavailable rather than silently writing something weaker than the app
 *   claims.
 */
async function probeEncryption(): Promise<boolean> {
  if (skipsOsKeyring()) {
    setUnavailable('unattended-launch')
    return false
  }
  try {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) {
      setUnavailable('unavailable')
      return false
    }
    if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text') {
      setUnavailable('plaintext-backend')
      return false
    }
    encryptionAvailable = true
  } catch (error: unknown) {
    Logger.error('Secure credential storage availability could not be detected:', error)
    setUnavailable('probe-failed')
  }
  return encryptionAvailable
}

function setUnavailable(reason: SecretStorageUnavailableReason): void {
  encryptionAvailable = false
  encryptionUnavailableReason = reason
}

/** Cached keyring availability, safe to read synchronously. */
export function isSecretEncryptionAvailable(): boolean {
  return encryptionAvailable
}

/** Why encryption is unavailable, for the page that has to explain it. */
export function secretStorageAvailability(): SecretStorageAvailability {
  return encryptionAvailable
    ? { available: true }
    : { available: false, reason: encryptionUnavailableReason }
}

/**
 * The encrypted at-rest store for every secret the app keeps.
 *
 * Ciphertext is stored under CodeInOven's config root. Callers persist only the
 * opaque reference returned by `save`; plaintext never crosses IPC.
 *
 * Ciphertext is portable only within one OS keyring identity: `safeStorage`
 * derives its key from the app name, so every launch that shares this store must
 * report the same name. A record written by a launch that reported another name
 * can never be decrypted here, which is why a read failure is classified and
 * reported (`VaultCiphertextUnreadableError`) instead of surfacing as a bare
 * keyring error, and why the App names every launch identically.
 */
export class SecretStore {
  constructor(private readonly storage: StorageEngine) {
    // Availability is detected as soon as a store exists so the synchronous
    // readers see a settled answer instead of the pre-probe default.
    void probeEncryption()
  }

  /** Cached keyring availability, safe to read synchronously. */
  isAvailable(): boolean {
    return encryptionAvailable
  }

  /** Availability plus the reason it is unavailable, for the settings page. */
  availability(): SecretStorageAvailability {
    return secretStorageAvailability()
  }

  async save(value: string, existingRef?: string, metadata?: SecretMetadata): Promise<string> {
    if (!(await probeEncryption())) throw new VaultUnavailableError()
    if (!value) throw new TypeError('Credential value must not be empty')
    // Encryption runs before the write is queued so the shared queue only
    // serializes keyring round trips that have already completed.
    const ciphertext = (await safeStorage.encryptStringAsync(value)).toString('base64')

    return this.mutate(async (store) => {
      const ref = existingRef ?? generatedSecretRef(uuidv7())
      const existing = store[ref]
      const now = Date.now()
      const writer = describeSecretWriter()
      // Metadata a caller does not restate is inherited from the record it
      // replaces, so rotating a value never forgets who the value belongs to.
      const scope = metadata?.scope ?? existing?.scope
      const ownerId = metadata?.ownerId ?? existing?.ownerId
      const label = metadata?.label ?? existing?.label
      store[ref] = {
        value: ciphertext,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        ...(writer ? { writer } : {}),
        ...(scope ? { scope } : {}),
        ...(ownerId ? { ownerId } : {}),
        ...(label ? { label } : {})
      }
      await this.storage.write(STORE_PATH, store)
      // Storing a credential again is the repair for an unreadable one, so it also
      // closes that credential's incident instead of leaving it failing for ever.
      clearRepeatedFailure(unreadableCredentialLabel(ref))
      return ref
    })
  }

  async resolve(ref: string): Promise<string> {
    if (!(await probeEncryption())) throw new VaultUnavailableError()
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
      // The Git sidebar polls a status that reads this store every few seconds, so
      // one unreadable credential reports itself once at error level and repeats at
      // dev level until it is stored again.
      const unreadable = new VaultCiphertextUnreadableError(
        ref,
        record.writer ?? null,
        describeSecretWriter(),
        failure
      )
      reportRepeatedFailure(unreadableCredentialLabel(ref), unreadable)
      throw unreadable
    }
  }

  async exists(ref: string): Promise<boolean> {
    return ref in (await this.load())
  }

  async remove(ref: string): Promise<void> {
    await this.mutate(async (store) => {
      if (!(ref in store)) return
      delete store[ref]
      await this.storage.write(STORE_PATH, store)
    })
  }

  /** Every stored value, described without its plaintext. */
  async list(): Promise<StoredSecretSummary[]> {
    const store = await this.load()
    return Object.entries(store).map(([ref, record]) => {
      const identity = describeSecretRef(ref)
      return {
        ref,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        scope: record.scope ?? identity.scope,
        ...((record.ownerId ?? identity.ownerId)
          ? { ownerId: record.ownerId ?? identity.ownerId }
          : {}),
        ...(record.label ? { label: record.label } : {}),
        ...(record.writer ? { writer: record.writer } : {})
      }
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
      await this.storage.write(STORE_PATH, store)
    })
  }

  private async load(): Promise<EncryptedSecretStore> {
    return (await this.storage.read<EncryptedSecretStore>(STORE_PATH)) ?? {}
  }

  /** All store users share this queue so two saves cannot lose one another. */
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
