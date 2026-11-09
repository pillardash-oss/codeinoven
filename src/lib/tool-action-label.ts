import { isQuestionToolName, isTodoToolName } from './agent-interactions'
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
  { match: /skill/i, label: 'used a skill' },
  { match: /websearch|web.?search|search.?web/i, label: 'searched the web' },
  { match: /webfetch|fetch|browse|curl/i, label: 'fetched a URL' },
  { match: /bash|shell|exec|terminal|command/i, label: 'ran a shell command' },
  { match: /multiedit|notebook.?edit|apply.?patch|patch|replace.?file/i, label: 'edited a file' },
  { match: /^edit$|^edit[-_]/i, label: 'edited a file' },
  { match: /^write$|write[-_]?file|write.?to.?file/i, label: 'wrote a file' },
  { match: /^read$|read.?file|^cat$/i, label: 'read a file' },
  { match: /grep|glob|^find$|find.?by.?name|search/i, label: 'searched files' }
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
  cio_orchestrate_answer: 'answered a waiting thread',
  cio_create_assistant: 'hired an assistant for the request',
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
    // Every harness's shell: pi's `bash`, opencode's `shell`, codex's
    // `command_execution`, Claude Code's `Bash`, Antigravity's `run_command`,
    // Cline's `run_commands` and `execute_command`, and the Windows shells.
    match:
      /^(?:bash|shell|sh|zsh|cmd|powershell|pwsh|exec|execute|terminal|command|commandexecution|executecommand|runcommand|runcommands)$/u,
    label: 'Shell'
  },
  {
    match:
      /^(?:edit|edits|editfile|editfiles|multiedit|strreplace|strreplaceeditor|applypatch|applydiff|patch|filechange|fileedit|notebookedit|editor|replacefilecontent|replaceinfile)$/u,
    label: 'Edit'
  },
  {
    match: /^(?:write|writefile|createfile|newfile|create|writetofile)$/u,
    label: 'Write'
  },
  { match: /^(?:read|readfile|readfiles|cat|view|viewfile)$/u, label: 'Read' },
  {
    match: /^(?:ls|listdir|listdirs|listfiles|list|listdirectory|listfolders|listfolder)$/u,
    label: 'List'
  },
  {
    match: /^(?:grep|glob|find|search|searchfiles|ripgrep|rg|findbyname)$/u,
    label: 'Search'
  }
]

/**
 * Exact tool names whose act its spelling never says.
 *
 * A harness invents these for one act each, so a pattern built from shell and
 * file vocabulary reads them wrongly or not at all.
 */
const NAMED_TOOL_PHRASES: Record<string, string> = {
  attemptcompletion: 'Finished the task',
  toolsearch: 'Searched for a tool',
  accessmcpresource: 'Read an MCP resource',
  loadmcpdocumentation: 'Read the MCP docs',
  planmoderespond: 'Answered in plan mode',
  // The agent protocol's own kinds, whose names are not actions in any language.
  think: 'Reasoned about the task',
  switchmode: 'Switched mode',
  delete: 'Deleted a file',
  move: 'Moved a file'
}

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
 * The same request on the tool's own description, for app tools.
 *
 * A model reads a tool's description while it decides to call it, which is
 * earlier than it reads the parameter schema, so this is where the request has
 * the best chance of shaping the call. It is only ever appended to a tool whose
 * schema declares the field, never to a harness tool: a strict harness schema
 * would reject the argument instead of ignoring it.
 */
export const ACTION_SUMMARY_ADVICE =
  ' Always pass action_summary: a short phrase telling the user what this call accomplishes for them.'

/** A tool description carrying the action-summary request. */
export function withActionSummaryAdvice(description: string): string {
  if (description.includes(ACTION_SUMMARY_ADVICE.trim())) return description
  return `${description}${ACTION_SUMMARY_ADVICE}`
}

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
 * Tool names that load a skill's instructions into the agent's context.
 *
 * Every harness spells the call differently (`skill` on opencode, `Skill` on
 * Claude Code, `load_skill` and friends elsewhere) and it is always the same
 * act, so no harness's spelling may reach the trace as itself.
 */
const SKILL_TOOL_NAME =
  /^(?:skills?|useskill|loadskill|readskill|invokeskill|activateskill|skilltool|skillread|dispatcheskill)$/u

/**
 * Tool names a harness uses as one meta-tool for every MCP tool it can reach.
 *
 * Antigravity routes every gateway and MCP call through `call_mcp_tool` and
 * carries the real tool in the arguments, so a trace that reads the reported
 * name names the wrapper and never the tool that ran.
 */
const MCP_META_TOOL_NAME =
  /^(?:callmcptool|mcptool|mcpcall|calltool|usemcptool|invokemcptool|mcpinvoke)$/u

