import { UTILITY_KIND_VALUES } from './types'
import { ORCHESTRATION_TOOLS } from './orchestration-tools'
import { APP_CONTROL_TOOLS } from './app-control-tools'
import { ENGINEERING_TOOLS } from './engineering-tools'

/** Stable app-owned gateway tool names. */
export const UTILITY_SEARCH_TOOL_NAME = 'cio_util_find'
export const UTILITY_ACTIVATE_TOOL_NAME = 'cio_util_init'
export const UTILITY_INVOKE_TOOL_NAME = 'cio_util_use'
/** Explicit-setup-only operation for installing validated utility definitions. */
export const UTILITY_MANAGE_TOOL_NAME = 'cio_util_manage'
/**
 * Always-available, read-only app diagnostics for debugging user-reported issues.
 * This is an app capability rather than a utility operation, so the gateway
 * grants its route on every turn: a user reporting a problem never has to
 * re-send their message with a tag before the agent can look at the thread or
 * the log they named.
 */
export const UTILITY_DIAGNOSTICS_TOOL_NAME = 'cio_util_diagnose'
/**
 * Proposes a capability the agent found for the user to install. Always
 * available, so an agent that discovers a needed connection can offer it
 * instead of dead-ending on a harness-native suggestion the app cannot render.
 */
export const UTILITY_SUGGEST_TOOL_NAME = 'cio_util_suggest'
/** Post-compaction capability re-dump: re-lists one utility's full docs by id. */
export const UTILITY_DOCS_TOOL_NAME = 'cio_util_docs_lookup'
/**
 * Asks the user for secret values (API keys, tokens, passwords) and hands the
 * agent only the names it interpolates them under. One app tool for every
 * harness: the value goes to the encrypted vault, and the model never sees it.
 */
export const ASK_SECRET_TOOL_NAME = 'cio_ask_secret'

/** Optional app APIs remain callable through the core invocation tool. */
export const GATEWAY_CAPABILITY_ID = 'cio:gateway'
export const CORE_GATEWAY_TOOL_NAMES: ReadonlySet<string> = new Set([
  UTILITY_SEARCH_TOOL_NAME,
  UTILITY_ACTIVATE_TOOL_NAME,
  UTILITY_INVOKE_TOOL_NAME,
  UTILITY_DOCS_TOOL_NAME,
  ASK_SECRET_TOOL_NAME,
  UTILITY_DIAGNOSTICS_TOOL_NAME
])
export const GATEWAY_DISCOVERY_INSTRUCTION =
  'Optional app, workstation, engineering and utility-setup tools are available through the built-in cio:gateway capability, already active. Use cio_util_use with utility_id "cio:gateway", operation "catalog", and input {names:["tool_name"]} to load only the needed schemas, or input {} for a compact index. Then operation "call" with input {tool:"tool_name",arguments:{...}} executes it with the original permissions. Operation "batch" accepts input {calls:[{tool,arguments}]} for up to eight independent read-only calls. Inspect every result; dependent calls, mutations and approvals remain sequential. Do not call optional tool names directly or use shell gateway requests.'

export function initialGatewayTools(
  tools: readonly GatewayToolDefinition[]
): GatewayToolDefinition[] {
  return tools.filter(({ name }) => CORE_GATEWAY_TOOL_NAMES.has(name))
}

