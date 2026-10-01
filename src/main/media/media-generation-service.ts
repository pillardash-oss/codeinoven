import {
  MEDIA_GENERATION_TIMEOUT_MS,
  MEDIA_PROVIDERS,
  buildMediaGenerationInput,
  mediaProviderLabel,
  type MediaGenerationRequest,
  type MediaModelRef,
  type MediaProviderId
} from '../../lib/media-generation'
import type { AppConfig } from '../../lib/types'
import type { DesignMediaKind } from '../../lib/design-media'
import type { SecretVault } from '../storage/secret-vault'
import { createReplicateProvider } from './replicate-provider'
import type { MediaProvider } from './media-provider'

/**
 * The one place the app turns "make me a picture" into a provider call.
 *
 * The provider is the user's choice (`mediaGeneration.providerId`), the token is
 * the user's credential (the secure vault), and the model is the user's design
 * assignment (`src/lib/design-assignments.ts`). Nothing here picks a model or a
 * service on the agent's behalf, which is the rule the whole design capability is
 * built on.
 *
 * The service returns a URL and stops there. Writing the bytes is the existing
 * media saver's job, so there is exactly one writer of media on disk.
 */

/** Deterministic vault ref for one provider's token, so it survives a restart. */
export function mediaProviderTokenRef(providerId: MediaProviderId): string {
  return `media_provider_token_${providerId}`
}

/** What settings needs to know about the configured backend. */
export interface MediaGenerationStatus {
  providerId: MediaProviderId | null
  /** The provider's product name, when one is chosen. */
  providerLabel: string | null
  /** Whether the token is stored, so a generation would actually run. */
  hasToken: boolean
  /** Whether this device can store a credential at all. */
  secureStorageAvailable: boolean
}

/** A finished generation, before its bytes are saved. */
export interface MediaGenerationResult {
  url: string
  jobId: string
  providerId: MediaProviderId
  /** The model that ran, as the provider spelled it. */
  model: string
}

export interface MediaGenerationServiceOptions {
  /** The live config, read per call so a settings change applies at once. */
  config: () => Promise<AppConfig>
  vault: SecretVault
  /**
   * Builds the backend for one token. Injected by a probe, which points the same
   * client at a local server instead of the real endpoint.
   */
  createProvider?: (providerId: MediaProviderId, token: string) => MediaProvider
}

export class MediaGenerationService {
  constructor(private readonly options: MediaGenerationServiceOptions) {}

  private async providerId(): Promise<MediaProviderId | null> {
    const config = await this.options.config()
    return config.mediaGeneration.providerId
  }

  private buildProvider(providerId: MediaProviderId, token: string): MediaProvider {
    if (this.options.createProvider) return this.options.createProvider(providerId, token)
    if (providerId === 'replicate') return createReplicateProvider({ token })
    throw new Error(`The generation provider "${providerId}" has no client in this app.`)
  }

  async status(): Promise<MediaGenerationStatus> {
    const providerId = await this.providerId()
    if (!providerId) {
      return {
        providerId: null,
        providerLabel: null,
        hasToken: false,
        secureStorageAvailable: this.options.vault.isAvailable()
      }
    }
    return {
      providerId,
      providerLabel: mediaProviderLabel(providerId),
      hasToken: await this.options.vault.exists(mediaProviderTokenRef(providerId)),
      secureStorageAvailable: this.options.vault.isAvailable()
    }
  }

  /** Store (or rotate) one provider's token. Plaintext never leaves the vault. */
  async setToken(providerId: MediaProviderId, token: string): Promise<void> {
    const trimmed = token.trim()
    if (trimmed.length === 0) throw new TypeError('The generation token must not be empty')
    await this.options.vault.save(trimmed, mediaProviderTokenRef(providerId))
  }

  /** Forget one provider's token. The provider choice itself is left alone. */
  async clearToken(providerId: MediaProviderId): Promise<void> {
    await this.options.vault.remove(mediaProviderTokenRef(providerId))
  }

  /**
   * Run one generation for the configured provider.
   *
   * The model reference is parsed before anything is sent, so a typo fails here
   * with the accepted spellings named rather than as a provider error the agent
   * cannot act on. A missing provider or token is refused with the settings page
   * named, because that is the only place the user can fix it.
   */
  async generate(
    kind: DesignMediaKind,
    ref: MediaModelRef,
    model: string,
    request: MediaGenerationRequest
  ): Promise<MediaGenerationResult> {
    const providerId = await this.providerId()
    if (!providerId) {
      throw new Error(
        'No generation provider is configured. The user chooses one in Settings, Design, Generation.'
      )
    }
    const token = await this.options.vault
      .resolve(mediaProviderTokenRef(providerId))
      .catch(() => '')
    if (!token) {
      throw new Error(
        `No ${mediaProviderLabel(providerId)} token is stored. The user adds one in Settings, Design, Generation.`
      )
    }

    const provider = this.buildProvider(providerId, token)
    const result = await provider.generate({
      ref,
      input: buildMediaGenerationInput(request),
      timeoutMs: MEDIA_GENERATION_TIMEOUT_MS[kind]
    })
    return { url: result.url, jobId: result.jobId, providerId, model }
  }

  /** The endpoint the provider speaks to, for a message or a probe. */
  endpointFor(providerId: MediaProviderId): string {
    return MEDIA_PROVIDERS[providerId].endpoint
  }
}
