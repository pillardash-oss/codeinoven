/**
 * The shape a locally executed call leaves the host in.
 *
 * A harness that calls the gateway gets one shape whichever side ran the call:
 * `content` parts a model reads, and the same payload as `structuredContent` a
 * script resolves the call to. That is exactly what the app's gateway answers
 * (see `utility-gateway-output` and the structured routes in
 * `utility-orchestration-service-orchestration`), so an Oven-local answer is
 * shaped by the app's own function rather than by a second implementation of the
 * same idea. A forwarded call and a local one are then indistinguishable to the
 * agent, which is the whole point of running it here.
 *
 * The one thing added is the wire conversion: what crosses the envelope is JSON,
 * so every value that is not JSON becomes the JSON it would have been.
 */
import { gatewayStructuredResult } from '../../../../lib/image-payload'
import type { OvenUtilityJson, OvenUtilityTurnUtility } from '../../../../lib/oven-utility-host'

/** How deep a result is walked before it is carried as JSON text instead. */
const MAX_DEPTH = 32

/** One value as the host can carry it: JSON, never `undefined`, never a cycle. */
export function ovenUtilityJson(value: unknown, depth = 0): OvenUtilityJson {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') return value.toString()
  if (depth >= MAX_DEPTH) return null
  if (Array.isArray(value)) return value.map((entry) => ovenUtilityJson(entry, depth + 1))
  if (typeof value !== 'object') return null
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  if (value instanceof Error) return value.message
  const record: { [key: string]: OvenUtilityJson } = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry === undefined) continue
    record[key] = ovenUtilityJson(entry, depth + 1)
  }
  return record
}

/** One result as the gateway answers it: content parts beside the same payload. */
export function ovenUtilityGatewayResult(result: unknown): OvenUtilityJson {
  return ovenUtilityJson(gatewayStructuredResult(result))
}

/** How an activation or a docs lookup names the utility it is about. */
export function ovenUtilitySummary(utility: OvenUtilityTurnUtility): {
  id: string
  name: string
  kind: string
} {
  return { id: utility.id, name: utility.name, kind: utility.kind }
}
