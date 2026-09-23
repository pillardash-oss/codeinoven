import type { TypesafeCheckResult, TypesafeStatus } from '../types'
import type { Contract } from './contract-helpers'

/**
 * Renderer boundary for the app-owned TypeSafe (Jev) capability.
 *
 * The key value crosses this boundary in one direction only: `setKey` accepts
 * it as transient input, and every reply carries state instead, which matches
 * how `utilities:setCredential` and `providerAccounts:setApiKey` already work.
 */
export const invokeTypesafeContract = {
  'typesafe:getStatus': {} as Contract<[], TypesafeStatus>,
  'typesafe:setKey': {} as Contract<[value: string], TypesafeStatus>,
  'typesafe:clearKey': {} as Contract<[], TypesafeStatus>,
  /** Sends one real typed question and reports what the service answered. */
  'typesafe:check': {} as Contract<[], TypesafeCheckResult>
}
