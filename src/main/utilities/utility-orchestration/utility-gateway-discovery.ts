import {
  CORE_GATEWAY_TOOL_NAMES,
  gatewayToolForModel,
  type GatewayToolDefinition
} from '../../../lib/gateway-tools'

const READ_ONLY_TOOLS = new Set([
  'cio_orchestrate_targets',
  'cio_orchestrate_status',
  'cio_app_catalog',
  'cio_util_diagnose',
  'cio_util_find',
  'cio_util_docs_lookup'
])
type Execute = (tool: GatewayToolDefinition, args: Record<string, unknown>) => Promise<unknown>

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('Expected an argument object')
  return value as Record<string, unknown>
}

/** Lazy schemas and calls use the same grant list and handlers as direct tools. */
export async function invokeGatewayCapability(
  operation: string,
  input: Record<string, unknown>,
  granted: readonly GatewayToolDefinition[],
  execute: Execute
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
  const prepare = (
    value: unknown
  ): { tool: GatewayToolDefinition; args: Record<string, unknown> } => {
    const call = object(value)
    const tool = resolve(call['tool'])
    // Secret results require their dedicated environment-safe transport. Core
    // invocation/activation are also excluded to prevent recursive dispatch.
    if (CORE_GATEWAY_TOOL_NAMES.has(tool.name) && !READ_ONLY_TOOLS.has(tool.name))
      throw new Error('Use the dedicated core tool directly')
    return { tool, args: object(call['arguments'] ?? {}) }
  }
  if (operation === 'call') {
    const { tool, args } = prepare(input)
    return execute(tool, args)
  }
  if (operation === 'batch') {
    if (!Array.isArray(input['calls']) || input['calls'].length === 0 || input['calls'].length > 8)
      throw new TypeError('calls must contain one to eight independent reads')
    const calls = input['calls'].map(prepare)
    if (calls.some(({ tool }) => !READ_ONLY_TOOLS.has(tool.name)))
      throw new Error('Batch accepts read-only tools; execute mutations sequentially with call')
    const results: unknown[] = []
    for (let index = 0; index < calls.length; index += 2) {
      const batch = await Promise.all(
        calls.slice(index, index + 2).map(async ({ tool, args }) => {
          try {
            return { tool: tool.name, result: await execute(tool, args), isError: false }
          } catch (error) {
            return {
              tool: tool.name,
              isError: true,
              error: error instanceof Error ? error.message : 'Tool failed'
            }
          }
        })
      )
      results.push(...batch)
    }
    return { results }
  }
  throw new Error('Unknown gateway operation; use catalog, call or batch')
}
