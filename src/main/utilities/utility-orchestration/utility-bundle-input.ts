import type { UtilityDefinitionInput } from '../../../lib/types'
import { isRecord, requiredString } from './utility-input'

/**
 * Canonical bundle shape, quoted verbatim in every rejection so a caller that
 * guessed the layout is told the exact one to send instead.
 */
const BUNDLE_SHAPE =
  '{"name":"...","utilities":[{"definition":{"kind":"skill"|"mcp","name":"...","config":{...}}}]}'

/** The full example used when the discriminator itself is missing or wrong. */
const DEFINITION_EXAMPLE =
  '{"definition":{"kind":"mcp","name":"Slack","description":"...",' +
  '"config":{"transport":"http","url":"https://mcp.slack.com/mcp"}}}'

/**
 * Normalise the `bundle` argument of an `install_bundle` call into registry
 * definitions, tolerating the variants callers reliably write.
 *
 * The tool schema cannot describe the shape usefully (it is deliberately
 * permissive so the tolerant parse below receives what the model actually
 * sent), so three plausible-but-wrong layouts are accepted because each means
 * exactly one thing:
 *
 * - the entry list named `entries` instead of `utilities`;
 * - the utility fields flat on the entry instead of inside `definition`;
 * - the discriminator named `type` instead of `kind`.
 *
 * Credentials stay forbidden: the wrapper exists only to carry transient
 * secret values, which this path never accepts.
 */
export function normalizeBundleDefinitions(input: unknown): UtilityDefinitionInput[] {
  if (!isRecord(input)) {
    throw new TypeError(`Utility bundle must be an object shaped ${BUNDLE_SHAPE}`)
  }
  const bundle = input
  requiredString(bundle['name'], 'Utility bundle name', 120)
  const entries = Array.isArray(bundle['utilities'])
    ? bundle['utilities']
    : Array.isArray(bundle['entries'])
      ? bundle['entries']
      : undefined
  if (!entries || entries.length === 0 || entries.length > 20) {
    throw new TypeError(
      `Utility bundle needs a "utilities" array holding 1 to 20 entries, each shaped ` +
        `${BUNDLE_SHAPE}. Received keys: ${Object.keys(bundle).join(', ') || '(none)'}`
    )
  }
  return entries.map((rawEntry, index) => {
    if (!isRecord(rawEntry)) {
      throw new TypeError(
        `Utility bundle entry ${index} must be an object shaped ${BUNDLE_SHAPE}`
      )
    }
    const entry = rawEntry
    if (entry['credentials'] !== undefined) {
      throw new TypeError(`Utility bundle entry ${index} cannot contain credentials`)
    }
    if (entry['definition'] !== undefined && !isRecord(entry['definition'])) {
      throw new TypeError(
        `Utility bundle entry ${index} has a "definition" that is not an object: it must be ` +
          `{"kind":"skill"|"mcp","name":"...",...}`
      )
    }
    const definition: Record<string, unknown> =
      (entry['definition'] as Record<string, unknown> | undefined) ?? entry
    if (definition['kind'] === undefined && typeof definition['type'] === 'string') {
      definition['kind'] = definition['type']
    }
    if (definition['kind'] !== 'skill' && definition['kind'] !== 'mcp') {
      throw new TypeError(
        `Utility bundle entry ${index} must be a skill or MCP server: put "kind" set to ` +
          `"skill" or "mcp" inside "definition", for example ${DEFINITION_EXAMPLE}`
      )
    }
    const credentials = definition['credentials']
    if (credentials !== undefined && (!Array.isArray(credentials) || credentials.length > 0)) {
      throw new TypeError(`Utility bundle entry ${index} cannot contain credentials`)
    }
    // The registry generates `id`; a caller-supplied one is dropped rather than
    // stored, so it can never masquerade as a stable identity.
    const { id: _ignoredId, ...fields } = definition
    return { ...fields, credentials: [] } as unknown as UtilityDefinitionInput
  })
}