/** Model-facing summaries; complete schemas and route policy remain unchanged. */
const MODEL_TOOL_DESCRIPTIONS: Readonly<Record<string, string>> = {
  cio_orchestrate_targets:
    'Read exact Oven, harness, provider, model, profile and account ids plus defaults before dispatch. Use filters to avoid unused catalogs.',
  cio_orchestrate_dispatch:
    'Start a real project thread on the chosen Oven. Use ids from cio_orchestrate_targets, resolve missing required choices with the question tool, and report acceptance, not completion. Results arrive asynchronously.',
  cio_orchestrate_status: 'Read a previously dispatched thread status and latest result by id.',
  cio_app_catalog:
    'Read exact app IPC channels, argument order, UI actions and current context before cio_app_call. Filter by domain.',
  cio_app_call:
    'Invoke one catalog-listed IPC channel or UI action. Prefer background data operations. Destructive actions require user confirmation before destructiveConfirmed:true.',
  cio_create_brainstorm:
    'Create a durable Brainstorm draft from this conversation and optional constraints for review.',
  cio_create_prd: 'Create a PRD draft from the finalized Brainstorm or conversation for review.',
  cio_create_spec:
    'Create an implementation-ready engineering specification draft for review. Does not approve or implement it.',
  cio_create_assignment:
    'Draft independently promptable worker tasks for user review and model selection. Nothing runs until sign-off. If preference is unknown, ask whether the user wants promptable Assignment workers or inline sub-agents.',
  cio_util_find:
    'Find app-managed capabilities by task or name. Evaluate candidates semantically. Only notFound:true proves absence. Known eligible ids may be activated directly.',
  cio_util_init:
    'Activate an installed utility and read its operations. Registration persists in this thread; later turns can invoke its id directly.',
  cio_util_use: 'Invoke an operation on an activated or banked utility by id.',
  cio_util_docs_lookup:
    'Retrieve full documentation for a registered utility when it has left context.',
  cio_ask_secret:
    'Collect all missing credentials together through the encrypted vault. Values never enter chat. Use returned environment names or secret paths without printing values; bind utility_id when applicable. An alternative answer reuses held values, so do not repeat an answered request.',
  cio_util_manage:
    'Install or update a secret-free utility bundle only during explicit utility setup. Each entry wraps definition with kind inside it. Collect credentials afterward with cio_ask_secret.',
  cio_util_diagnose:
    'Read-only app diagnostics: find threads, read bounded messages or redacted logs, inspect schema, or run bounded SELECT queries. Use for reported app problems. Never changes data.',
  cio_util_suggest:
    'Offer a validated, secret-free capability bundle for user installation. Include real MCP transport configuration. Claim connection only after accepted; collect credentials afterward with cio_ask_secret. Handle declined, alternative, invalid and failed results honestly.'
}

export function gatewayToolForModel(tool: GatewayToolDefinition): GatewayToolDefinition {
  return { ...tool, description: MODEL_TOOL_DESCRIPTIONS[tool.name] ?? tool.description }
}

/** One tool the utility gateway MCP exposes to agents. */
export interface GatewayToolDefinition {
  /** MCP tool name the agent calls via `tools/call`. */
  name: string
  /** Description shown to agents and in the renderer tool catalog. */
  description: string
  /** JSON schema accepted by the tool call. */
  inputSchema: Record<string, unknown>
  /**
   * JSON schema of the tool's structured result, for the tools that have one.
   *
   * A harness that runs scripts resolves a tool carrying this schema to the
   * result's `structuredContent` rather than to its flattened text, so a script
   * reads real fields   a snapshot's element tokens, a search's candidates,
   * an activation's operations   instead of a JSON string it has to parse. The
   * gateway therefore answers such a call with the payload both ways: content
   * parts for a model to read, and the same payload as data for a script.
   *
   * Left off where a result is prose, and deliberately left off
   * `cio_ask_secret`: its collected values travel as a top-level `environment`
   * map that the in-process transport applies to the session and never shows,
   * and a structured payload is one more place a secret must not appear.
   */
  outputSchema?: Record<string, unknown>
  /** HTTP bridge route handled by the main-process gateway server. */
  route: string
  /** When the tool is relevant, surfaced in the renderer tool catalog. */
  sentWhen: string
}

/**
 * The structured result of a gateway operation: whatever the utility answered
 * with. Deliberately permissive and identical for every operation that declares
 * one, because the gateway must never refuse or reshape a result a utility
 * produced, and a script decides what to read from it.
 */
const GATEWAY_OPERATION_RESULT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: true
}

