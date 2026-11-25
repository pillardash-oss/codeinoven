/**
 * `cio_util_use` on the Oven: run one operation on an activated utility.
 *
 * What can run here is exactly what the snapshot carries a way to run:
 *
 * - a utility with an MCP server runs that server on this machine and calls the
 *   operation as a tool (`tools/call`), which is the whole reason the Oven hosts
 *   a utility gateway at all;
 * - a `skill` is documentation and has no tool, so the operation answers with its
 *   instructions instead of failing — the same words its activation carried, for
 *   a turn whose context has since been compacted;
 * - anything else (a web, image or app-owned capability, `cio:gateway` itself) is
 *   executed by the app, which owns its executor, so the call is forwarded.
 *
 * The batch shape is the app's: `inputs` runs the same operation over many items
 * with bounded concurrency, one `{ok, result | error}` entry per item in the
 * caller's order, and `input: {}` beside `inputs` is not a conflict because every
 * harness serializer sends it.
 */
import type { OvenUtilityJson, OvenUtilityTurnUtility } from '../../../../lib/oven-utility-host'
import { OvenUtilityHttpError } from '../oven-utility-http'
import { ovenUtilityJson, ovenUtilitySummary } from './oven-utility-appliers'
import {
  forwardLocalFailure,
  forwardUnknownUtility,
  inputRecord,
  isRecord,
  recordInput,
  requiredText,
  type OvenUtilityLocalCall
} from './oven-utility-local-context'

/** Most items one invocation call may carry, mirroring the app's own limit. */
const INVOKE_BATCH_LIMIT = 32

/** Items of one batch in flight at once, mirroring the app's own bound. */
const INVOKE_BATCH_CONCURRENCY = 4

/**
 * `cio_util_use`: one operation, or the same one over many inputs.
 *
 * Returns `undefined` when the call must be forwarded: an id the snapshot does
 * not carry, a capability kind only the app can execute, or a server that could
 * not run here.
 */
export async function invokeOvenUtility(
  call: OvenUtilityLocalCall,
  input: OvenUtilityJson
): Promise<OvenUtilityJson | undefined> {
  const body = inputRecord(input)
  const batch = body['inputs']
  if (batch !== undefined) return await invokeOvenUtilityBatch(call, body, batch)
  const utilityId = requiredText(body, 'utility_id')
  const operation = requiredText(body, 'operation')
  const operationInput = recordInput(body, 'input')
  const utility = call.catalogue.get(utilityId)
  if (!utility) return forwardUnknownUtility(call, { route: '/invoke', utilityId })
  // A capability the snapshot gives this Oven no way to run is executed by the
  // app, and the app owns its activation state as well, so nothing here can
  // refuse the call: it is forwarded before any local gate is applied.
  if (!utility.server && utility.kind !== 'skill') return undefined
  const active = call.state.activation(utilityId)
  if (!active)
    throw new OvenUtilityHttpError(
      400,
      `Activate this utility before invoking it: \`${utilityId}\` has not been activated in this turn.`
    )
  return await runOvenUtilityOperation(call, active.utility, operation, operationInput)
}

/** One operation on one utility, answered here or left to the app. */
async function runOvenUtilityOperation(
  call: OvenUtilityLocalCall,
  utility: OvenUtilityTurnUtility,
  operation: string,
  operationInput: Record<string, OvenUtilityJson>
): Promise<OvenUtilityJson | undefined> {
  if (utility.kind === 'skill') {
    // A skill exposes no tool. Its contract is its documentation, so the
    // operation hands that back instead of reporting a kind mismatch: an agent
    // that lost the activation payload recovers from the one call it knows.
    return {
      utility: ovenUtilitySummary(utility),
      operation,
      capability: {
        instructions: utility.docs ?? utility.description,
        note: `\`${utility.id}\` is a skill: it exposes no tool to invoke, so this call returns its instructions. Do the work with your own tools, or with another capability this turn carries.`
      }
    }
  }
  if (!utility.server) return undefined
  try {
    const client = await call.state.openMcp(utility.server)
    return ovenUtilityJson(await client.callTool(operation, operationInput))
  } catch (error) {
    return forwardLocalFailure(call, { route: '/invoke', utilityId: utility.id, error })
  }
}

/**
 * The same operation over many items.
 *
 * `<input>` beside `<inputs>`: an empty object is what a harness serializer sends
 * for an omitted parameter and is not a conflict; a populated one is a caller
 * mistake. Each item settles alone, so one failing input never hides the rest.
 */
async function invokeOvenUtilityBatch(
  call: OvenUtilityLocalCall,
  body: Record<string, OvenUtilityJson>,
  batch: OvenUtilityJson
): Promise<OvenUtilityJson | undefined> {
  if (!Array.isArray(batch) || batch.length === 0)
    throw new OvenUtilityHttpError(400, 'inputs must be a non-empty array of operation inputs')
  if (batch.length > INVOKE_BATCH_LIMIT)
    throw new OvenUtilityHttpError(
      400,
      `inputs carries at most ${INVOKE_BATCH_LIMIT} items per call`
    )
  const single = body['input']
  if (single !== undefined && (!isRecord(single) || Object.keys(single).length > 0))
    throw new OvenUtilityHttpError(400, 'Pass either input or inputs, not both')
  const results: OvenUtilityJson[] = []
  let forwarded = false
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < batch.length) {
      const index = next++
      const entry = batch[index]
      try {
        const result = await invokeOvenUtility(call, {
          utility_id: body['utility_id'] ?? null,
          operation: body['operation'] ?? null,
          input: isRecord(entry) ? entry : null
        })
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
    Array.from({ length: Math.min(INVOKE_BATCH_CONCURRENCY, batch.length) }, worker)
  )
  if (forwarded) return undefined
  return { results }
}
