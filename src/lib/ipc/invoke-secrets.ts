import type { SecretsOverview, SecretDeleteRequest, SecretRotateRequest } from '../secrets'
import type { Contract } from './contract-helpers'

/**
 * Renderer boundary for the secrets the app stores.
 *
 * The boundary is one-way for values: `rotate` accepts a new value as transient
 * input, and every reply is the described inventory. No channel ever returns a
 * stored plaintext to the renderer.
 */
export const invokeSecretsContract = {
  'secrets:overview': {} as Contract<[], SecretsOverview>,
  'secrets:rotate': {} as Contract<[request: SecretRotateRequest], SecretsOverview>,
  'secrets:delete': {} as Contract<[request: SecretDeleteRequest], SecretsOverview>
}