/** Input fields naming the real tool behind an MCP meta-tool call. */
const MCP_TARGET_INPUT_KEYS = ['ToolName', 'tool_name', 'toolName', 'tool', 'name', 'toolId']

/** Input fields carrying the real tool's own arguments. */
const MCP_ARGUMENT_INPUT_KEYS = ['Arguments', 'arguments', 'args', 'input', 'parameters']

/**
 * Tool names for a harness's background-task manager.
 *
 * Antigravity's `manage_task` checks on and stops a task the CLI spawned, so
 * the `task` in its name is a process, not a sub-agent the agent delegated to.
 */
const BACKGROUND_TASK_TOOL_NAME =
  /^(?:managetask|taskmanage|taskstatus|taskkill|killtask|stoptask|listtasks)$/u

/** True when a call loaded a skill's instructions. */
export function isSkillToolName(tool: string): boolean {
  return SKILL_TOOL_NAME.test(bareToolName(tool))
}

/** Input fields a skill call names the skill it loaded in. */
const SKILL_NAME_INPUT_KEYS = [
  'name',
  'skill',
  'id',
  'skill_name',
  'skill_id',
  'skillName',
  'skillId'
]

/** The skill's own header, echoed in the text a harness returns to the model. */
const SKILL_OUTPUT_NAME = /<skill_content\s+name="([^"]{1,120})"/u
const SKILL_OUTPUT_HEADING = /^#\s*Skill:\s*([\w.-]{1,120})/mu

/** How much of a result can carry a skill's header. */
const SKILL_OUTPUT_HEADER_CHARS = 400

/**
 * The skill a call loaded, from the call's input and then from its result.
 *
 * The input is read first, because that is the skill the model chose. opencode
 * clears a tool call's input once the call settles and keeps only the loaded
 * skill's text, so the name is recovered from that text's own header rather than
 * letting the row fall back to the raw tool name the moment the call completes.
 */
function skillName(input: Record<string, unknown>, output: string | undefined): string | undefined {
  for (const key of SKILL_NAME_INPUT_KEYS) {
    const value = input[key]
    if (typeof value !== 'string') continue
    const name = value.trim()
    if (!name || isOpaqueId(name)) continue
    return name
  }
  const header = output?.slice(0, SKILL_OUTPUT_HEADER_CHARS)
  if (!header) return undefined
  const named = header.match(SKILL_OUTPUT_NAME)?.[1] ?? header.match(SKILL_OUTPUT_HEADING)?.[1]
  return named?.trim() || undefined
}

/** A plain object value, when the field holds one. */
function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The tool that actually ran, and the arguments it ran with. */
export interface ResolvedToolCall {
  tool: string
  input: Record<string, unknown>
}

/**
 * The tool a call actually reached.
 *
 * A harness that routes every MCP tool through one meta-tool reports the
 * wrapper and puts the real tool in the arguments. Everything that reads a call
 * (its label, its row subject, its glyph) goes through here, so no reader has to
 * know which harness does that.
 */
export function resolveToolCall(
  tool: string,
  input: Record<string, unknown> = {}
): ResolvedToolCall {
  if (!MCP_META_TOOL_NAME.test(bareToolName(tool))) return { tool, input }
  const target = MCP_TARGET_INPUT_KEYS.map((key) => input[key]).find(
    (value): value is string => typeof value === 'string' && value.trim().length > 0
  )
  if (!target) return { tool, input }
  const args = MCP_ARGUMENT_INPUT_KEYS.map((key) => input[key]).find(isRecordValue)
  return { tool: target.trim(), input: args ?? {} }
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

/** A value reduced to what it says, so two spellings of one text can be compared. */
function comparableText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/gu, '')
}

/**
 * True when a harness title merely restates one of the call's own arguments.
 *
 * Codex fills a shell call's `title` with the command itself, so treating that
 * title as the call's label printed the command as the row's headline (and, with
 * the subject beside it, twice) while the action never got named. A title that
 * says nothing beyond an argument is that argument, never a label.
 */
export function toolTitleRestatesInput(title: string, input: Record<string, unknown>): boolean {
  const stated = comparableText(title)
  if (stated.length < 3) return false
  for (const value of Object.values(input)) {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    if (!text) continue
    const candidate = comparableText(text)
    if (candidate.length < 3) continue
    if (candidate.startsWith(stated) || stated.startsWith(candidate)) return true
  }
  return false
}

/**
 * True when a harness title only repeats the tool's own name.
 *
 * Muse falls back to the raw tool name as the title of a call the CLI gave no
 * description for, and Cline keeps the tool name as the title of a partial call.
 * That title is the harness naming the tool, never the action it performed, so it
 * must not win over the label derived from the same name.
 */
