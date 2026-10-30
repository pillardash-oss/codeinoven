import type { AgentPart } from './types'

/**
 * Canonical action categories a tool call is reduced to.
 *
 * Raw tool identifiers diverge per harness (Claude Code's `Bash`/`Read`/`Task`
 * vs. Pi's lowercase `bash`/`read`/spawn-tool names vs. opencode's `webfetch`,
 * etc.), so nothing user-facing may assert them as-is. These patterns match on
 * intent, not on any one harness's naming, and are checked in order from most to
 * least specific.
 *
 * Two readers share this list: the trace row label a tool part carries, and the
 * harness-agnostic recap a resumed session is handed.
 */
export const TOOL_ACTION_PATTERNS: Array<{ match: RegExp; label: string }> = [
  { match: /todo/i, label: 'updated the task list' },
  { match: /task|spawn.?agent|subagent|agent.?status/i, label: 'delegated to a sub-agent' },
  { match: /websearch|web.?search/i, label: 'searched the web' },
  { match: /webfetch|fetch|browse|curl/i, label: 'fetched a URL' },
  { match: /bash|shell|exec|terminal|command/i, label: 'ran a shell command' },
  { match: /multiedit|notebook.?edit|apply.?patch|patch/i, label: 'edited a file' },
  { match: /^edit$|^edit[-_]/i, label: 'edited a file' },
  { match: /^write$|write[-_]?file/i, label: 'wrote a file' },
  { match: /^read$|read.?file|^cat$/i, label: 'read a file' },
  { match: /grep|glob|^find$|search/i, label: 'searched files' }
]

/**
 * The action labels for the app's own gateway and core tools.
 *
 * Their names are this app's vocabulary (`cio_util_init`, `cio_todo_write`), so
 * a pattern built for harness tool names reads them wrongly: `cio_todo_write` is
 * not a file write. They are named here instead, in the words the app itself
 * uses for them.
 */
const APP_TOOL_ACTIONS: Record<string, string> = {
  cio_ask_user: 'asked you a question',
  cio_ask_secret: 'asked for a credential',
  cio_request_files: 'requested files',
  cio_sensitive_access_reason: 'explained a protected-file read',
  cio_todo_write: 'updated the task list',
  cio_agent_status: 'checked on a sub-agent',
  cio_agent_output: 'read a sub-agent report',
  cio_app_catalog: 'read the app catalog',
  cio_app_call: 'used the app',
  cio_util_find: 'searched for a capability',
  cio_util_use: 'used a capability',
  cio_util_docs_lookup: 'read capability docs',
  cio_util_diagnose: 'checked app diagnostics',
  cio_util_suggest: 'offered a capability',
  cio_util_manage: 'installed a capability',
  cio_create_brainstorm: 'drafted a brainstorm',
  cio_create_prd: 'drafted a PRD',
  cio_create_spec: 'drafted a specification',
  cio_create_assignment: 'drafted an assignment',
  cio_orchestrate_targets: 'listed the available Ovens',
  cio_orchestrate_dispatch: 'dispatched a thread',
  cio_orchestrate_status: 'checked a dispatched thread',
  cio_typesafe_api_key: 'read an API key'
}

/** Tool names that activate a utility, including the wording older skills use. */
const UTILITY_ACTIVATE_TOOL_KEYS = new Set(['cio_util_init', 'cio_util_activate'])

/** The tool name that invokes an operation on a utility. */
const UTILITY_INVOKE_KEY = 'cio_util_use'

/**
 * The core shell and file primitives, named by the one word that already is
 * their action.
 *
 * A sentence beside these is tautology: the row shows the command that ran or
 * the file that changed right next to it, so "Ran a shell command : bun test"
 * says the same thing twice. They read as the word they are, and every call
 * whose action is genuinely less obvious keeps a phrase that explains it.
 */
const SHORT_TOOL_LABELS: Array<{ match: RegExp; label: string }> = [
  {
    match: /^(?:bash|shell|sh|zsh|cmd|powershell|pwsh|exec|execute|terminal|command)$/u,
    label: 'Shell'
  },
  {
    match:
      /^(?:edit|edits|multiedit|strreplace|strreplaceeditor|applypatch|patch|filechange|fileedit|notebookedit)$/u,
    label: 'Edit'
  },
  { match: /^(?:write|writefile|createfile|newfile|create)$/u, label: 'Write' },
  { match: /^(?:read|readfile|cat|view|viewfile)$/u, label: 'Read' },
  { match: /^(?:grep|glob|find|search|searchfiles|ripgrep|rg)$/u, label: 'Search' }
]

