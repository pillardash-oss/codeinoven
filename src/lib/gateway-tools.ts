import { UTILITY_KIND_VALUES } from './types'

/** Stable app-owned gateway tool names. */
export const UTILITY_SEARCH_TOOL_NAME = 'cio_util_find'
export const UTILITY_ACTIVATE_TOOL_NAME = 'cio_util_init'
export const UTILITY_INVOKE_TOOL_NAME = 'cio_util_use'
/** Explicit-setup-only operation for installing validated utility definitions. */
export const UTILITY_MANAGE_TOOL_NAME = 'cio_util_manage'
/** Explicit-turn-only, read-only app diagnostics for debugging user-reported issues. */
export const UTILITY_DIAGNOSTICS_TOOL_NAME = 'cio_util_diagnose'
/** Shell-callable, turn-bound host recovery tool; intentionally never transported through MCP. */
export const RETRIEVE_MCP_HOST_TOOL_NAME = 'retrieve_mcp_host'

/** One tool the utility gateway MCP exposes to agents. */
export interface GatewayToolDefinition {
  /** MCP tool name the agent calls via `tools/call`. */
  name: string
  /** Description shown to agents and in the renderer tool catalog. */
  description: string
  /** JSON schema accepted by the tool call. */
  inputSchema: Record<string, unknown>
  /** HTTP bridge route handled by the main-process gateway server. */
  route: string
  /** When the tool is relevant, surfaced in the renderer tool catalog. */
  sentWhen: string
}

/**
 * Canonical catalog of every tool the utility gateway MCP advertises. The
 * gateway script (tools/list + tools/call routing), the main-process bridge
 * dispatch, and `APPLICATION_AGENT_TOOLS` are all derived from this one array,
 * so a tool added here appears everywhere and a tool removed disappears
 * everywhere — no surface can silently drift out of sync again.
 */
export const GATEWAY_TOOLS: GatewayToolDefinition[] = [
  {
    name: UTILITY_SEARCH_TOOL_NAME,
    description:
      'Search app-managed MCP servers, skills, utilities, web services, and computer-use capabilities by capability name or natural-language task intent. If no direct lexical match exists, the result returns project-aware candidates for you to evaluate semantically. If you already know an eligible utility, you may activate it directly. Only conclude a capability does not exist after a search where `notFound` is true.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Capability or task to search for.' },
        kinds: {
          type: 'array',
          items: { type: 'string', enum: [...UTILITY_KIND_VALUES] }
        },
        limit: { type: 'number', minimum: 1, maximum: 20 }
      },
      additionalProperties: false
    },
    route: '/search',
    sentWhen: 'Every agent turn; search when a needed skill or MCP is not directly available'
  },
  {
    name: UTILITY_ACTIVATE_TOOL_NAME,
    description:
      'Activate one installed utility for the current turn and inspect the operations it exposes.',
    inputSchema: {
      type: 'object',
      properties: {
        utility_id: { type: 'string', description: 'Installed utility identifier.' }
      },
      required: ['utility_id'],
      additionalProperties: false
    },
    route: '/activate',
    sentWhen: 'After utility_search selects an installed capability'
  },
  {
    name: UTILITY_INVOKE_TOOL_NAME,
    description: 'Invoke an operation on a utility activated for the current turn.',
    inputSchema: {
      type: 'object',
      properties: {
        utility_id: { type: 'string' },
        operation: { type: 'string' },
        input: { type: 'object', additionalProperties: true }
      },
      required: ['utility_id', 'operation'],
      additionalProperties: false
    },
    route: '/invoke',
    sentWhen: 'After a utility has been activated for the current turn'
  },
  {
    name: UTILITY_MANAGE_TOOL_NAME,
    description:
      'Install a secret-free skill, MCP server, or plugin bundle in CodeInOven. This capability is available only when the user explicitly starts utility setup with @cio-utility or Setup with agent. Credential values are forbidden; tell the user to add them through Utilities after installation.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['install_bundle'] },
        bundle: {
          type: 'object',
          description:
            'A UtilityBundleInstallRequest-shaped object with name and one or more secret-free definition entries.',
          additionalProperties: true
        }
      },
      required: ['action', 'bundle'],
      additionalProperties: false
    },
    route: '/manage',
    sentWhen: 'Only an explicit @cio-utility or Setup with agent turn'
  },
  {
    name: UTILITY_DIAGNOSTICS_TOOL_NAME,
    description:
      'Read-only CodeInOven app diagnostics for debugging: look up any thread by id or exact title across projects, read a bounded page of its mirrored conversation, and read recent app log entries (main.jsonl, error.log, permission-events.jsonl). All output is redacted and bounded. Available only during an explicit @cio-utility turn. Never write, delete, or configure anything with it.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['lookup_thread', 'search_threads', 'read_messages', 'read_log'],
          description: 'Diagnostic operation to perform.'
        },
        query: {
          type: 'string',
          description:
            'For lookup_thread: thread id or exact thread title. For search_threads: title substring.'
        },
        thread_id: { type: 'string', description: 'For read_messages: the thread id to inspect.' },
        limit: {
          type: 'number',
          description: 'Optional cap; read_messages returns at most 120 messages, read_log at most 200 entries.'
        },
        level: {
          type: 'string',
          description: 'For read_log: optional level filter (dev, info, error).'
        },
        file: {
          type: 'string',
          description:
            'For read_log: one of logs/main.jsonl, logs/error.log, logs/permission-events.jsonl.'
        }
      },
      required: ['action'],
      additionalProperties: false
    },
    route: '/diagnostics',
    sentWhen: 'Only an explicit @cio-utility debugging turn'
  }
]

/** Map every gateway tool route to its MCP tool name. */
export const GATEWAY_ROUTES: ReadonlyMap<string, string> = new Map(
  GATEWAY_TOOLS.map(({ route, name }) => [route, name])
)
