import type { MediaProviderId } from '../media-generation'
import type { MediaGenerationState } from './media'
import type { Contract } from './contract-helpers'

export const invokeMediaContract = {
  /**
   * The generation backend the user chose, whether its token is stored, and the
   * backends this build can call.
   *
   * Read by the generation card so it can show a configured provider without
   * ever handling the token back.
   */
  'mediaGeneration:state': {} as Contract<[], MediaGenerationState>,
  /**
   * Store or rotate one provider's token. The value goes straight to the secure
   * vault in the main process and is never persisted anywhere else.
   */
  'mediaGeneration:setToken': {} as Contract<
    [providerId: MediaProviderId, token: string],
    MediaGenerationState
  >,
  /** Forget one provider's token. The provider choice is left alone. */
  'mediaGeneration:clearToken': {} as Contract<[providerId: MediaProviderId], MediaGenerationState>
}
