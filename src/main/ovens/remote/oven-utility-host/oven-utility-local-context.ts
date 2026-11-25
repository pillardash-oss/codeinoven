/**
 * What one Oven-local call is given, and how its input is read.
 *
 * The call owns exactly two things: the turn (which is the whole authority and
 * the whole catalogue, since the Oven has no registry, no database and no vault)
 * and the local state that turn has accumulated so far. Handlers get this
 * context instead of the host, so a handler can neither mint a turn nor answer a
 * route it was not asked about.
 *
 * The input helpers are the app's (`utility-orchestration/utility-input`) with
 * one deliberate difference: a bad field is an HTTP-shaped error the host can
 * answer with a status and the app's own wording, not a bare `TypeError`.
 */
import type {
  OvenUtilityJson,
  OvenUtilityTurn,
  OvenUtilityTurnUtility
} from '../../../../lib/oven-utility-host'
import { Logger } from '../../../system/logger'
import { OvenUtilityHttpError } from '../oven-utility-http'
import { OvenUtilityMcpUnavailableError, OvenUtilityToolError } from './oven-utility-mcp'
import type { OvenUtilityLocalTurn } from './oven-utility-local-turns'

/** What one Oven-local call is given. */
export interface OvenUtilityLocalCall {
  /** The turn whose token arrived with this call. */
  readonly turn: OvenUtilityTurn
  /** The local state this turn has accumulated: activations and MCP connections. */
  readonly state: OvenUtilityLocalTurn
  /** The utilities this turn may run here, by id. The Oven's only catalogue. */
  readonly catalogue: ReadonlyMap<string, OvenUtilityTurnUtility>
  /** Package names of the checkout this host sits in, for search tie-breaking. */
  projectTerms(): Promise<ReadonlySet<string>>
}

/** The catalogue a turn carries: its utility snapshot, keyed by id. */
export function ovenUtilityCatalogue(
  turn: OvenUtilityTurn
): ReadonlyMap<string, OvenUtilityTurnUtility> {
  return new Map(turn.utilities.map((utility) => [utility.id, utility]))
}

/** One field the call must carry, trimmed, bounded and free of NUL. */
export function requiredText(input: Record<string, OvenUtilityJson>, field: string): string {
  const value = input[field]
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\0'))
    throw new OvenUtilityHttpError(400, `${field} is invalid`)
  return value.trim()
}

/** One optional field, read only when it is a string. */
export function optionalText(
  input: Record<string, OvenUtilityJson>,
  field: string
): string | undefined {
  const value = input[field]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' || value.includes('\0'))
    throw new OvenUtilityHttpError(400, `${field} is invalid`)
  return value.trim()
}

/** One optional boolean, read only when it is one. */
export function optionalFlag(
  input: Record<string, OvenUtilityJson>,
  field: string
): boolean | undefined {
  const value = input[field]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw new OvenUtilityHttpError(400, `${field} is invalid`)
  return value
}

/** The object one call carries, defaulting to none. */
export function recordInput(
  input: Record<string, OvenUtilityJson>,
  field: string
): Record<string, OvenUtilityJson> {
  const value = input[field]
  if (value === undefined || value === null) return {}
  if (!isRecord(value)) throw new OvenUtilityHttpError(400, `${field} must be an object`)
  return value
}

/** One bounded list of kind names, or null when the call named none. */
export function optionalKinds(input: Record<string, OvenUtilityJson>): ReadonlySet<string> | null {
  const value = input['kinds']
  if (value === undefined || value === null) return null
  if (!Array.isArray(value) || value.some((kind) => typeof kind !== 'string'))
    throw new OvenUtilityHttpError(400, 'kinds must be a list of utility kinds')
  return new Set(value as string[])
}

/** One bounded number from a call, or the fallback when it named none. */
export function optionalNumber(
  input: Record<string, OvenUtilityJson>,
  field: string,
  fallback: number
): number {
  const value = input[field]
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new OvenUtilityHttpError(400, `${field} is invalid`)
  return value
}

/** The call's body as a record, since a route may be posted with no body at all. */
export function inputRecord(value: OvenUtilityJson): Record<string, OvenUtilityJson> {
  if (value === null) return {}
  if (!isRecord(value)) throw new OvenUtilityHttpError(400, 'The call input must be an object')
  return value
}

export function isRecord(value: OvenUtilityJson): value is Record<string, OvenUtilityJson> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The call to make for a utility id this turn's snapshot does not carry.
 *
 * The snapshot is what the client decided this turn may run here. An id outside
 * it belongs to the app: `cio:gateway`, an app-owned capability, one installed
 * moments ago, or one another turn banked. A turn with no relay has no app to
 * ask, and is told exactly that instead of being handed a routing failure.
 */
export function forwardUnknownUtility(
  call: OvenUtilityLocalCall,
  input: { route: string; utilityId: string }
): undefined {
  if (call.turn.relayUrl) return undefined
  throw new OvenUtilityHttpError(
    404,
    `No utility with id \`${input.utilityId}\` is available on this Oven, so ${input.route} has nothing to answer with: only the utilities this turn was granted are here, and this client opened no app to relay it to.`
  )
}

/**
 * A local execution that could not run, answered by forwarding it instead.
 *
 * The rule the host promised is that a local failure never becomes a failed tool
 * call: the app may be able to spawn the server, reach the URL or run the whole
 * utility itself, so the call goes back to the turn's relay and the agent sees
 * the app's answer. What a local failure does cost is one log line per utility
 * per turn, which is how an operator learns that the Oven could not run
 * something it was handed.
 *
 * A refusal the server itself sent is not this: the call ran and the server
 * answered, so that is returned to the agent as the tool's own error.
 */
export function forwardLocalFailure(
  call: OvenUtilityLocalCall,
  input: { route: string; utilityId: string; error: unknown }
): undefined {
  const reason = input.error instanceof Error ? input.error.message : String(input.error)
  if (input.error instanceof OvenUtilityToolError)
    throw new OvenUtilityHttpError(400, `${input.utilityId}: ${reason}`)
  if (!(input.error instanceof OvenUtilityMcpUnavailableError)) throw input.error
  if (call.state.reportFailure(input.utilityId))
    Logger.info(
      `Oven utility ${input.utilityId} could not run ${input.route} on this Oven, so the call was forwarded to the app: ${reason}`
    )
  return undefined
}
