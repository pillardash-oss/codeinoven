import { UTILITY_KIND_VALUES } from './types'
import { ORCHESTRATION_TOOLS } from './orchestration-tools'
import { DON_TOOLS } from './don-tools'
import { APP_CONTROL_TOOLS } from './app-control-tools'
import { ENGINEERING_TOOLS } from './engineering-tools'
import { EXT_SIMULATION_TOOLS } from './simulation-tools'
import { PAWN_TOOLS } from './pawn-tools'

/** Stable app-owned gateway tool names. */
export const UTILITY_SEARCH_TOOL_NAME = 'cio_util_find'
export const UTILITY_ACTIVATE_TOOL_NAME = 'cio_util_init'
export const UTILITY_INVOKE_TOOL_NAME = 'cio_util_use'
/** Most items one `cio_util_use` call may carry in `inputs`. */
export const UTILITY_INVOKE_BATCH_LIMIT = 32
/** Items of one `inputs` batch in flight at once. */
export const UTILITY_INVOKE_BATCH_CONCURRENCY = 4
/** Most utilities one `cio_util_init` call may activate in `inputs`. */
export const UTILITY_ACTIVATE_BATCH_LIMIT = 8
/** Activations of one `inputs` batch in flight at once. */
export const UTILITY_ACTIVATE_BATCH_CONCURRENCY = 2
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
/**
 * Gateway route an in-process transport (Pi) calls at the start of every agent
 * run to apply the project's ENV and the thread's secrets to its own session.
 * It is not a model tool: the turn token alone authorizes it, and its values
 * never reach a tool result.
 */
export const SESSION_ENVIRONMENT_ROUTE = '/session-environment'
/**
 * The process handle an agent gets for what it starts.
 *
 * Process lifecycle belongs to the app, not to a shell command: a shell kill
 * cannot prove it started its target, so it is refused in every form (see
 * `unmanagedProcessKillReason`). That refusal used to point at the task-manager
 * channels, which an ordinary thread cannot reach, leaving an agent that started
 * a dev server or a probe instance with no way to stop it. These three tools are
 * the sanctioned path instead, granted on every turn that carries the gateway:
 * the app starts the process and records its pid, lists what this thread owns,
 * and stops one of those pids after re-verifying ownership in main.
 */
export const PROCESS_LIST_TOOL_NAME = 'cio_process_list'
export const PROCESS_START_TOOL_NAME = 'cio_process_start'
export const PROCESS_STOP_TOOL_NAME = 'cio_process_stop'
/** The app-owned process tools, granted together on every gateway turn. */
export const PROCESS_TOOL_NAMES: ReadonlySet<string> = new Set([
  PROCESS_LIST_TOOL_NAME,
  PROCESS_START_TOOL_NAME,
  PROCESS_STOP_TOOL_NAME
])

/** Optional app APIs remain callable through the core invocation tool. */
export const GATEWAY_CAPABILITY_ID = 'cio:gateway'
export const CORE_GATEWAY_TOOL_NAMES: ReadonlySet<string> = new Set([
  UTILITY_SEARCH_TOOL_NAME,
  UTILITY_ACTIVATE_TOOL_NAME,
  UTILITY_INVOKE_TOOL_NAME,
  UTILITY_DOCS_TOOL_NAME,
  ASK_SECRET_TOOL_NAME,
  UTILITY_DIAGNOSTICS_TOOL_NAME,
  PROCESS_LIST_TOOL_NAME,
  PROCESS_START_TOOL_NAME,
  PROCESS_STOP_TOOL_NAME
])
export const GATEWAY_DISCOVERY_INSTRUCTION =
  'Optional app, workstation, engineering and utility-setup tools are available through the built-in cio:gateway capability, already active. Use cio_util_use with utility_id "cio:gateway", operation "catalog", and input {names:["tool_name"]} to load only the needed schemas, or input {} for a compact index. Then operation "call" with input {tool:"tool_name",arguments:{...}} executes it with the original permissions. Operation "batch" takes input {calls:[...]} with up to eight entries in one round trip: {tool,arguments} for any gateway tool, or {utility_id,operation,input} for an activated or banked utility. Entries settle in your order, so an activation can precede the call that needs it, and a permission-gated call still raises its own card. Do not call optional tool names directly or use shell gateway requests.'

