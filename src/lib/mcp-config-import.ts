import type { McpUtilityConfig } from './types'

/**
 * Reading an MCP server out of a configuration someone pasted.
 *
 * People copy these blocks from a project README, from another harness's
 * `mcp.json`, from a plugin author's install instructions, or from this app's
 * own docs, and every source shapes them slightly differently: the shared
 * `mcpServers` container, OpenCode's `mcp`, a `streamable-http` alias for
 * `http`, a `serverUrl` instead of a `url`, a command line kept as an array,
 * `env` or `environment`, `headers` or `httpHeaders`. The editor asks the user
 * for the same connection in its own fields, so this turns any of those shapes
 * into one normalized server the fields can be filled from.
 *
 * A paste is also often not bare JSON: it arrives wrapped in a Markdown code
 * fence, or after a sentence of prose. Both are read here rather than rejected,
 * because a paste that fails on a stray backtick is a paste the user has to
 * repair by hand.
 */

/** The transports the registry can store, as the editor's field offers them. */
export type ImportedMcpTransport = McpUtilityConfig['transport']

/** One MCP server read out of pasted JSON, ready to fill the editor's fields. */
export interface ImportedMcpServer {
  /** The key the server was filed under, or a name derived from its launch. */
  name: string
  transport: ImportedMcpTransport
  command: string
  args: string[]
  url: string
  environment: Record<string, string>
  headers: Record<string, string>
  enabled: boolean
  description: string
}

/** Keys a configuration files one or more servers under, in precedence order. */
const CONTAINER_KEYS = ['mcpServers', 'mcp_servers', 'mcp', 'servers'] as const

/** Type values that mean the streamable HTTP transport. */
const HTTP_TYPES = new Set([
  'http',
  'remote',
  'streamable-http',
  'streamable_http',
  'streamablehttp'
])

/** Type values that mean the legacy SSE transport. */
const SSE_TYPES = new Set(['sse', 'legacy-sse', 'legacy_sse'])

/**
 * Every server a pasted configuration describes. Throws with a message meant
 * for a person, because the editor shows it under the paste box.
 */
export function parseMcpServerJson(raw: string): ImportedMcpServer[] {
  const document = extractJsonDocument(raw)
  if (!document) throw new Error('Paste an MCP configuration first.')
  let parsed: unknown
  try {
    parsed = JSON.parse(document)
  } catch {
    throw new Error('That is not valid JSON. Paste the whole object, including its braces.')
  }
  const servers = readServers(parsed)
  if (servers.length === 0) {
    throw new Error(
      'No MCP server in that JSON. Paste a block with "mcpServers", or one server that has a command or a URL.'
    )
  }
  return servers
}

/** The JSON document inside a paste, which may be fenced or wrapped in prose. */
export function extractJsonDocument(raw: string): string {
  const text = raw.replace(/```[a-zA-Z]*/gu, '')
  const start = text.search(/[[{]/u)
  if (start < 0) return ''
  const end = matchClosingBracket(text, start)
  return end < 0 ? text.slice(start).trim() : text.slice(start, end + 1)
}

function readServers(parsed: unknown): ImportedMcpServer[] {
  if (Array.isArray(parsed)) {
    return parsed
      .map((entry, index) => parseServer(entry, `server-${index + 1}`))
      .filter((server): server is ImportedMcpServer => server !== null)
  }
  if (!isRecord(parsed)) return []
  for (const key of CONTAINER_KEYS) {
    const container = parsed[key]
    if (!isRecord(container)) continue
    const servers = Object.entries(container)
      .map(([name, entry]) => parseServer(entry, name))
      .filter((server): server is ImportedMcpServer => server !== null)
    if (servers.length > 0) return servers
  }
  const single = parseServer(parsed, '')
  return single ? [single] : []
}

/** One server entry, or `null` when it declares no usable connection. */
function parseServer(value: unknown, key: string): ImportedMcpServer | null {
  if (!isRecord(value)) return null
  const declaredType = firstString(value['type'], value['transport']).toLowerCase()
  const url = firstString(value['url'], value['serverUrl'], value['endpoint'])
  const { command, args } = readLaunch(value)
  const transport = resolveTransport(declaredType, url, command)
  if (transport === 'stdio' ? !command : !url) return null
  const name =
    key.trim() ||
    firstString(value['name'], value['title'], value['id']) ||
    deriveName(transport === 'stdio' ? command : url)
  return {
    name: name || 'mcp-server',
    transport,
    command: transport === 'stdio' ? command : '',
    args: transport === 'stdio' ? args : [],
    url: transport === 'stdio' ? '' : url,
    environment: stringMap(value['env'] ?? value['environment']),
    headers:
      transport === 'stdio'
        ? {}
        : stringMap(
            value['headers'] ?? value['httpHeaders'] ?? value['http_headers'] ?? value['header']
          ),
    enabled: value['enabled'] !== false && value['disabled'] !== true,
    description: firstString(value['description'], value['summary'])
  }
}

/**
 * The launch line of a stdio server. Most dialects keep `command` and `args`
 * apart, but some paste a whole command line into `command` as an array, so
 * the extra words become arguments rather than a broken executable path.
 */
function readLaunch(value: Record<string, unknown>): { command: string; args: string[] } {
  const args = argumentList(value['args'])
  const rawCommand = value['command']
  if (Array.isArray(rawCommand)) {
    const [command = '', ...rest] = rawCommand
      .map((part) => scalarString(part).trim())
      .filter(Boolean)
    return { command, args: [...rest, ...args] }
  }
  return { command: scalarString(rawCommand).trim(), args }
}

function resolveTransport(
  declaredType: string,
  url: string,
  command: string
): ImportedMcpTransport {
  if (SSE_TYPES.has(declaredType)) return 'sse'
  if (HTTP_TYPES.has(declaredType)) return 'http'
  // A server with a URL and no launch line is a remote one; a config that omits
  // the type is common enough that guessing it wrong would be worse than this.
  if (url && !command) return 'http'
  return 'stdio'
}

function argumentList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => scalarString(item)).filter((item) => item !== '')
  }
  const single = scalarString(value)
  return single ? [single] : []
}

/** A key/value block such as `env` or `headers`, keeping only readable values. */
function stringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {}
  const entries: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value)) {
    const text = scalarString(raw)
    if (text && key.trim()) entries[key.trim()] = text
  }
  return entries
}

/** A name for a server the configuration never named, taken from how it runs. */
function deriveName(source: string): string {
  if (!source) return ''
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(source)) {
    try {
      return new URL(source).hostname.replace(/^www\./u, '')
    } catch {
      return ''
    }
  }
  const base = source.split(/[\\/]/u).filter(Boolean).at(-1) ?? ''
  return base.replace(/\.(?:exe|cmd|bat|mjs|cjs|js|py|sh)$/iu, '')
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const text = scalarString(value).trim()
    if (text) return text
  }
  return ''
}

function scalarString(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

/** Index of the bracket closing the one at `start`, ignoring brackets in strings. */
function matchClosingBracket(text: string, start: number): number {
  const open = text[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const character = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') {
      inString = true
      continue
    }
    if (character === open) depth += 1
    else if (character === close) {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
