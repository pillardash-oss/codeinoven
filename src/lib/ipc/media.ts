import type { MediaProviderId } from '../media-generation'

/**
 * Shared records for the generation backend, so Settings can configure it and
 * the main process can report it.
 *
 * The token itself never crosses this boundary in either direction: the renderer
 * sends a value it was handed and reads back only whether one is stored.
 */

/** One backend as the settings page offers it. */
export interface MediaGenerationProviderDescriptor {
  id: MediaProviderId
  /** Product name the user knows, e.g. `Replicate`. */
  label: string
  /** Where a token comes from, linked beside the field that takes it. */
  keyUrl: string
  /** One line on what the token unlocks. */
  description: string
}

/** Everything Settings needs to render the generation card. */
export interface MediaGenerationState {
  /** The backend the config points at, or null before the user picks one. */
  providerId: MediaProviderId | null
  /** That backend's product name, when one is chosen. */
  providerLabel: string | null
  /** Whether a token is stored, so a generation would actually run. */
  hasToken: boolean
  /** Whether this device can store a credential at all. */
  secureStorageAvailable: boolean
  /** Every backend the app can call. */
  providers: MediaGenerationProviderDescriptor[]
}