/**
 * The field an agent fills with, in its own words, what the call accomplishes.
 *
 * The app's own tools declare it, so a model that wants the trace to read as the
 * intent rather than the mechanics has somewhere to say so. Harness tools keep
 * their own schemas, so the same words are also read from the free-text argument
 * a harness exposes (`description` and friends) and the label falls back to the
 * action itself when none of them is present.
 */
export const ACTION_SUMMARY_INPUT_KEY = 'action_summary'

/** The instruction attached to that field wherever the app declares it. */
export const ACTION_SUMMARY_SCHEMA_DESCRIPTION =
  'Optional. One short phrase saying what this call accomplishes, shown to the user in place of the raw tool name.'

/**
 * Input fields in which a model states, in its own words, what the call does.
 * `action_summary` is the app's own field and outranks the harness conventions,
 * because a model that fills it is labelling this trace, not describing the
 * call's parameters.
 */
const MODEL_LABEL_INPUT_KEYS = ['description', 'purpose', 'intent', 'label']

/** A model-written label longer than this is prose, not a label. */
const MODEL_LABEL_MAX_CHARACTERS = 100

/** Split a tool name into its namespace segments (`utilities__cio_util_use`). */
function toolNameSegments(tool: string): string[] {
  return tool
    .toLowerCase()
    .split(/(?:__|[./:\s])/u)
    .filter(Boolean)
}

/** The bare name of a tool, without the namespace a harness prefixed to it. */
function bareToolName(tool: string): string {
  const last = toolNameSegments(tool).at(-1) ?? tool.toLowerCase()
  return last.replace(/[^a-z0-9]/gu, '')
}

/** The one-word label for a core shell or file primitive, when it has one. */
function shortToolLabel(tool: string): string | undefined {
  const name = bareToolName(tool)
  return SHORT_TOOL_LABELS.find(({ match }) => match.test(name))?.label
}

/**
 * The app-tool key a call names, if it names one.
 *
 * A harness may nest the app's own tools under a namespace (`utilities__cio_util_use`
 * on an MCP-prefixing harness), so the lookup reads the segment that starts with
 * `cio_` rather than the whole name.
 */
function appToolKey(tool: string): string | undefined {
  return toolNameSegments(tool).find((segment) => segment.startsWith('cio_'))
}

/**
 * Add the action-summary field to a tool's JSON schema, so an agent can say what
 * a call accomplishes instead of the trace naming the mechanics.
 *
 * Applied where the app publishes its own tool catalog, which is the only place
 * the app owns the schema: a harness tool keeps the parameters its harness
 * declares. A schema that already announces the field is returned unchanged.
 */
export function withActionSummarySchema(
  inputSchema: Record<string, unknown>
): Record<string, unknown> {
  const properties = inputSchema['properties']
  if (!properties || typeof properties !== 'object') return inputSchema
  const fields = properties as Record<string, unknown>
  if (fields[ACTION_SUMMARY_INPUT_KEY]) return inputSchema
  return {
    ...inputSchema,
    properties: {
      ...fields,
      [ACTION_SUMMARY_INPUT_KEY]: {
        type: 'string',
        description: ACTION_SUMMARY_SCHEMA_DESCRIPTION
      }
    }
  }
}

/** True for a value that names nothing a reader can use (an opaque row id). */
export function isOpaqueId(value: string): boolean {
  return /^[0-9a-f]{16,}$/iu.test(value.trim())
}

