import { UTILITY_KIND_VALUES } from './types'

/** Stable app-owned gateway tool names. */
export const UTILITY_SEARCH_TOOL_NAME = 'cio_util_find'
export const UTILITY_ACTIVATE_TOOL_NAME = 'cio_util_init'
export const UTILITY_INVOKE_TOOL_NAME = 'cio_util_use'
/** Explicit-setup-only operation for installing validated utility definitions. */
export const UTILITY_MANAGE_TOOL_NAME = 'cio_util_manage'
/** Explicit-turn-only, read-only app diagnostics for debugging user-reported issues. */
export const UTILITY_DIAGNOSTICS_TOOL_NAME = 'cio_util_diagnose'
/** Post-compaction capability re-dump: re-lists one utility's full docs by id. */
export const UTILITY_DOCS_TOOL_NAME = 'cio_util_docs_lookup'
/**
 * Asks the user for secret values (API keys, tokens, passwords) and hands the
 * agent only the names it interpolates them under. One app tool for every
 * harness: the value goes to the encrypted vault, and the model never sees it.
 */
export const ASK_SECRET_TOOL_NAME = 'cio_ask_secret'

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
 * everywhere   no surface can silently drift out of sync again.
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
      "Activate one installed utility for the current turn and inspect the operations it exposes. The first activation registers the utility in this thread's utilities bank; later turns can invoke it directly by id without re-activating.",
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
    description:
      'Invoke an operation on an app utility — activated this turn, or already registered in the thread utilities bank (invoke directly by id; no re-activation needed).',
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
    name: UTILITY_DOCS_TOOL_NAME,
    description:
      "Re-list one utility's full capability documentation (tool schemas, operations, or skill instructions) by its id. Use after context compaction, when an earlier activation result is no longer in your context. Accepts only the utility id; the utility must be available to this turn.",
    inputSchema: {
      type: 'object',
      properties: {
        utility_id: {
          type: 'string',
          description: 'Utility identifier, e.g. from the thread utilities bank.'
        }
      },
      required: ['utility_id'],
      additionalProperties: false
    },
    route: '/docs-lookup',
    sentWhen: "After compaction, when a known utility's capability docs are no longer in context"
  },
  {
    name: ASK_SECRET_TOOL_NAME,
    description:
      'Ask the user for secret values you do not have   an API key, token, password, or any credential a task needs   without the value ever entering this conversation. Each value is stored in the encrypted device vault, and is then available to you in three ways: bind it to an installed capability by passing utility_id (the server receives it as environment_variable when it launches), read it in a shell command as $environment_variable, or interpolate its 0600 file as "$(cat secret_path)". The result contains names and paths only, never the value: never print, echo, log, or read a secret, and never paste one into chat. Use it the moment a task or a capability you just installed needs a credential, and ask for every secret you need in one call. A user may answer with an instruction instead of a value, for example a value they already supplied somewhere else: the app then reuses whatever it already holds for the names you asked for, reports the rest as unresolved, and passes their instruction back, so never ask again for a request the user has already answered.',
    inputSchema: {
      type: 'object',
      properties: {
        secrets: {
          type: 'array',
          minItems: 1,
          maxItems: 5,
          description: 'Secrets to collect from the user, in the order they should be filled.',
          items: {
            type: 'object',
            properties: {
              title: {
                type: 'string',
                description: 'Short human label for the value, e.g. "Authorization Key".'
              },
              description: {
                type: 'string',
                description:
                  'One line on what the value is and, when it exists, a link to where the user obtains it.'
              },
              environment_variable: {
                type: 'string',
                description:
                  'Environment variable name the target expects (an MCP server variable, a CLI flag value). Omit to receive a derived CIO_ name.'
              },
              utility_id: {
                type: 'string',
                description:
                  'Installed utility id to bind this value to as its credential, exactly as the Utilities page stores it.'
              }
            },
            required: ['title'],
            additionalProperties: false
          }
        }
      },
      required: ['secrets'],
      additionalProperties: false
    },
    route: '/ask-secret',
    sentWhen:
      'Whenever a task or a capability needs a secret you do not have; always when installing a capability that needs a credential'
  },
  {
    name: UTILITY_MANAGE_TOOL_NAME,
    description:
      'Install a secret-free skill, MCP server, or plugin bundle in CodeInOven. The bundle is ' +
      '{"name":"...","utilities":[{"definition":{"kind":"skill"|"mcp",...}}]}: every entry wraps its ' +
      'utility in a "definition" object, and "kind" sits inside that definition, never on the entry. ' +
      'When a capability needs an API key or token, never put the value in the bundle: collect it with ' +
      ASK_SECRET_TOOL_NAME +
      ' after installing, passing the installed id as utility_id and the variable the server expects as environment_variable, and the app stores it in the encrypted vault exactly as the Utilities page would. Reinstalling an existing capability updates that entry in place and reports it as "updated", removing extra copies of it, so never install a second copy to work around one that already exists. This capability is available only when the user explicitly starts utility setup with @cio-utility or Setup with agent. Credential values are forbidden in the bundle itself; if ' +
      ASK_SECRET_TOOL_NAME +
      ' is unavailable, tell the user to add them through Utilities after installation.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['install_bundle'] },
        // Deliberately descriptive rather than enforcing: the nested properties
        // teach the caller the exact shape, while the missing `required` and the
        // `additionalProperties` leave a near-miss (an entry named `entries`, or
        // the utility fields flat on the entry) to the gateway's tolerant parser.
        // A harness that validates strictly would otherwise reject the call with
        // a generic error and hide the precise, shape-quoting message the gateway
        // returns, which is what let an agent guess three times and give up.
        bundle: {
          type: 'object',
          description:
            'The bundle to install: a name plus one entry per utility. Each entry is ' +
            '{"definition":{...}}; the definition carries "kind" plus the utility fields.',
          properties: {
            name: { type: 'string', description: 'Human-readable bundle name.' },
            utilities: {
              type: 'array',
              minItems: 1,
              maxItems: 20,
              description:
                'One entry per utility. Each entry wraps its utility in a "definition" object.',
              items: {
                type: 'object',
                description: 'A single entry: {"definition":{"kind":"skill"|"mcp",...}}.',
                properties: {
                  definition: {
                    type: 'object',
                    description:
                      'The utility itself. "kind" must be "skill" or "mcp"; an MCP server also ' +
                      'needs config.transport and config.url (or config.command for stdio).',
                    properties: {
                      kind: { type: 'string', enum: ['skill', 'mcp'] },
                      name: { type: 'string', description: 'Utility name.' },
                      description: { type: 'string' },
                      enabled: { type: 'boolean' },
                      activation: { type: 'string', enum: ['on_demand', 'always'] },
                      scope: { type: 'object' },
                      credentials: { type: 'array', maxItems: 0 },
                      harnessBindings: { type: 'array' },
                      config: { type: 'object' }
                    },
                    required: ['kind', 'name'],
                    additionalProperties: true
                  }
                },
                additionalProperties: true
              }
            }
          },
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
      'Read-only CodeInOven app diagnostics for debugging: look up any thread by id or exact title across projects, read a bounded page of its mirrored conversation, read recent app log entries (main.jsonl, error.log, permission-events.jsonl), inspect the app SQLite schema, and run read-only SELECT statements when the structured actions cannot answer the question. All output is redacted and bounded. Available only during an explicit @cio-utility turn. Never write, delete, or configure anything with it.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'lookup_thread',
            'search_threads',
            'read_messages',
            'read_log',
            'list_schema',
            'query_sql'
          ],
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
          description:
            'Optional cap; read_messages returns at most 120 messages, read_log at most 200 entries.'
        },
        level: {
          type: 'string',
          description: 'For read_log: optional level filter (dev, info, error).'
        },
        file: {
          type: 'string',
          description:
            'For read_log: one of logs/main.jsonl, logs/error.log, logs/permission-events.jsonl.'
        },
        table: {
          type: 'string',
          description:
            'For list_schema: optional table name (exact or substring) to limit the schema report to.'
        },
        sql: {
          type: 'string',
          description:
            'For query_sql: one read-only SELECT (or WITH ... SELECT, EXPLAIN, or a schema PRAGMA such as table_info). Statements are executed with a hard row cap and are rejected if SQLite classifies them as writers.'
        },
        params: {
          type: 'array',
          items: { type: ['string', 'number', 'boolean', 'null'] },
          description:
            'For query_sql: optional positional bind values (string, number, boolean, or null) for ? placeholders.'
        }
      },
      required: ['action'],
      additionalProperties: false
    },
    route: '/diagnostics',
    sentWhen: 'Only an explicit @cio-utility debugging turn'
  }
]
