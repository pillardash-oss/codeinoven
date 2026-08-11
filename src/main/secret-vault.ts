import { safeStorage } from 'electron'
import { uuidv7 } from '../lib/id'
import type { CloudDeploymentProviderKind } from '../lib/types'
import type { StorageEngine } from './storage-engine'

interface EncryptedSecretRecord {
  value: string
  createdAt: number
  updatedAt: number
}

type EncryptedSecretStore = Record<string, EncryptedSecretRecord>

/** Deterministic SecretVault ref under which a deployment provider's token is stored. */
function providerTokenRef(kind: CloudDeploymentProviderKind): string {
  return `deployment_provider_${kind}`
}

/**
 * Main-process-only credential vault.
 *
 * Ciphertext is stored under CodeInOven's config root. Callers persist only
 * the opaque reference returned by `save`; plaintext never crosses IPC.
 */
export class SecretVault {
  private readonly storePath = 'secrets/vault.json'

  constructor(private readonly storage: StorageEngine) {}

  isAvailable(): boolean {
    return safeStorage.isEncryptionAvailable()
  }

  async save(value: string, existingRef?: string): Promise<string> {
    if (!this.isAvailable()) {
      throw new Error('Secure credential storage is unavailable on this device')
    }
    if (!value) throw new TypeError('Credential value must not be empty')

    const store = await this.load()
    const ref = existingRef ?? `secret_${uuidv7()}`
    const existing = store[ref]
    const now = Date.now()
    store[ref] = {
      value: safeStorage.encryptString(value).toString('base64'),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    }
    await this.storage.write(this.storePath, store)
    return ref
  }

  /**
   * Store (or rotate) a deployment provider token, encrypted via `safeStorage`.
   *
   * This mirrors the GitHub token storage mechanism: the token is stored under a
   * deterministic, provider-keyed ref inside the secure vault and only ciphertext
   * is persisted beneath the CodeInOven config root. The plaintext token is never
   * written to a repo or project file.
   *
   * Keychain-unavailable fallback: when the OS keychain (`safeStorage`) is
   * unavailable, this throws and the provider is left unconfigured. The vault
   * deliberately does not degrade to plaintext storage, so a provider token can
   * never be persisted outside the secure store.
   *
   * @returns the opaque ref under which the encrypted token was persisted.
   */
  async saveProviderToken(kind: CloudDeploymentProviderKind, token: string): Promise<string> {
    return this.save(token, providerTokenRef(kind))
  }

  /**
   * Resolve a deployment provider token from the secure vault.
   *
   * Keychain-unavailable fallback: when the OS keychain is unavailable this
   * throws rather than exposing stored ciphertext, keeping token access bound to
   * a working secure store.
   */
  async resolveProviderToken(kind: CloudDeploymentProviderKind): Promise<string> {
    return this.resolve(providerTokenRef(kind))
  }

  /** Whether a deployment provider token is currently stored for the kind. */
  async hasProviderToken(kind: CloudDeploymentProviderKind): Promise<boolean> {
    return this.exists(providerTokenRef(kind))
  }

  /** Remove the stored deployment provider token for the kind. */
  async removeProviderToken(kind: CloudDeploymentProviderKind): Promise<void> {
    await this.remove(providerTokenRef(kind))
  }

  async resolve(ref: string): Promise<string> {
    if (!this.isAvailable()) {
      throw new Error('Secure credential storage is unavailable on this device')
    }
    const record = (await this.load())[ref]
    if (!record) throw new Error('Credential not found')
    return safeStorage.decryptString(Buffer.from(record.value, 'base64'))
  }

  async remove(ref: string): Promise<void> {
    const store = await this.load()
    if (!(ref in store)) return
    delete store[ref]
    await this.storage.write(this.storePath, store)
  }

  async exists(ref: string): Promise<boolean> {
    return ref in (await this.load())
  }

  private async load(): Promise<EncryptedSecretStore> {
    return (await this.storage.read<EncryptedSecretStore>(this.storePath)) ?? {}
  }
}