/**
 * The round-trip contract for one harness's tool surface.
 *
 * Every model call re-reads the whole conversation, so the cost of a turn is
 * its request count as much as its context size. A harness with a script
 * runner batches inside one script; a harness without one batches in the
 * tools it does have, because a rule that names a tool the session does not
 * have is ignored and each per-item call is billed in full.
 */
export function gatewayBatchingInstruction(codeMode: boolean): string {
  const contract = [
    'Round-trip contract: batch, always. Every model call re-reads the whole conversation, so a burst of one call per item is a failure of this contract, not a slower path.',
    codeMode
      ? `This harness has a script runner (pi: codemode, OpenCode 2.x: Code Mode), and it is the one surface that reaches every tool you have. Cover a list in ONE script that loops over the inputs with bounded concurrency and returns only the findings, activating what it needs first when the script is what invokes it. Anything that has to travel as a single call goes into one gateway \`batch\`: it carries gateway tools and the operations of utilities you activated, so one call answers a whole list. Never issue a separate call for each item.`
      : `This harness has no script runner, so batch in the tools it does have: issue every independent call you can in ONE assistant message (several tool calls per message are allowed), cover a local list in ONE shell command (a for loop, xargs, or one search command that matches several patterns at once), run one utility operation over many items with a single ${UTILITY_INVOKE_TOOL_NAME} call carrying \`inputs\`, activate several capabilities at once with ONE ${UTILITY_ACTIVATE_TOOL_NAME} call carrying \`inputs\`, and put anything that has to be a single call into one gateway \`batch\`, which carries gateway tools and activated-utility operations together. Never issue a separate call for each item.`,
    'A batch is one round trip, not a race: the gateway settles a batch entry in the order you listed them, so an activation can precede the call that needs it, and a permission-gated call still raises its own card. Inspect every result, and filter large results before returning them to the model.'
  ]
  return contract.join(' ')
}

