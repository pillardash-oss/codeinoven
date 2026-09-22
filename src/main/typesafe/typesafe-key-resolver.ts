import type { TypesafeKeySource } from '../../lib/types'
import type { AgentSecretService } from '../utilities/agent-secret-service'
import type { UtilityRegistryService } from '../utilities/utility-registry-service'
import type { SecretVault } from '../storage/secret-vault'
import { Logger } from '../system/logger'

/** The variable name every TypeSafe consumer in the ecosystem uses. */
export const TYPESAFE_ENVIRONMENT_VARIABLE = 'TYPESAFE_API_KEY'

/**
 * Deterministic vault ref for the key this device stores.
 *
 * One ref, one writer, one reader, the same shape as `providerTokenRef`: the
 * ref is a constant, so rotating the key is a save over the same ref and no
 * consumer ever holds or passes a reference around.
 */
export const TYPESAFE_KEY_REF = 'cio_typesafe_api_key'

/** Longest key accepted, generous enough for a future format change. */
const KEY_MAXIMUM_LENGTH = 4_096

/** The skill a user installs to build with TypeSafe, preferred when ranking credentials. */
const TYPESAFE_SKILL_NAME = 'typesafe-ai'

export interface ResolvedTypesafeKey {
  value: string
  source: TypesafeKeySource
  /** Which utility or thread the value came from, for the status line. */
  detail?: string
}

function usableKey(value: string | undefined | null): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > KEY_MAXIMUM_LENGTH) return null
  return trimmed
}

/**
 * Finds the TypeSafe key this device is already configured with.
 *
 * A user reaches TypeSafe in more than one way, and every one of them is a
 * legitimate configuration: they can paste the key into Settings, export
 * `TYPESAFE_API_KEY` in the shell that launched CodeInOven, attach it to an
 * installed utility as a credential, or let an agent collect it inside a thread
 * with `cio_ask_secret`. None of those should have to be repeated, so the
 * resolver reads all four and reports which one answered.
 *
 * Order is broadest first. The device key is the most deliberate statement of
 * intent and applies everywhere; a thread secret is the narrowest and applies
 * only where that thread is known. The first usable value wins, and a source
 * that cannot be read is skipped rather than failing the lookup, because a
 * stale credential must never take the capability down with it.
 */
export class TypesafeKeyResolver {
  /** Cached resolution, so a per-turn caller does not re-read the vault. */
  private cache: { key: string; resolvedAt: number; result: ResolvedTypesafeKey | null } | null =
    null

  /** How long one resolution is reused before the sources are read again. */
  private static readonly CACHE_TTL_MS = 15_000

  constructor(
    private readonly vault: SecretVault,
    private readonly registry: UtilityRegistryService,
    private readonly agentSecrets: AgentSecretService
  ) {}

  /**
   * Resolve the key to use, optionally narrowed to one thread.
   *
   * `threadId` only widens what can be found: without one, a key that exists
   * solely inside a thread is still found by scanning the secret registries,
   * which is what lets the Settings card tell the truth about a key the user
   * set in a conversation.
   */
  async resolve(threadId?: string): Promise<ResolvedTypesafeKey | null> {
    const cacheKey = threadId ?? ''
    const cached = this.cache
    if (
      cached &&
      cached.key === cacheKey &&
      Date.now() - cached.resolvedAt < TypesafeKeyResolver.CACHE_TTL_MS
    ) {
      return cached.result
    }
    // A caller decides on the strength of a null, so a source that misbehaves
    // must read as "no key" rather than as an exception thrown into a turn.
    let result: ResolvedTypesafeKey | null = null
    try {
      result = await this.read(threadId)
    } catch (error) {
      Logger.dev('TypeSafe key could not be resolved:', error)
    }
    this.cache = { key: cacheKey, resolvedAt: Date.now(), result }
    return result
  }

  /** Store the device key, overwriting whatever was there, and drop the cache. */
  async store(value: string): Promise<void> {
    const key = usableKey(value)
    if (!key) throw new TypeError('TypeSafe API key must be a non-empty string')
    await this.vault.save(key, TYPESAFE_KEY_REF)
    this.invalidate()
  }

  /** Forget the device key. Keys held by the environment, a utility or a thread stay put. */
  async clear(): Promise<void> {
    await this.vault.remove(TYPESAFE_KEY_REF)
    this.invalidate()
  }

  /**
   * Whether a key can be stored at all.
   *
   * The vault refuses to degrade to plaintext when the OS keychain is missing,
   * so the UI reports this instead of offering a field that would fail.
   */
  isStorageAvailable(): boolean {
    return this.vault.isAvailable()
  }

  /** Drop the cached resolution, so the next lookup reads the sources again. */
  invalidate(): void {
    this.cache = null
  }

  private async read(threadId?: string): Promise<ResolvedTypesafeKey | null> {
    const device = await this.readDeviceKey()
    if (device) return device
    const environment = usableKey(process.env[TYPESAFE_ENVIRONMENT_VARIABLE])
    if (environment) return { value: environment, source: 'environment' }
    const utility = await this.readUtilityCredential()
    if (utility) return utility
    return this.readThreadSecret(threadId)
  }

  private async readDeviceKey(): Promise<ResolvedTypesafeKey | null> {
    try {
      if (!(await this.vault.exists(TYPESAFE_KEY_REF))) return null
      const value = usableKey(await this.vault.resolve(TYPESAFE_KEY_REF))
      return value ? { value, source: 'device' } : null
    } catch (error) {
      Logger.dev('TypeSafe device key could not be resolved:', error)
      return null
    }
  }

  /**
   * A credential a user attached to an installed utility.
   *
   * The TypeSafe skill is preferred when it is present, because that is the
   * capability a user would have bound the key to; any other utility holding
   * the same variable is accepted afterwards, since the value is the same key
   * either way.
   */
  private async readUtilityCredential(): Promise<ResolvedTypesafeKey | null> {
    const utilities = await this.registry.list().catch((error: unknown) => {
      Logger.dev('Utility registry could not be read for the TypeSafe key:', error)
      return null
    })
    if (!utilities) return null
    const ranked = [
      ...utilities.filter((utility) => utility.name === TYPESAFE_SKILL_NAME),
      ...utilities.filter((utility) => utility.name !== TYPESAFE_SKILL_NAME)
    ]
    for (const utility of ranked) {
      for (const credential of utility.credentials) {
        if (credential.environmentVariable !== TYPESAFE_ENVIRONMENT_VARIABLE) continue
        try {
          const value = usableKey(await this.vault.resolve(credential.secretRef))
          if (value) return { value, source: 'utility', detail: utility.name }
        } catch (error) {
          Logger.dev('Utility credential could not be resolved for the TypeSafe key:', error)
        }
      }
    }
    return null
  }

  private async readThreadSecret(threadId?: string): Promise<ResolvedTypesafeKey | null> {
    try {
      if (threadId) {
        const value = usableKey(
          await this.agentSecrets.resolveThreadSecret(threadId, TYPESAFE_ENVIRONMENT_VARIABLE)
        )
        if (value) return { value, source: 'thread', detail: threadId }
        return null
      }
      const found = await this.agentSecrets.findThreadSecret(TYPESAFE_ENVIRONMENT_VARIABLE)
      if (!found) return null
      const value = usableKey(found.value)
      return value ? { value, source: 'thread', detail: found.threadId } : null
    } catch (error) {
      Logger.dev('Thread secret could not be read for the TypeSafe key:', error)
      return null
    }
  }
}