/**
 * Canonical catalog of every tool the utility gateway MCP advertises. The
 * gateway script (tools/list + tools/call routing), the main-process bridge
 * dispatch, and `APPLICATION_AGENT_TOOLS` are all derived from this one array,
 * so a tool added here appears everywhere and a tool removed disappears
 * everywhere   no surface can silently drift out of sync again.
 */
/**
 * The bundle schema shared by every tool that accepts one.
 *
 * Deliberately descriptive rather than enforcing: the nested properties teach
 * the caller the exact shape, while the missing `required` and the
 * `additionalProperties` leave a near-miss (an entry named `entries`, or the
 * utility fields flat on the entry) to the gateway's tolerant parser. A harness
 * that validates strictly would otherwise reject the call with a generic error
 * and hide the precise, shape-quoting message the gateway returns, which is what
 * let an agent guess three times and give up.
 */
const UTILITY_BUNDLE_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  description:
    'A name plus one entry per utility. Each entry is {"definition":{...}}; the ' +
    'definition carries "kind" plus the utility fields.',
  properties: {
    name: { type: 'string', description: 'Human-readable bundle name.' },
    utilities: {
      type: 'array',
      minItems: 1,
      maxItems: 20,
      description: 'One entry per utility. Each entry wraps its utility in a "definition" object.',
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

export const GATEWAY_TOOLS: GatewayToolDefinition[] = [
  ...ORCHESTRATION_TOOLS,
  ...APP_CONTROL_TOOLS,
  ...ENGINEERING_TOOLS,
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
    outputSchema: GATEWAY_OPERATION_RESULT_SCHEMA,
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
    outputSchema: GATEWAY_OPERATION_RESULT_SCHEMA,
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
    outputSchema: GATEWAY_OPERATION_RESULT_SCHEMA,
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
    outputSchema: GATEWAY_OPERATION_RESULT_SCHEMA,
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
        bundle: UTILITY_BUNDLE_INPUT_SCHEMA
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
      'Read-only CodeInOven app diagnostics for debugging: look up any thread by id or exact title across projects, read a bounded page of its mirrored conversation, read recent app log entries (logs/<YYYY-MM-DD>/main.jsonl, error.log, permission-events.jsonl), inspect the app SQLite schema, and run read-only SELECT statements when the structured actions cannot answer the question. All output is redacted and bounded. Available on every turn that carries the gateway, so use it whenever the user reports a problem with the app, a thread, an assistant, or a log line instead of asking them to re-send the request with @cio-utility. Never write, delete, or configure anything with it.',
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
            'For read_log: main.jsonl, error.log, or permission-events.jsonl for the current day, or a day-qualified path such as logs/2026-09-23/error.log. Logs are split into one folder per local day.'
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
    sentWhen:
      'Whenever the user reports a problem with the app, a thread, an assistant, or a log line and the evidence lives in app data'
  },
  {
    name: UTILITY_SUGGEST_TOOL_NAME,
    description:
      'Propose a capability you found for the user to install: a skill, an MCP server, or a plugin bundle of both. The app surfaces it as an actionable card and installs it through CodeInOven Utilities on every harness only when the user accepts. The card lists every utility in the bundle, so send the real definition (an MCP entry needs config.transport plus config.url or config.command), never a placeholder. The app validates the bundle the same way the install does: an invalid bundle is rejected without asking the user, so fix the definition and call again. Use this instead of telling the user a found capability is connected: never say it is installed, available, or connected before this tool returns "accepted". The bundle must be secret-free: install the definition, then collect any credential with ' +
      ASK_SECRET_TOOL_NAME +
      ', passing the installed id as utility_id. The result reports "accepted" with the installed ids, "declined", "alternative" when the user answered in their own words, or "invalid"/"failed" with the reason to correct.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description:
            'One or two plain sentences telling the user why this capability is needed and what it enables. Shown on the card, so write it for the user, not for yourself.'
        },
        bundle: UTILITY_BUNDLE_INPUT_SCHEMA
      },
      required: ['reason', 'bundle'],
      additionalProperties: false
    },
    route: '/suggest-utility',
    sentWhen: 'After a search finds a capability the user does not have and the task needs it'
  }
]