/** One utility invocation per item is the most expensive shape a turn can take. */
export function gatewayPerItemInstruction(codeMode: boolean): string {
  return codeMode
    ? 'One utility invocation per item is the most expensive shape a turn can take: when the same inspect-only operation must run for many inputs (a validator over every changed file, a documentation read for several topics, the same lookup for several ids), loop over the inputs inside ONE script with bounded concurrency and return only the findings, never one invocation per item. Everything the harness exposes, MCP and gateway tools included, is reachable from that script, and one gateway `batch` carries the same work when a single call is what you need.'
    : `One utility invocation per item is the most expensive shape a turn can take: when the same inspect-only operation must run for many inputs (a validator over every changed file, a documentation read for several topics), make ONE ${UTILITY_INVOKE_TOOL_NAME} call with \`inputs\` set to the list (up to ${UTILITY_INVOKE_BATCH_LIMIT} per call), put the independent tool calls in one assistant message, use one gateway \`batch\` for the app tools and activated-utility operations you need, or drive local work from ONE shell command. Never invoke a utility once per item, and never call the gateway through the shell.`
}

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
  cio_orchestrate_status:
    'Read a previously dispatched thread status, current settings and latest result. Omit threadId to list every thread this conversation dispatched.',
  cio_orchestrate_continue:
    'Send a follow-up to an existing dispatched thread and/or change its harness, model, thinking level, account, permission tier or Oven in place. Never start a new thread to add to existing work.',
  cio_app_catalog:
    'Read exact app IPC channels, argument order, UI actions and current context before cio_app_call. Filter by domain.',
  cio_app_call:
    'Invoke one catalog-listed IPC channel or UI action, or pass capture:true to see the live app window as an image. Prefer background data operations. Destructive actions require user confirmation before destructiveConfirmed:true.',
  cio_create_brainstorm:
    'Create a durable Brainstorm draft for review, only when the user explicitly asks to brainstorm or explore an idea.',
  cio_create_prd:
    'Create a PRD draft for review, only when the user explicitly asks for a PRD or product requirements.',
  cio_create_spec:
    'Create an engineering specification draft for review, only when the user explicitly asks for a spec or a specification. A plan is not a spec. Does not approve or implement it.',
  cio_create_assignment:
    'Draft independently promptable worker tasks, only when the user explicitly asks to split work across workers, tasks or agents. Answers at once: an existing draft is returned, otherwise the graph is formulated in the background and the thread shows it in progress, so never wait or re-request. Pass plan to author the graph yourself (mode "append" adds more across calls) and the app then generates none. Nothing runs until sign-off. If preference is unknown, ask whether the user wants promptable Assignment workers or inline sub-agents.',
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
    'Read-only app diagnostics: search every thread by keyword and by meaning for context, find threads, read bounded messages or redacted logs, inspect schema, or run bounded SELECT queries. Never changes data.',
  cio_process_list:
    'List the processes this thread owns with their pids, commands, working directories and ports. Read it before stopping anything and to answer "is it still running?".',
  cio_process_start:
    'Start a long-running command as an app-owned process and get its pid, so it outlives the tool call and can be stopped later. Use it for a dev server, a probe instance or a watcher instead of backgrounding one in the shell.',
  cio_process_stop:
    'Stop one process this thread owns by pid. The app re-verifies ownership, so another project\u2019s server or the user\u2019s own process is refused. Never stop a process from a shell command.',
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
  ...DON_TOOLS,
  ...APP_CONTROL_TOOLS,
  ...EXT_SIMULATION_TOOLS,
  ...ENGINEERING_TOOLS,
  ...PAWN_TOOLS,
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
      "Activate an installed utility for the current turn and inspect the operations it exposes. The first activation registers the utility in this thread's utilities bank; later turns can invoke it directly by id without re-activating. Pass `inputs` to activate several capabilities in one round trip: each entry is {utility_id} (optionally with force), and the call returns one {ok, result | error} entry per utility, in order.",
    inputSchema: {
      type: 'object',
      properties: {
        utility_id: { type: 'string', description: 'Installed utility identifier.' },
        force: {
          type: 'boolean',
          description:
            'Re-activate an already active utility and return its authorization payload again. Use it only when the earlier one is gone from context.'
        },
        inputs: {
          type: 'array',
          description:
            'One entry per utility to activate in this call, each {"utility_id":"..."} with optional force.',
          items: {
            type: 'object',
            properties: {
              utility_id: { type: 'string' },
              force: { type: 'boolean' }
            },
            required: ['utility_id'],
            additionalProperties: false
          },
          maxItems: UTILITY_ACTIVATE_BATCH_LIMIT
        }
      },
      additionalProperties: false
    },
    outputSchema: GATEWAY_OPERATION_RESULT_SCHEMA,
    route: '/activate',
    sentWhen: 'After utility_search selects an installed capability'
  },
  {
    name: UTILITY_INVOKE_TOOL_NAME,
    description:
      'Invoke an operation on an app utility — activated this turn, or already registered in the thread utilities bank (invoke directly by id; no re-activation needed). To run the same inspect-only operation over many items (a validator over every changed file, several lookups), pass `inputs` instead of `input`: one call runs them with bounded concurrency and returns one {ok, result | error} entry per item, in order.',
    inputSchema: {
      type: 'object',
      properties: {
        utility_id: { type: 'string' },
        operation: { type: 'string' },
        input: { type: 'object', additionalProperties: true },
        inputs: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
          maxItems: UTILITY_INVOKE_BATCH_LIMIT
        }
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
      "Read-only CodeInOven app diagnostics: search every project's threads for context by keyword and by meaning (search_threads includes matching passages for content hits), look up any thread by id or exact title across projects, read a bounded page of its mirrored conversation, list the projects, scopes and assistants a search can be narrowed to, read recent app log entries (logs/<YYYY-MM-DD>/main.jsonl, error.log, permission-events.jsonl), inspect the app SQLite schema, and run read-only SELECT statements when the structured actions cannot answer the question. All output is redacted and bounded. Available on every turn that carries the gateway, so use it whenever the user reports a problem with the app, a thread, an assistant, or a log line instead of asking them to re-send the request with @cio-utility. Never write, delete, or configure anything with it.",
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'lookup_thread',
            'search_threads',
            'list_groups',
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
            'For lookup_thread: thread id or exact thread title. For search_threads: what the conversation was about, in words; it ranks titles and content, including by meaning.'
        },
        thread_id: { type: 'string', description: 'For read_messages: the thread id to inspect.' },
        project_id: {
          type: 'string',
          description:
            'For search_threads: narrow to one project (an id from list_groups), or to the hidden inbox ("inbox"), assistant space ("assistant"), or browser container. For list_groups: show only that project.'
        },
        scope_id: {
          type: 'string',
          description:
            'For search_threads: narrow to one scope bucket (sidebar group) inside the searched project, as listed by list_groups.'
        },
        assistant_id: {
          type: 'string',
          description:
            'For search_threads: narrow to the threads one assistant scheduled, as listed by list_groups. Narrows any family, and never needs family "assistant".'
        },
        family: {
          type: 'string',
          enum: ['projects', 'chats', 'assistant'],
          description:
            'For search_threads: which thread family to search. projects covers engineering project threads, chats the standalone inbox conversations, assistant the assistant space.'
        },
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
  },
  {
    name: PROCESS_LIST_TOOL_NAME,
    description:
      'List the processes this thread owns: every process the app started for this thread and everything the session\u2019s own shell tool spawned that is still running, with pid, command, working directory and listening ports. Available on every turn that carries the gateway. Use it before stopping anything, and to check whether a server or a probe instance you started is still up.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false
    },
    outputSchema: GATEWAY_OPERATION_RESULT_SCHEMA,
    route: '/process-list',
    sentWhen: 'Before stopping a process, or when the user asks what is still running'
  },
  {
    name: PROCESS_START_TOOL_NAME,
    description:
      'Start a command as an app-owned background process and return its pid, together with the cwd and label the app recorded with it. Use this instead of backgrounding a process in the shell (a trailing &, nohup, setsid) whenever the process has to outlive the tool call: a dev server, a probe instance, a watcher, a long conversion. The app spawns it detached with its own environment, records the pid against this thread, lists it in ' +
      PROCESS_LIST_TOOL_NAME +
      ', and stops it with ' +
      PROCESS_STOP_TOOL_NAME +
      ' or when the thread is cleaned up or the app quits, so it can never be orphaned. Output goes to the log file the result names.',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description:
            'Shell command to run in the background, for example "bun run dev:probe" or "bun run dev:fast". Run through the platform shell in the working directory below.'
        },
        cwd: {
          type: 'string',
          description:
            'Working directory. Defaults to this thread\u2019s project root; must stay inside the project.'
        },
        label: {
          type: 'string',
          description: 'Short human label for the process row, for example "probe instance".'
        }
      },
      required: ['command'],
      additionalProperties: false
    },
    outputSchema: GATEWAY_OPERATION_RESULT_SCHEMA,
    route: '/process-start',
    sentWhen: 'A dev server, probe instance, watcher or any command that must outlive the tool call'
  },
  {
    name: PROCESS_STOP_TOOL_NAME,
    description:
      'Stop one process owned by this thread, by pid, and report the pid that was stopped. Ownership is re-verified in the app before anything is signalled: a pid this thread does not own (another project\u2019s server, a process the user started, a recycled pid) is refused with the list of pids this thread can stop. Stopping a process from a shell command is refused in every form, so this is the only way to end a process you started. Use it for a dev server or a probe instance once you are done with it; a process that must keep running is left alone.',
    inputSchema: {
      type: 'object',
      properties: {
        pid: {
          type: 'number',
          description:
            'Process id to stop, as returned by ' +
            PROCESS_LIST_TOOL_NAME +
            ' or ' +
            PROCESS_START_TOOL_NAME +
            '.'
        },
        force: {
          type: 'boolean',
          description:
            'Skip the graceful stop and terminate immediately. Use it only when the process ignored a normal stop.'
        }
      },
      required: ['pid'],
      additionalProperties: false
    },
    outputSchema: GATEWAY_OPERATION_RESULT_SCHEMA,
    route: '/process-stop',
    sentWhen: 'A process you started is still running and is no longer needed'
  }
]
