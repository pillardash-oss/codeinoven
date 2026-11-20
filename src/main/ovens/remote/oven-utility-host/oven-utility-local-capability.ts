/**
 * `cio_util_init` and `cio_util_docs_lookup` on the Oven.
 *
 * Both routes answer one question ("what does this utility let me do?") from two
 * possible sources in the turn's snapshot: the full documentation the client
 * shipped, and the MCP server this Oven is allowed to start. Everything the
 * snapshot cannot describe is left to the app by forwarding, because guessing a
 * capability's schema is worse than a round trip.
 *
 * Activation is a capability, not a session: it is remembered per turn, it is
 * idempotent (a repeat answers with a note rather than duplicating an unchanged
 * schema into the transcript), and it opens the utility's MCP server once. When
 * that server cannot run here the call is forwarded, so a server the Oven cannot
 * spawn still works for a turn the app is relaying.
 */
import type { OvenUtilityJson, OvenUtilityTurnUtility } from '../../../../lib/oven-utility-host'
import { mcpCatalogPayload } from '../../../utilities/mcp-tool-catalog'
import { OvenUtilityHttpError } from '../oven-utility-http'
import { ovenUtilityJson, ovenUtilitySummary } from './oven-utility-appliers'
import {
  forwardLocalFailure,
  forwardUnknownUtility,
  inputRecord,
  isRecord,
  requiredText,
  optionalFlag,
  type OvenUtilityLocalCall
} from './oven-utility-local-context'

/** Most utilities one activation call may carry, mirroring the app's own limit. */
const ACTIVATE_BATCH_LIMIT = 8

/** Activations of one batch in flight at once, mirroring the app's own bound. */
const ACTIVATE_BATCH_CONCURRENCY = 2

/** Which source describes a utility best for the route being answered. */
type CapabilityPreference = 'activation' | 'docs'

/**
 * `cio_util_init`: activate one utility, or a batch of them.
 *
 * Returns `undefined` when the call must be forwarded: an id the snapshot does
 * not carry (the app owns `cio:gateway`, app utilities and anything installed
 * mid-turn), or a server that could not start here.
 */
export async function activateOvenUtility(
  call: OvenUtilityLocalCall,
  input: OvenUtilityJson
): Promise<OvenUtilityJson | undefined> {
  const body = inputRecord(input)
  const batch = body['inputs']
  if (batch !== undefined) return await activateOvenUtilityBatch(call, body, batch)
  const utilityId = requiredText(body, 'utility_id')
  const force = optionalFlag(body, 'force') === true
  const utility = call.catalogue.get(utilityId)
  if (!utility) return forwardUnknownUtility(call, { route: '/activate', utilityId })
  const entry = call.state.activate(utility)
  if (!force && !call.state.announce(utilityId))
    return {
      utility: ovenUtilitySummary(utility),
      capability: {
        note: `\`${utilityId}\` is already active in this turn. Its capability description was returned by the earlier activation and is unchanged; invoke it directly. If context compaction dropped that description, re-list it with cio_util_docs_lookup (or re-activate with input {"force": true}).`
      }
    }
  const capability = await describeOvenUtility(call, utility, 'activation')
  if (!capability) return undefined
  return { utility: ovenUtilitySummary(entry.utility), capability }
}

/**
 * `cio_util_docs_lookup`: re-list one utility's full docs by id alone.
 *
 * The post-compaction path: the id is what an agent still has, so the answer must
 * be the whole contract or the app's own answer. Marks the utility active, so a
 * following invoke works directly, exactly as the app does.
 */
export async function lookupOvenUtilityDocs(
  call: OvenUtilityLocalCall,
  input: OvenUtilityJson
): Promise<OvenUtilityJson | undefined> {
  const body = inputRecord(input)
  const utilityId = requiredText(body, 'utility_id')
  const utility = call.catalogue.get(utilityId)
  if (!utility) return forwardUnknownUtility(call, { route: '/docs-lookup', utilityId })
  call.state.activate(utility)
  call.state.announce(utilityId)
  const capability = await describeOvenUtility(call, utility, 'docs')
  if (!capability) return undefined
  return { utility: ovenUtilitySummary(utility), capability }
}

/**
 * What one utility lets this turn do, read from the snapshot and this Oven.
 *
 * `undefined` means the snapshot carries neither docs nor a server for it, so the
 * app is the only side that can describe it.
 */
async function describeOvenUtility(
  call: OvenUtilityLocalCall,
  utility: OvenUtilityTurnUtility,
  preference: CapabilityPreference
): Promise<OvenUtilityJson | undefined> {
  const documentation = async (): Promise<OvenUtilityJson | undefined> =>
    utility.docs === undefined ? undefined : { instructions: utility.docs }
  const tools = async (): Promise<OvenUtilityJson | undefined> => {
    if (!utility.server) return undefined
    try {
      const client = await call.state.openMcp(utility.server)
      return ovenUtilityJson({ tools: mcpCatalogPayload(await client.listTools()) })
    } catch (error) {
      return forwardLocalFailure(call, {
        route: preference === 'docs' ? '/docs-lookup' : '/activate',
        utilityId: utility.id,
        error
      })
    }
  }
  const preferred = preference === 'docs' ? [documentation, tools] : [tools, documentation]
  for (const source of preferred) {
    const capability = await source()
    if (capability !== undefined) return capability
  }
  return undefined
}

/**
 * Several activations in one call.
 *
 * One entry that has to be forwarded forwards the whole batch: a batch is one
 * answer, so half of it can never be served here. Each other entry still settles
 * on its own, in the caller's order, so one unavailable utility never hides the
 * rest of the catalogs the call asked for.
 */
async function activateOvenUtilityBatch(
  call: OvenUtilityLocalCall,
  body: Record<string, OvenUtilityJson>,
  batch: OvenUtilityJson
): Promise<OvenUtilityJson | undefined> {
  if (!Array.isArray(batch) || batch.length === 0)
    throw new OvenUtilityHttpError(400, 'inputs must be a non-empty array of {utility_id} entries')
  if (batch.length > ACTIVATE_BATCH_LIMIT)
    throw new OvenUtilityHttpError(
      400,
      `inputs carries at most ${ACTIVATE_BATCH_LIMIT} entries per call`
    )
  const single = body['utility_id']
  if (typeof single === 'string' ? single.length > 0 : single !== undefined)
    throw new OvenUtilityHttpError(400, 'Pass either utility_id or inputs, not both')
  const results: OvenUtilityJson[] = []
  let forwarded = false
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < batch.length) {
      const index = next++
      const entry = batch[index]
      try {
        const result = await activateOvenUtility(call, isRecord(entry) ? entry : {})
        if (result === undefined) {
          forwarded = true
          continue
        }
        results[index] = { ok: true, result }
      } catch (error) {
        results[index] = {
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(ACTIVATE_BATCH_CONCURRENCY, batch.length) }, worker)
  )
  if (forwarded) return undefined
  return { results }
}
