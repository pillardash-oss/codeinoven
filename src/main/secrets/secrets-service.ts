import type { StorageEngine } from '../storage/storage-engine'
import { SecretStore, type SecretMetadata } from './secret-store'

/**
 * The single entry point for every secret CodeInOven stores.
 *
 * Nothing in the app talks to the encrypted store directly. One service per
 * storage root is reachable through {@link SecretsService.for}, so a save, a
 * read and an availability probe all describe the same state: there is one place
 * to validate a name, one place to enforce that no plaintext is ever written, and
 * one place a reviewer has to look.
 *
 * The pieces it composes are deliberately small: `secret-store` owns the
 * ciphertext at rest, `secret-refs` owns every reference format, and
 * `secret-names` owns the naming rules.
 */
export class SecretsService {
  private static readonly instances = new WeakMap<StorageEngine, SecretsService>()

  /**
   * The one service for this storage root.
   *
   * Callers ask for the service instead of constructing one, because two
   * instances would each keep their own availability answer and their own view
   * of the same file.
   */
  static for(storage: StorageEngine): SecretsService {
    const existing = SecretsService.instances.get(storage)
    if (existing) return existing
    const created = new SecretsService(storage)
    SecretsService.instances.set(storage, created)
    return created
  }

  private readonly store: SecretStore

  private constructor(storage: StorageEngine) {
    this.store = new SecretStore(storage)
  }

  /** Cached OS keyring availability, safe to read synchronously. */
  isAvailable(): boolean {
    return this.store.isAvailable()
  }

  /**
   * Store one value and return the only thing a caller should persist: its ref.
   *
   * Passing the ref of an existing record rotates that value in place, which is
   * how every "save this credential again" path repairs an unreadable record
   * without orphaning the reference a project or a utility already holds.
   */
  async save(value: string, existingRef?: string, metadata?: SecretMetadata): Promise<string> {
    return this.store.save(value, existingRef, metadata)
  }

  /** Read one value. Throws a typed error when it is missing or unreadable. */
  async resolve(ref: string): Promise<string> {
    return this.store.resolve(ref)
  }

  /**
   * Read one value, or `null` when the caller is asking about a credential that
   * may legitimately be absent, such as an optional sign-in.
   */
  async resolveOrNull(ref: string): Promise<string | null> {
    try {
      return await this.store.resolve(ref)
    } catch {
      return null
    }
  }

  async exists(ref: string): Promise<boolean> {
    return this.store.exists(ref)
  }

  async remove(ref: string): Promise<void> {
    await this.store.remove(ref)
  }
}
