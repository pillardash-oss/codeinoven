/**
 * How one call a turn's gateway received is answered on the Oven.
 *
 * Two answers exist, in this order:
 *
 * 1. A local runner. This is the seam the next phase plugs MCP servers into: it
 *    can answer a route on the Oven itself (search the bundled catalog, run a
 *    stdio MCP server this turn was granted, read this machine's diagnostics).
 *    It answers `undefined` for a call it will not run, and the call is
 *    forwarded instead.
 * 2. The turn's relay, which carries the call to the client that owns the
 *    capability and back. A turn without a relay is still a real turn: the host
 *    says plainly that the capability needs its app rather than pretending the
 *    tool does not exist.
 */
import { randomUUID } from 'node:crypto'
import {
  OVEN_UTILITY_RELAY_CALL_TIMEOUT_MS,
  type OvenUtilityJson,
  type OvenUtilityTurn
} from '../../../../lib/oven-utility-host'
import { OvenUtilityHttpError, postOvenUtilityJson } from '../oven-utility-http'

/**
 * The seam for answering a call on the Oven instead of forwarding it.
 *
 * Returning a value answers the call here; returning `undefined` forwards it to
 * the turn's relay. It is deliberately synchronous with respect to the route
 * name: a runner decides per route, so a host can run utilities locally while
 * app-owned routes keep travelling to the app.
 */
export type OvenUtilityLocalRunner = (
  turn: OvenUtilityTurn,
  route: string,
  input: OvenUtilityJson
) => Promise<OvenUtilityJson | undefined>

/** What a turn without a relay is told when it calls an app-owned route. */
export function ovenUtilityNeedsItsApp(route: string): string {
  return `This capability needs its app: ${route} is app-owned and this client has no relay.`
}

/** Answer one call: locally first, then through the turn's relay. */
export async function answerOvenUtilityCall(
  turn: OvenUtilityTurn,
  route: string,
  input: OvenUtilityJson,
  localRunner?: OvenUtilityLocalRunner
): Promise<OvenUtilityJson> {
  if (localRunner) {
    const local = await localRunner(turn, route, input)
    if (local !== undefined) return local
  }
  if (!turn.relayUrl) throw new OvenUtilityHttpError(503, ovenUtilityNeedsItsApp(route))
  return await askOvenUtilityRelay(turn.relayUrl, turn.turnId, route, input)
}

/**
 * Forward one call to the turn's relay and wait for the client's answer.
 *
 * The wait is bounded by the relay's own deadline rather than a gateway's: the
 * client owns the timeout on a tool call the user has to answer by hand, so the
 * host only gives up when no answer can arrive at all.
 */
export async function askOvenUtilityRelay(
  relayUrl: string,
  turnId: string,
  route: string,
  input: OvenUtilityJson
): Promise<OvenUtilityJson> {
  const id = randomUUID()
  let result
  try {
    result = await postOvenUtilityJson(
      relayUrl,
      { kind: 'ask', id, turnId, route, input },
      { timeoutMs: OVEN_UTILITY_RELAY_CALL_TIMEOUT_MS }
    )
  } catch (error) {
    throw new OvenUtilityHttpError(
      502,
      `The app could not be reached for ${route}: ${
        error instanceof Error ? error.message : 'the relay is gone.'
      }`
    )
  }
  if (result.envelope?.ok === true) return result.envelope.value
  if (result.envelope?.ok === false) throw new OvenUtilityHttpError(502, result.envelope.error)
  throw new OvenUtilityHttpError(
    502,
    `The app answered ${route} with something the host cannot read (HTTP ${result.status}).`
  )
}
