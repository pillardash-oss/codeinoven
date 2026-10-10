import type { AppControlResponse } from '../app-control'
import type { Contract } from './contract-helpers'

/**
 * Renderer boundary for the app-control bridge.
 *
 * Main asks the renderer to perform one app call over the `appControl:request`
 * event; the renderer answers here, on an invoke it already owns, with the
 * `requestId` main parked the call under. There is no value crossing in the
 * other direction   the request travels as an event, so this contract carries
 * only the renderer's answer.
 */
export const invokeAppControlContract = {
  /** The renderer announces it can answer app-control requests; main targets it. */
  'appControl:ready': {} as Contract<[], void>,
  /** Answer one parked app-control request from main. */
  'appControl:respond': {} as Contract<[response: AppControlResponse], void>
}
