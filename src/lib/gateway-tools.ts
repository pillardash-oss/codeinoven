import { APP_NAME } from './brand'
import { SCOPE_TOOL_ACTIONS, UTILITY_KIND_VALUES } from './types'

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
/** App-owned scope and Git-worktree management for the active project. */
export const SCOPE_TOOL_NAME = 'cio_scope'
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
  },
  {
    name: SCOPE_TOOL_NAME,
    description: `Create and manage ${APP_NAME} scopes and their managed Git worktrees for the active project: create an isolated worktree for a feature, list and inspect scopes, sync a worktree with the project's main branch in either direction, read and finish conflicts, repair, adopt, archive, and (with confirmation) detach or delete. Worktrees created through this tool are app-owned: they appear on the scope board with their branch, health and threads, and the calling thread can move into them. Every action resolves a target scope by id or display name, defaulting to the scope of the calling thread. Never create a worktree with raw \`git worktree add\`: this tool is the only supported route, and a raw worktree stays invisible to the app.`,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [...SCOPE_TOOL_ACTIONS],
          description:
            'Operation to perform. Read: list, status, conflicts, source_info, detect_adoptable. Write: create, rename, pin, unpin, archive, restore, adopt, repair, retry_setup, sync_from_main, sync_to_main. Destructive (confirmation required): detach_worktree, delete_scope, merge_into_project.'
        },
        scope: {
          type: 'string',
          description:
            'Scope bucket id or display name. Omit to target the scope the calling thread is in (the Default scope when it is unscoped).'
        },
        title: {
          type: 'string',
          description:
            'For create: the feature title; names the scope, its branch and its directory.'
        },
        name: { type: 'string', description: 'For rename: the new scope display name.' },
        baseBranch: {
          type: 'string',
          description:
            'For create: the project branch the worktree forks from. Omit to fork the project checkout\u2019s current branch.'
        },
        runSetup: {
          type: 'boolean',
          description:
            'For create/adopt/retry_setup: run the project setup commands in the new checkout. Defaults to the project setting.'
        },
        environmentMode: {
          type: 'string',
          enum: ['copy', 'symlink'],
          description:
            'For create: how untracked root .env files are propagated. Defaults to the project setting.'
        },
        setupCommands: {
          type: 'array',
          description:
            'For create: setup commands to run instead of the project defaults, in order. Each entry is an executable plus args (never a shell string).',
          items: {
            type: 'object',
            properties: {
              executable: { type: 'string' },
              args: { type: 'array', items: { type: 'string' } }
            },
            required: ['executable'],
            additionalProperties: false
          }
        },
        attachThread: {
          type: 'boolean',
          description:
            'For create: move the calling thread into the new scope so its next turn runs in the new worktree. Defaults to true.'
        },
        sourcePath: {
          type: 'string',
          description:
            'For detect_adoptable/adopt: absolute path of an existing Git worktree checkout to inspect or adopt.'
        },
        strategy: {
          type: 'string',
          enum: ['merge', 'rebase', 'ff-only'],
          description:
            'For sync_from_main/sync_to_main: how the branches are integrated. Defaults to the configured pull strategy, or merge when that is \u201cask\u201d.'
        },
        mode: {
          type: 'string',
          enum: ['merge-keep', 'merge-delete', 'merge-move-to-default'],
          description:
            'For merge_into_project: what happens to the source scope afterwards. merge-keep keeps the scope and branch, merge-delete deletes both, merge-move-to-default moves its threads to the Default scope.'
        },
        target: {
          type: 'string',
          description:
            'For merge_into_project: the scope to merge into. Defaults to the Default scope.'
        },
        deleteBranch: {
          type: 'boolean',
          description:
            'For delete_scope: also delete the scope\u2019s managed branch. Defaults to false, which keeps the branch.'
        },
        threads: {
          type: 'string',
          enum: ['move-to-default', 'delete'],
          description:
            'For delete_scope on a scope that still owns threads: move-to-default keeps their conversations, delete removes them with the scope. Required in that case; the call is refused without it.'
        },
        confirm: {
          type: 'boolean',
          description:
            'Destructive actions only. When omitted, the call changes nothing: it returns the preflight, what would be destroyed, and an explicit challenge to confirm. Call again with confirm true only when the user really asked for that exact action.'
        }
      },
      required: ['action'],
      additionalProperties: false
    },
    route: '/scope',
    sentWhen:
      'When work should run in an isolated checkout, when the user asks for a scope or worktree, or when a scope needs syncing, repairing or cleaning up'
  }
]

/** Map every gateway tool route to its MCP tool name. */
export const GATEWAY_ROUTES: ReadonlyMap<string, string> = new Map(
  GATEWAY_TOOLS.map(({ route, name }) => [route, name])
)
