import type { McpTool } from '../agents/mcp-stdio-client'

/**
 * A tool catalog an agent can afford to read.
 *
 * MCP servers describe every tool they own, and a desktop driver owns dozens:
 * full JSON schemas for all of them are tens of kilobytes, which pushes the
 * activation payload past the gateway's budget and spills it into a scratch file
 * the agent then has to mine for field names. Names, descriptions and a compact
 * input signature keep the knowledge that matters (what a tool does, which
 * fields it takes) in a fraction of the room.
 *
 * A catalog under the threshold is handed back untouched, because a small server
 * loses nothing by keeping its exact schemas.
 */
const COMPACT_THRESHOLD_BYTES = 12_000

/** One tool as the compact index presents it. */
export interface McpToolIndexEntry {
  name: string
  description?: string
  /** Rendered input signature, e.g. `{ pid: number, window_id: number, x?: number }`. */
  input: string
}

export function mcpCatalogPayload(tools: readonly McpTool[]): McpTool[] | McpToolIndexEntry[] {
  if (JSON.stringify(tools).length <= COMPACT_THRESHOLD_BYTES) return [...tools]
  return tools.map((tool) => ({
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    input: inputSignature(tool.inputSchema)
  }))
}

/**
 * One line describing what a tool accepts.
 *
 * Deliberately lossy: types, optional markers and enum values survive, nested
 * object detail does not. A call that gets a nested shape wrong is answered by
 * the server naming the field, which costs one retry instead of a transcript full
 * of schemas nobody read.
 */
export function inputSignature(schema: Record<string, unknown> | undefined): string {
  const properties = schema?.['properties']
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return '{}'
  const required = new Set(
    Array.isArray(schema?.['required'])
      ? (schema['required'] as unknown[]).filter(
          (value): value is string => typeof value === 'string'
        )
      : []
  )
  const fields = Object.entries(properties as Record<string, unknown>).map(([name, value]) => {
    const marker = required.has(name) ? '' : '?'
    return `${name}${marker}: ${fieldType(value)}`
  })
  return `{ ${fields.join(', ')} }`
}

function fieldType(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'unknown'
  const field = value as Record<string, unknown>
  const values = field['enum']
  if (Array.isArray(values) && values.length > 0) {
    return values.map((entry) => JSON.stringify(entry)).join(' | ')
  }
  const type = field['type']
  if (Array.isArray(type)) return type.filter((entry) => typeof entry === 'string').join(' | ')
  if (typeof type === 'string') {
    const items = field['items']
    if (type === 'array' && items && typeof items === 'object') {
      const item = items as Record<string, unknown>
      if (typeof item['type'] === 'string') return `${item['type']}[]`
    }
    return type
  }
  return 'unknown'
}
