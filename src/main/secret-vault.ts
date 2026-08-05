import { safeStorage } from 'electron'
import { uuidv7 } from '../lib/id'
import type { StorageEngine } from './storage-engine'

interface EncryptedSecretRecord {
  value: string
  createdAt: number
  updatedAt: number
}

type EncryptedSecretStore = Record<string, EncryptedSecretRecord>

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