/** Turn an identifier into words: `svelte-autofixer` reads as "Svelte Autofixer". */
function humanizeName(value: string): string {
  return value
    .trim()
    .replace(/^cio:/iu, '')
    .split(/[-_.\s]+/u)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/**
 * The operation a utility call invoked, in words. This is the helpful half of a
 * `cio_util_use` call: the utility id is often an opaque banked row id, while
 * the operation (`svelte-autofixer`) is what actually happened.
 */
function utilityOperationName(input: Record<string, unknown>): string | undefined {
  for (const key of ['operation', 'op', 'tool']) {
    const value = input[key]
    if (typeof value !== 'string') continue
    const name = humanizeName(value)
    if (name) return name
  }
  return undefined
}

/** Human name for a utility id: `cio:browser` reads as "Browser". */
function utilityName(input: Record<string, unknown>): string | undefined {
  for (const key of ['utility_id', 'utilityId', 'id', 'name']) {
    const value = input[key]
    if (typeof value !== 'string' || isOpaqueId(value)) continue
    const name = humanizeName(value)
    if (name) return name
  }
  return undefined
}

/** A model-written one-line label carried in the call's own input. */
function modelLabel(input: Record<string, unknown>): string | undefined {
  for (const key of MODEL_LABEL_INPUT_KEYS) {
    const value = input[key]
    if (typeof value !== 'string') continue
    const label = value.trim().replace(/\s+/gu, ' ')
    if (!label || label.length > MODEL_LABEL_MAX_CHARACTERS) continue
    if (!/[\p{L}]/u.test(label)) continue
    return label
  }
  return undefined
}

/** The app's own action-summary field, which a model fills only to label a call. */
function actionSummaryLabel(input: Record<string, unknown>): string | undefined {
  const value = input[ACTION_SUMMARY_INPUT_KEY] ?? input['actionSummary']
  if (typeof value !== 'string') return undefined
  const label = value.trim().replace(/\s+/gu, ' ')
  if (!label) return undefined
  return label.length > MODEL_LABEL_MAX_CHARACTERS
    ? label.slice(0, MODEL_LABEL_MAX_CHARACTERS)
    : label
}

/** Capitalize a lowercase action phrase for a row label. */
export function capitalizeActionPhrase(phrase: string): string {
  return phrase.charAt(0).toUpperCase() + phrase.slice(1)
}

/**
 * The canonical action phrase for a tool name, without any per-call detail.
 * Used where only the name is available, and by the resume recap, which must
 * never assert a raw identifier the resumed harness may not recognize.
 */
export function patternActionPhrase(tool: string): string | undefined {
  const appKey = appToolKey(tool)
  if (appKey && APP_TOOL_ACTIONS[appKey]) return APP_TOOL_ACTIONS[appKey]
  return TOOL_ACTION_PATTERNS.find(({ match }) => match.test(tool))?.label
}

/** What a friendly action label is derived from. */
export interface ToolActionLabelSource {
  tool: string
  input?: Record<string, unknown>
  /** Label the harness or the model already attached to the call. */
  title?: string
  /** True when the call ran model-written code or was made from inside it. */
  codeMode?: boolean
}

/**
 * The friendly action a tool call performed, in sentence case, or `undefined`
 * when nothing about the call can be said without repeating its raw name.
 *
 * The chain is: the app's own vocabulary, then the model's own words when the
 * harness exposes them, then the harness-agnostic action patterns. A harness
 * title or provider label always wins upstream (see `toolActionLabelForPart`),
 * and code mode keeps its own wording, because a call a script made can carry
 * any inner tool name and the row says more by naming the script than by
 * repeating a nested name.
 */
export function toolActionLabel(source: ToolActionLabelSource): string | undefined {
  if (source.title?.trim()) return undefined
  const input = source.input ?? {}
  // The action summary is the model saying what this call is for, in the words a
  // reader wants, so it outranks every name-shaped guess below it.
  const summary = actionSummaryLabel(input)
  if (summary) return capitalizeActionPhrase(summary)
  const appKey = appToolKey(source.tool)
  if (appKey && UTILITY_ACTIVATE_TOOL_KEYS.has(appKey)) {
    const name = utilityName(input)
    return name ? `Activated the ${name} utility` : 'Activated a utility'
  }
  if (appKey === UTILITY_INVOKE_KEY) {
    // A utility id is often an opaque banked row id, which says nothing to a
    // reader. Name the utility when its id is readable, and otherwise name the
    // operation that actually ran (`Used Svelte Autofixer`).
    const name = utilityName(input)
    if (name) return `Used the ${name} utility`
    const operation = utilityOperationName(input)
    return operation ? `Used ${operation}` : 'Used a utility'
  }
  if (appKey && APP_TOOL_ACTIONS[appKey]) {
    return capitalizeActionPhrase(APP_TOOL_ACTIONS[appKey])
  }
  if (source.codeMode === true) return undefined
  const stated = modelLabel(input)
  if (stated) return capitalizeActionPhrase(stated)
  // The core primitives say everything in their own name, see SHORT_TOOL_LABELS.
  const short = shortToolLabel(source.tool)
  if (short) return short
  const phrase = patternActionPhrase(source.tool)
  return phrase ? capitalizeActionPhrase(phrase) : undefined
}

/**
 * Stamp the friendly action label onto a tool part.
 *
 * This is the snapshot: the label is derived once, when the part is first seen,
 * and then travels with the part through the live broadcast, the durable stream
 * log and the transcript mirror. Renderers read the stored string instead of
 * re-deriving it for every row of every trace, and a thread recorded before this
 * field existed simply renders its title or raw tool name instead. Returns the
 * same part when there is nothing to add, so the common case allocates nothing.
 */
export function toolActionLabelForPart(
  part: Extract<AgentPart, { type: 'tool' }>
): Extract<AgentPart, { type: 'tool' }> {
  if (part.actionLabel) return part
  const label = toolActionLabel({
    tool: part.tool,
    input: part.state.input,
    title: part.state.title,
    codeMode: part.codeMode
  })
  return label ? { ...part, actionLabel: label } : part
}
