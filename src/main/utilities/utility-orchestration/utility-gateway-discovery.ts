import {
  CORE_GATEWAY_TOOL_NAMES,
  UTILITY_ACTIVATE_TOOL_NAME,
  UTILITY_DIAGNOSTICS_TOOL_NAME,
  UTILITY_DOCS_TOOL_NAME,
  UTILITY_SEARCH_TOOL_NAME,
  gatewayToolForModel,
  type GatewayToolDefinition
} from '../../../lib/gateway-tools'

/**
 * Gateway tools whose call only reads: a run of these may share one batch
 * window. Everything else runs in input order, because a mutation, an approval
 * card or an activation must not race the call that depends on it.
 */
const READ_ONLY_TOOLS = new Set([
  'cio_orchestrate_targets',
  'cio_orchestrate_status',
  'cio_app_catalog',
  UTILITY_DIAGNOSTICS_TOOL_NAME,
  UTILITY_SEARCH_TOOL_NAME,
  UTILITY_DOCS_TOOL_NAME
])

/** Entries of one `batch` call in flight at once, and items the gateway takes. */
const GATEWAY_BATCH_LIMIT = 8
const GATEWAY_BATCH_READ_CONCURRENCY = 2

/**
 * Core tools the gateway may dispatch.
 *
 * `cio_util_init` travels through the gateway on purpose: an agent with no
 * script runner has to be able to activate what it needs and call it in the
 * same round trip. Everything else core keeps its dedicated tool, because
 * `cio_util_use` would recurse into the gateway that is running the batch and
 * `cio_ask_secret` needs its own environment-safe transport.
 */
const GATEWAY_DISPATCHABLE_CORE_TOOLS = new Set([UTILITY_ACTIVATE_TOOL_NAME, ...READ_ONLY_TOOLS])

type Execute = (tool: GatewayToolDefinition, args: Record<string, unknown>) => Promise<unknown>
type ExecuteUtility = (
  utilityId: string,
  operation: string,
  input: Record<string, unknown>
) => Promise<unknown>

type GatewayCall = { kind: 'tool'; tool: GatewayToolDefinition; args: Record<string, unknown> }
type UtilityCall = {
  kind: 'utility'
  utilityId: string
  operation: string
  args: Record<string, unknown>
}
type BatchCall = GatewayCall | UtilityCall

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('Expected an argument object')
  return value as Record<string, unknown>
}

function requiredName(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '')
    throw new TypeError(`${field} must be a non-empty string`)
  return value
}

/** One settled result, tagged with what it targeted, in the caller's own words. */
async function settle(
  entry: BatchCall,
  execute: Execute,
  executeUtility: ExecuteUtility | undefined
): Promise<unknown> {
  const target =
    entry.kind === 'tool'
      ? { tool: entry.tool.name }
      : { utility_id: entry.utilityId, operation: entry.operation }
  try {
    const result = await runEntry(entry, execute, executeUtility)
    return { ...target, result, isError: false }
  } catch (error) {
    return {
      ...target,
      isError: true,
      error: error instanceof Error ? error.message : 'Tool failed'
    }
  }
}

async function runEntry(
  entry: BatchCall,
  execute: Execute,
  executeUtility: ExecuteUtility | undefined
): Promise<unknown> {
  if (entry.kind === 'tool') return execute(entry.tool, entry.args)
  if (!executeUtility) throw new Error('This gateway operation cannot call a utility')
  return executeUtility(entry.utilityId, entry.operation, entry.args)
}

const isConcurrentRead = (entry: BatchCall): boolean =>
  entry.kind === 'tool' && READ_ONLY_TOOLS.has(entry.tool.name)

/** Lazy schemas and calls use the same grant list and handlers as direct tools. */
export async function invokeGatewayCapability(
  operation: string,
  input: Record<string, unknown>,
  granted: readonly GatewayToolDefinition[],
  execute: Execute,
  executeUtility?: ExecuteUtility
): Promise<unknown> {
  const resolve = (name: unknown): GatewayToolDefinition => {
    const tool = granted.find((entry) => entry.name === name)
    if (!tool) throw new Error('Tool is not granted to this turn')
    return tool
  }
  if (operation === 'catalog') {
    if (input['names'] !== undefined) {
      if (!Array.isArray(input['names']) || input['names'].length > 16)
        throw new TypeError('names must contain at most 16 tool names')
      return {
        tools: input['names'].map((name: unknown) => {
          const { name: toolName, description, inputSchema, outputSchema } = resolve(name)
          return {
            name: toolName,
            description,
            inputSchema,
            ...(outputSchema ? { outputSchema } : {})
          }
        })
      }
    }
    return {
      tools: granted
        .filter(({ name }) => !CORE_GATEWAY_TOOL_NAMES.has(name))
        .map((tool) => ({ name: tool.name, description: gatewayToolForModel(tool).description })),
      next: 'Request catalog with names to load schemas, then call with {tool,arguments}.'
    }
  }
  const prepareTool = (value: unknown): GatewayCall => {
    const call = object(value)
    const tool = resolve(call['tool'])
    // Core tools outside the dispatchable set keep their dedicated transport:
    // `cio_util_use` would recurse into this gateway and `cio_ask_secret` hands
    // its value to the process environment rather than back to the model.
    if (CORE_GATEWAY_TOOL_NAMES.has(tool.name) && !GATEWAY_DISPATCHABLE_CORE_TOOLS.has(tool.name))
      throw new Error('Use the dedicated core tool directly')
    return { kind: 'tool', tool, args: object(call['arguments'] ?? {}) }
  }
  const prepareCall = (value: unknown): BatchCall => {
    const call = object(value)
    if (call['tool'] !== undefined) return prepareTool(call)
    if (call['utility_id'] === undefined)
      throw new Error(
        'Each batch entry needs either "tool" (a gateway tool) or "utility_id" with "operation"'
      )
    const utilityId = requiredName(call['utility_id'], 'utility_id')
    // A batch that targets the gateway itself would nest batches without bound.
    if (utilityId === 'cio:gateway')
      throw new Error('Nested gateway batches are not supported; list those calls side by side')
    return {
      kind: 'utility',
      utilityId,
      operation: requiredName(call['operation'], 'operation'),
      args: object(call['input'] ?? call['arguments'] ?? {})
    }
  }
  if (operation === 'call') {
    const { tool, args } = prepareTool(input)
    return execute(tool, args)
  }
  if (operation === 'batch') {
    if (
      !Array.isArray(input['calls']) ||
      input['calls'].length === 0 ||
      input['calls'].length > GATEWAY_BATCH_LIMIT
    )
      throw new TypeError(`calls must contain one to ${GATEWAY_BATCH_LIMIT} entries`)
    const calls = input['calls'].map(prepareCall)
    // One round trip, still ordered: a run of read-only calls shares a window,
    // while a mutation, an approval-gated call or a utility operation settles
    // before the next entry starts, so "activate, then call it" works in the
    // same batch and no card is raised two at a time by accident.
    const results: unknown[] = []
    let index = 0
    while (index < calls.length) {
      if (isConcurrentRead(calls[index])) {
        let end = index
        while (
          end < calls.length &&
          isConcurrentRead(calls[end]) &&
          end - index < GATEWAY_BATCH_READ_CONCURRENCY
        )
          end += 1
        const window = await Promise.all(
          calls.slice(index, end).map((entry) => settle(entry, execute, executeUtility))
        )
        results.push(...window)
        index = end
      } else {
        results.push(await settle(calls[index], execute, executeUtility))
        index += 1
      }
    }
    return { results }
  }
  throw new Error('Unknown gateway operation; use catalog, call or batch')
}