export function toolTitleRepeatsToolName(title: string, tool: string): boolean {
  const stated = comparableText(title)
  if (!stated) return false
  return stated === comparableText(tool) || stated === comparableText(bareToolName(tool))
}

/**
 * True when a harness title actually labels the call, in words of its own.
 *
 * The one question a reader of a tool part asks of its title: is this the action,
 * or is it the command, the path, or the tool's own name written again?
 */
export function toolTitleLabelsCall(
  title: string | undefined,
  tool: string,
  input: Record<string, unknown>
): boolean {
  const trimmed = title?.trim()
  if (!trimmed) return false
  if (toolTitleRestatesInput(trimmed, input)) return false
  return !toolTitleRepeatsToolName(trimmed, tool)
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

/** What a background-task manager call did, in the words the call carries. */
function backgroundTaskLabel(input: Record<string, unknown>): string {
  const raw = input['Action'] ?? input['action']
  const action = typeof raw === 'string' ? raw.toLowerCase() : ''
  if (/kill|stop|cancel|terminate/.test(action)) return 'Stopped a background task'
  if (/list/.test(action)) return 'Listed background tasks'
  return 'Checked a background task'
}

/** What a friendly action label is derived from. */
export interface ToolActionLabelSource {
  tool: string
  input?: Record<string, unknown>
  /** Label the harness or the model already attached to the call. */
  title?: string
  /** True when that title names the call's subject rather than its action. */
  titleIsSubject?: boolean
  /** The result the call produced, when the name of the skill it loaded is
   *  only recoverable from that result. */
  output?: string
  /** True when the call ran model-written code or was made from inside it. */
  codeMode?: boolean
}

/**
 * The friendly action a tool call performed, in sentence case, or `undefined`
 * when nothing about the call can be said without repeating its raw name.
 *
 * The chain is: the app's own vocabulary, then the model's own words when the
 * harness exposes them, then the harness-agnostic action patterns. A harness
 * title wins upstream (see `toolActionLabelForPart`) unless it only restates an
 * argument, and code mode keeps its own wording, because a call a script made
 * can carry any inner tool name and the row says more by naming the script than
 * by repeating a nested name.
 */
export function toolActionLabel(source: ToolActionLabelSource): string | undefined {
  // A meta-tool call is named by the tool it reached, never by the wrapper.
  const call = resolveToolCall(source.tool, source.input ?? {})
  const tool = call.tool
  const input = call.input
  // A harness title wins when it labels the call. When it only restates an
  // argument, it is the row's subject and the action still has to be named.
  const title = source.title?.trim()
  if (
    title &&
    source.titleIsSubject !== true &&
    !toolTitleRestatesInput(title, input) &&
    !toolTitleRepeatsToolName(title, tool) &&
    !toolTitleRepeatsToolName(title, source.tool)
  ) {
    return undefined
  }
  // The action summary is the model saying what this call is for, in the words a
  // reader wants, so it outranks every name-shaped guess below it.
  const summary = actionSummaryLabel(input)
  if (summary) return capitalizeActionPhrase(summary)
  const appKey = appToolKey(tool)
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
  // A skill call is the agent loading instructions for how to do the work, and
  // the skill's own name is the only label that says which work it loaded for.
  if (isSkillToolName(tool)) {
    const skill = skillName(input, source.output)
    return skill ? `Used the ${humanizeName(skill)} skill` : 'Used a skill'
  }
  // Two interaction shapes keep their own words wherever they come from: a
  // harness's question tool and a harness's task-list tool are the same act
  // whichever name the harness gave them.
  if (isQuestionToolName(tool)) return 'Asked a question'
  if (isTodoToolName(tool)) return 'Updated the task list'
  if (BACKGROUND_TASK_TOOL_NAME.test(bareToolName(tool))) return backgroundTaskLabel(input)
  const stated = modelLabel(input)
  if (stated) return capitalizeActionPhrase(stated)
  // The core primitives say everything in their own name, see SHORT_TOOL_LABELS.
  const short = shortToolLabel(tool)
  if (short) return short
  // The names a harness invented for one act, which no pattern can read.
  const named = NAMED_TOOL_PHRASES[bareToolName(tool)]
  if (named) return named
  const phrase = patternActionPhrase(tool)
  if (phrase) return capitalizeActionPhrase(phrase)
  // A namespaced name is an MCP tool this app has no words for, and a meta-tool
  // call still has to name the tool it reached: the reader sees what ran.
  const segments = toolNameSegments(tool)
  if (segments.length > 1) return `Used the ${humanizeName(segments.at(-1) ?? tool)} MCP tool`
  if (tool !== source.tool) return `Used the ${humanizeName(tool)} MCP tool`
  return undefined
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
    titleIsSubject: part.state.titleIsSubject,
    output: part.state.output,
    codeMode: part.codeMode
  })
  return label ? { ...part, actionLabel: label } : part
}
