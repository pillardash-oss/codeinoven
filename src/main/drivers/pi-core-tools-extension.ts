/**
 * Generated TypeScript source for the app-owned Pi core-tools extension.
 *
 * Pi has no native question, todo, file-request, or permission-card tools.
 * This extension closes that gap with three custom tools plus a tool-call
 * permission gate:
 *
 *  - `cio_ask_user`      — structured multi-question ask rendered by the app's
 *                          question cards through the extension-UI protocol.
 *  - `cio_todo_write`    — todo tracking; the name and `{ todos: [...] }`
 *                          input shape match the renderer's todo-tool
 *                          detection, so AgentTodoCard works unchanged.
 *  - `cio_request_files` — asks the user for file paths, validates them, and
 *                          returns a structured file list for the agent.
 *
 * The permission gate intercepts every built-in tool call via
 * `pi.on('tool_call')` and evaluates it against an OpenCode-style
 * "flat out denied" list (recursive deletes, destructive git operations,
 * privileged/system commands, piped shell downloads, and any file access
 * outside the project cwd). A denied-category call pauses on
 * `ctx.ui.confirm(...)` whose message carries a `cio-permission:` marker with
 * structured JSON metadata; the driver upgrades that dialog into a real
 * `permission.asked` event so the renderer shows the standard permission card
 * and the chat engine's PermissionPolicy enrichment (risk, reason, auto-reply
 * in full-access mode) keeps working unchanged.
 *
 * The marker constants are shared with the driver: `CIO_PERMISSION_MARKER`
 * for permission dialogs, `CIO_SUBAGENT_MARKER` for sub-agent progress
 * streamed through tool-execution updates, and `CIO_QUESTION_MARKER` for
 * question dialogs carrying the scope header separately from the question
 * text (pi's dialog signature has a single title string).
 *
 * Sub-agents: `cio_spawn_agent` opens a nested in-process pi session (a
 * persistent worker "thread" controlled by the primary agent). Sub-agents
 * get gated wrappers around the built-in tools — never the spawn tool, so
 * they cannot recurse — inherit the primary's model/thinking level unless
 * overridden per spawn, and bubble every permission request up to the
 * primary thread through the parent extension-UI context. Permission cards
 * are pure UI on the primary thread: the primary agent's context only ever
 * receives the sub-agent's final message, never its transcript.
 *
 * Background sub-agents announce completion to the primary agent through a
 * display:false custom message delivered with pi.sendMessage — steer while
 * the primary is streaming, a fresh turn when it is idle. The model sees
 * the notification and final output as a user-role context message, but it
 * never renders in the transcript: the driver ignores custom-role messages.
 *
 * Completion reporting: workers track every file they edit or write (and
 * are instructed to list shell-created files), and those paths accompany the
 * result and notification because the primary agent owns committing. An
 * agent_settled guard wakes the primary with a fresh turn whenever it tries
 * to end its work while sub-agents are still running.
 */

import {
  CIO_ASK_USER_TOOL_NAME,
  CIO_AGENT_STATUS_TOOL_NAME,
  CIO_REQUEST_FILES_TOOL_NAME,
  CIO_SPAWN_AGENT_TOOL_NAME,
  CIO_TODO_WRITE_TOOL_NAME
} from '../../lib/core-tools'

export { PI_CORE_TOOLS_TOOL_NAMES } from '../../lib/core-tools'

export const CIO_PERMISSION_MARKER = 'cio-permission:'
export const CIO_SUBAGENT_MARKER = 'cio-subagent:'
export const CIO_QUESTION_MARKER = 'cio-question:'

export function piCoreToolsExtension(): string {
  return `import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
  createAgentSession,
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  SessionManager
} from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

const CIO_PERMISSION_MARKER = 'cio-permission:'
const CIO_QUESTION_MARKER = 'cio-question:'
const CIO_SYSTEM_PROMPT_PATH = '__CIO_SYSTEM_PROMPT_PATH__'

// Pi's own bundled system prompt opens with a "you are an assistant" framing
// that pushes models toward generic chatbot hedging (permission-seeking,
// disclaiming, "I should be cautious") instead of acting as an autonomous
// engineering agent. This only gets swapped for genuine project-thread work
// (Engineering and regular project chats with full workspace scope), never
// for plain/temporary chat or file-system-enabled chat threads — those are
// still meant to read as a chat assistant, not an autonomous engineering
// agent. The full workspace-scope block (buildWorkspaceContext in
// prompt-assembler.ts) is the only prompt layer that ever contains this
// marker line, so its presence is the reliable "this is project mode, not
// chat mode" signal.
const CIO_PROJECT_MODE_MARKER = 'WORKING SCOPE — this overrides ambiguous instructions:'
const PI_ASSISTANT_IDENTITY_LINE =
  'You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.'
const CIO_AGENT_IDENTITY_LINE =
  'You are the agentic engine driving CodeInOven, an Agentic Development Environment (ADE) for autonomous software engineering — not a chat assistant. You act directly: read files, execute commands, edit code, and write new files to complete real engineering work end to end on the open project, without waiting for permission to do what you were already asked to do.'

// The driver rewrites this file per turn with the CodeInOven-composed
// instructions (work ethic, persistent preferences, working scope, skills).
// Reading it here and returning it from before_agent_start delivers it as a
// real system-role field on every request, instead of the driver
// concatenating it into the user turn's text — which replayed the same
// multi-kilobyte block inside every "user" message and made models mistake
// the repeated block for injected/duplicated content.
function loadCioSystemPrompt() {
  try {
    return readFileSync(CIO_SYSTEM_PROMPT_PATH, 'utf8').trim()
  } catch {
    return ''
  }
}

interface GateHit {
  permission: string
  patterns: string[]
  command?: string
  reason: string
}

interface DenyRule {
  pattern: RegExp
  label: string
}

// Recursive or bulk deletes — flat out denied without explicit approval.
const RECURSIVE_DELETE_RULES: DenyRule[] = [
  { pattern: /(?:^|[;&|]\\s*)rm\\s+(?=[^\\n]*(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)(?:\\s|$))/u, label: 'a recursive delete (rm -r)' },
  { pattern: /(?:^|[;&|]\\s*)find\\s+[^\\n]+\\s-delete(?:\\s|$)/u, label: 'find -delete' },
  { pattern: /(?:^|[;&|]\\s*)git\\s+clean(?=[^\\n]*-[a-zA-Z]*[fdx])/u, label: 'git clean' },
  { pattern: /(?:^|[;&|]\\s*)Remove-Item\\b[^\\n]*\\s-Recurse\\b/iu, label: 'Remove-Item -Recurse' },
  { pattern: /(?:^|[;&|]\\s*)(?:rmdir|rd|del)\\b[^\\n]*\\s\\/(?:s|S)\\b/u, label: 'a recursive delete (rmdir /s)' }
]

// Git operations that discard or rewrite user work.
const GIT_DESTRUCTIVE_RULES: DenyRule[] = [
  { pattern: /(?:^|[;&|]\\s*)git\\s+reset\\s+(?=[^\\n]*--hard)/u, label: 'git reset --hard' },
  { pattern: /(?:^|[;&|]\\s*)git\\s+revert(?:\\s|$)/u, label: 'git revert' },
  { pattern: /(?:^|[;&|]\\s*)git\\s+stash\\s+(?:drop|clear|pop)\\b/u, label: 'git stash drop/clear/pop' },
  { pattern: /(?:^|[;&|]\\s*)git\\s+checkout\\s+(?=[^\\n;&|]*--(?:\\s|$))/u, label: 'git checkout -- (discards path changes)' },
  { pattern: /(?:^|[;&|]\\s*)git\\s+restore\\s+\\S/u, label: 'git restore (discards changes)' },
  { pattern: /(?:^|[;&|]\\s*)git\\s+push\\s+(?=[^\\n]*(?:--force(?:-with-lease)?|-f)(?:\\s|$))/u, label: 'git push --force' },
  { pattern: /(?:^|[;&|]\\s*)git\\s+branch\\s+(?:-D|--delete\\s+\\S+\\s*$)/u, label: 'git branch -D' },
  { pattern: /(?:^|[;&|]\\s*)git\\s+filter-branch\\b/u, label: 'git filter-branch' },
  { pattern: /(?:^|[;&|]\\s*)git\\s+reflog\\s+(?:delete|expire)\\b/u, label: 'git reflog delete/expire' },
  { pattern: /(?:^|[;&|]\\s*)git\\s+gc\\s+(?=[^\\n]*--prune=now)/u, label: 'git gc --prune=now' }
]

// Privileged or system-level commands.
const SYSTEM_RULES: DenyRule[] = [
  { pattern: /(?:^|[;&|]\\s*)sudo\\b/u, label: 'sudo' },
  { pattern: /(?:^|[;&|]\\s*)su\\s+(?:-\\w|\\w)/u, label: 'su' },
  { pattern: /(?:^|[;&|]\\s*)(?:shutdown|reboot|halt|poweroff)\\b/u, label: 'a system power command' },
  { pattern: /(?:^|[;&|]\\s*)mkfs(?:\\.\\w+)?\\b/u, label: 'mkfs (filesystem format)' },
  { pattern: /(?:^|[;&|]\\s*)dd\\s+(?=[^\\n]*\\bif=)/u, label: 'dd (raw disk write)' }
]

// Piped shell downloads: executing remote scripts sight-unseen.
const PIPED_SHELL_RULES: DenyRule[] = [
  { pattern: /(?:curl|wget|fetch)\\b[^\\n|;&]*\\|\\s*(?:sudo\\s+)?(?:ba|z|da|fi)?sh\\b/u, label: 'a piped shell download (curl | sh)' },
  { pattern: /(?:curl|wget|fetch)\\b[^\\n|;&]*\\|\\s*(?:sudo\\s+)?(?:python3?|perl|node)\\b/u, label: 'a piped interpreter download' }
]

const PROTECTED_PATH_PATTERNS: RegExp[] = [
  /(^|\\/)(\\.git|\\.hg|\\.svn)(\\/|$)/i,
  /(^|\\/)\\.env(\\..+)?$/i,
  /(^|\\/)secrets?(\\/|$)/i,
  /(^|\\/)[^/]*\\.lock$/i,
  /(^|\\/)(package-lock|pnpm-lock|yarn\\.lock|bun\\.lock|bun\\.lockb|cargo\\.lock|gemfile\\.lock|composer\\.lock|poetry\\.lock|Pipfile\\.lock)$/i
]

function firstString(...values) {
  return values.find((value) => typeof value === 'string' && value.trim().length > 0)
}

function recordValue(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined
}

function isOutsideCwd(candidatePath, cwd) {
  const abs = isAbsolute(candidatePath) ? resolve(candidatePath) : resolve(cwd, candidatePath)
  const rel = relative(cwd, abs)
  return rel.startsWith('..') || isAbsolute(rel)
}

function isProtectedPath(candidatePath) {
  return PROTECTED_PATH_PATTERNS.some((pattern) => pattern.test(candidatePath))
}

/** Absolute delete targets outside the project directory, if any. */
function deleteTargetOutsideCwd(command, cwd) {
  const deleteCalls = command.matchAll(/(?:^|[;&|]\\s*)(?:rm|rmdir|del|rd|Remove-Item)\\s+([^\\n;&|]+)/gu)
  for (const match of deleteCalls) {
    const tokens = match[1].split(/\\s+/)
    for (const token of tokens) {
      // Strip common quoting and trailing separators before the path check.
      const candidate = token.replace(/^["']|["']$/gu, '')
      // Single-letter slash tokens are command flags (e.g. del /s), not paths.
      if (!candidate || candidate.startsWith('-') || /^\\/[a-zA-Z]$/u.test(candidate)) continue
      if (isAbsolute(candidate) && isOutsideCwd(candidate, cwd)) return candidate
    }
  }
  return null
}

function gateHit(permission, reason, patterns, command) {
  return {
    permission,
    reason,
    patterns,
    ...(command === undefined ? {} : { command })
  }
}

/**
 * Evaluate a built-in tool call against the flat-out-denied list. Returns the
 * gate hit that requires a permission card, or null when the call may proceed
 * without prompting (non-destructive work inside the project directory).
 */
// Some provider/model pairs (observed on zai/glm-5.3-flash via the Vercel AI
// Gateway) occasionally fail to terminate a tool call's JSON arguments
// mid-stream: the model keeps emitting raw text — its own reasoning, a
// second tool-call attempt in the model's native pseudo-XML tool syntax
// (<tool_call>...<arg_key>...</arg_key><arg_value>...) — and it all lands
// inside the first call's string argument (e.g. bash's "command"). Running
// that string produces garbage shell output that looks exactly like a
// fabricated/injected transcript, which is what makes the model itself
// distrust its own real tool results afterward. Detect the contamination
// markers and block execution instead of running corrupted input.
const TOOL_ARG_CONTAMINATION_MARKERS = [
  '</think>',
  '<think>',
  '<tool_call>',
  '</tool_call>',
  '<arg_key>',
  '<arg_value>'
]

function findContaminatedToolArg(input) {
  for (const [key, value] of Object.entries(input ?? {})) {
    if (typeof value !== 'string') continue
    for (const marker of TOOL_ARG_CONTAMINATION_MARKERS) {
      if (value.includes(marker)) return { key, marker }
    }
  }
  return null
}

function evaluateGate(toolName, input, cwd) {
  if (typeof toolName !== 'string' || toolName.startsWith('cio_')) return null
  if (toolName === 'bash') {
    const command = typeof input['command'] === 'string' ? input['command'] : ''
    if (!command.trim()) return null
    for (const rule of RECURSIVE_DELETE_RULES) {
      if (rule.pattern.test(command)) return gateHit('shell', rule.label, [], command)
    }
    for (const rule of GIT_DESTRUCTIVE_RULES) {
      if (rule.pattern.test(command)) return gateHit('shell', rule.label, [], command)
    }
    for (const rule of PIPED_SHELL_RULES) {
      if (rule.pattern.test(command)) return gateHit('shell', rule.label, [], command)
    }
    for (const rule of SYSTEM_RULES) {
      if (rule.pattern.test(command)) return gateHit('shell', rule.label, [], command)
    }
    const outsideDelete = deleteTargetOutsideCwd(command, cwd)
    if (outsideDelete) {
      return gateHit('shell', 'a delete targeting a path outside the project directory', [outsideDelete], command)
    }
    return null
  }
  if (toolName === 'read' || toolName === 'write' || toolName === 'edit') {
    const path = firstString(input['path'], input['file_path'], input['filePath'], input['filename'])
    if (!path) return null
    if (isOutsideCwd(path, cwd)) {
      const action = toolName === 'read' ? 'reads' : 'modifies'
      return gateHit(toolName, action + ' a file outside the project directory', [path])
    }
    if (isProtectedPath(path)) {
      return gateHit(toolName, 'touches a protected path (.git, .env, lock files, secrets)', [path])
    }
  }
  return null
}

function textResult(value) {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }]
  }
}

/** Pi's RPC UI has no structured question method, so one tagged envelope
 * carries the native question contract through its existing dialog channel. */
function questionDialogTitle(questions) {
  return CIO_QUESTION_MARKER + JSON.stringify({ questions })
}

export default function codeInOvenCoreToolsExtension(pi) {
  pi.registerTool({
    name: '${CIO_ASK_USER_TOOL_NAME}',
    label: 'Ask the user a question',
    description:
      'Ask the user one to three structured questions and wait for their answers. Each question offers two or more described choices plus a custom answer. Use this whenever a decision, preference, or clarification is needed before continuing.',
    promptSnippet: 'Ask structured questions with described choices and wait for answers',
    promptGuidelines: [
      'Use ${CIO_ASK_USER_TOOL_NAME} when a decision, preference, or clarification from the user is needed before continuing.',
      'Ask one to three short questions at a time. Put the recommended option first and add (Recommended) to its label.',
      'Keep option labels short. Put context and tradeoffs in each option description, not in the question text.',
      'Custom answers are always available; do not add an Other option.'
    ],
    parameters: Type.Object({
      questions: Type.Array(
        Type.Object({
          question: Type.String({ description: 'The question text.' }),
          header: Type.String({
            description: 'Short header label (12 or fewer characters).',
            maxLength: 12
          }),
          options: Type.Array(
            Type.Object({
              label: Type.String({ description: 'Short option label (1-5 words).' }),
              description: Type.String({
                description: 'One short sentence explaining the impact or tradeoff.'
              })
            }),
            {
              description: 'Two or more choices.',
              minItems: 2
            }
          ),
          multiple: Type.Optional(
            Type.Boolean({ description: 'Allow more than one option to be selected.' })
          )
        }),
        { description: 'Questions to ask, in order.', minItems: 1, maxItems: 3 }
      )
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const title = questionDialogTitle(params.questions)
      const value =
        params.questions.length === 1
          ? await ctx.ui.select(
              title,
              params.questions[0].options.map((option) => option.label)
            )
          : await ctx.ui.input(
              title,
              'Answer the questions in the card above, then submit.'
            )
      const answers = []
      let parsed
      try {
        parsed = value === undefined ? null : (JSON.parse(value) as unknown)
      } catch {
        parsed = null
      }
      if (!Array.isArray(parsed)) {
        params.questions.forEach((question) => {
          answers.push({ question: question.question, dismissed: true, answer: [] })
        })
        return textResult({ answers })
      }
      params.questions.forEach((question, index) => {
        const entry = parsed[index]
        if (!Array.isArray(entry)) {
          answers.push({ question: question.question, dismissed: true, answer: [] })
          return
        }
        answers.push({
          question: question.question,
          dismissed: false,
          answer: entry.filter((part) => typeof part === 'string')
        })
      })
      return textResult({ answers })
    }
  })

  pi.registerTool({
    name: '${CIO_TODO_WRITE_TOOL_NAME}',
    label: 'Write the todo list',
    description:
      'Create or update the visible todo list so the user can track progress. Replace the whole list on every call: give every task with its current status (pending, in_progress, or completed). Mark tasks in_progress just before starting and completed immediately after finishing.',
    promptSnippet: 'Publish or update the shared todo list (task tracking)',
    promptGuidelines: [
      'Use ${CIO_TODO_WRITE_TOOL_NAME} as soon as a task spans multiple steps: publish the full plan, keep exactly one task in_progress, and update statuses as work advances.'
    ],
    parameters: Type.Object({
      todos: Type.Array(
        Type.Object({
          id: Type.Optional(Type.String({ description: 'Stable task id; omit to derive from content.' })),
          content: Type.String({ description: 'The task label.' }),
          status: Type.Union([
            Type.Literal('pending'),
            Type.Literal('in_progress'),
            Type.Literal('completed')
          ])
        }),
        { description: 'The full task list (replaces the previous one).', minItems: 1 }
      )
    }),
    async execute(_toolCallId, params) {
      const todos = params.todos.map((todo, index) => ({
        id: todo.id || 'todo-' + (index + 1) + '-' + todo.content,
        content: todo.content,
        status: todo.status
      }))
      const active = todos.find((todo) => todo.status === 'in_progress')
      return textResult({
        todos,
        summary: active ? 'Working on: ' + active.content : 'No task marked in_progress.'
      })
    }
  })

  pi.registerTool({
    name: '${CIO_REQUEST_FILES_TOOL_NAME}',
    label: 'Request files from the user',
    description:
      'Ask the user to share files by typing their paths. The paths are validated against the filesystem and returned so you can read them. Use this when the work needs files that are not yet in the conversation.',
    promptSnippet: 'Ask the user to share file paths and receive a validated file list',
    promptGuidelines: [
      'Use ${CIO_REQUEST_FILES_TOOL_NAME} when the task needs files the user has not shared yet; pass a clear message about which files and formats help.'
    ],
    parameters: Type.Object({
      message: Type.Optional(
        Type.String({ description: 'Why the files are needed and what formats help.' })
      ),
      suggested_paths: Type.Optional(
        Type.Array(Type.String(), { description: 'Likely paths to suggest in the prompt.' })
      )
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const detail = params.message ? params.message : 'Type the file paths to share.'
      const hint = Array.isArray(params.suggested_paths) && params.suggested_paths.length > 0
        ? ' For example: ' + params.suggested_paths.join(', ')
        : ''
      const value = await ctx.ui.input(
        'Share files with the agent',
        detail + ' Separate multiple paths with commas.' + hint
      )
      if (value === undefined) {
        return textResult({ requested: false, message: 'The user dismissed the file request.' })
      }
      const requested = value
        .split(/[,\\n]/u)
        .map((part) => part.trim())
        .filter(Boolean)
      const files = requested.map((path) => {
        const absolutePath = isAbsolute(path) ? resolve(path) : resolve(ctx.cwd, path)
        return {
          path,
          absolutePath,
          exists: existsSync(absolutePath),
          insideProject: !isOutsideCwd(absolutePath, ctx.cwd)
        }
      })
      return textResult({
        requested: true,
        files,
        note: files.every((file) => !file.exists)
          ? 'None of the given paths exist; ask the user to double-check them.'
          : 'Read the existing files before continuing.'
      })
    }
  })

  // ── Sub-agent spawning ──────────────────────────────────────────────
  // Sub-agents are nested pi sessions ("worker threads") controlled by the
  // primary agent. They never receive the spawn tool, so they cannot
  // recurse; their permission requests ride the parent's extension-UI
  // context so the permission card appears on the primary thread.
  const CIO_SUBAGENT_MARKER = 'cio-subagent:'
  const CIO_SUBAGENT_MAX_CONCURRENT = 4
  const CIO_SUBAGENT_OUTPUT_CAP = 20000
  const CIO_SUBAGENT_THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  const subAgents = new Map()
  let subAgentCounter = 0

  function capOutput(text) {
    return text.length > CIO_SUBAGENT_OUTPUT_CAP
      ? text.slice(0, CIO_SUBAGENT_OUTPUT_CAP) + '\\n…(output truncated)'
      : text
  }

  function subAgentText(message) {
    const content = Array.isArray(message && message.content) ? message.content : []
    const parts = []
    for (const block of content) {
      if (block && block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        parts.push(block.text.trim())
      }
    }
    return parts.join('\\n\\n')
  }

  function subAgentFiles(record) {
    const files = Array.isArray(record.files) ? record.files : []
    return files.slice().sort()
  }

  function subAgentPayload(record) {
    return {
      agentId: record.agentId,
      purpose: record.purpose,
      childSessionId: record.childSessionId,
      ...(record.sessionFile ? { sessionFile: record.sessionFile } : {}),
      status: record.status,
      ...(record.modelId ? { model: record.modelId } : {}),
      thinkingLevel: record.thinkingLevel,
      ...(record.error ? { error: record.error } : {}),
      files: subAgentFiles(record),
      output: record.output
    }
  }

  function sendSubAgentUpdate(onUpdate, record) {
    if (!onUpdate) return
    try {
      onUpdate({
        content: [
          { type: 'text', text: CIO_SUBAGENT_MARKER + JSON.stringify(subAgentPayload(record)) }
        ]
      })
    } catch {}
  }

  /**
   * What the primary agent receives: metadata plus ONLY the sub-agent's
   * final message — never the running transcript. The full transcript stays
   * in the sub-agent's own session, viewable in the UI.
   */
  function subAgentResult(record) {
    return {
      agentId: record.agentId,
      purpose: record.purpose,
      childSessionId: record.childSessionId,
      ...(record.sessionFile ? { sessionFile: record.sessionFile } : {}),
      status: record.status,
      ...(record.modelId ? { model: record.modelId } : {}),
      thinkingLevel: record.thinkingLevel,
      ...(record.error ? { error: record.error } : {}),
      files: subAgentFiles(record),
      output: record.finalOutput || record.output,
      ...(record.endedAt ? { durationMs: record.endedAt - record.startedAt } : {})
    }
  }

  /**
   * Steer the primary agent when a background sub-agent finishes. Uses a
   * display:false custom message: it reaches the model as a user-role
   * context message (with the final output) but never shows in the
   * transcript — the driver ignores custom-role messages. While the primary
   * is streaming this steers the current run; when idle it triggers a turn.
   */
  function notifySubAgentDone(record) {
    if (!pi || typeof pi.sendMessage !== 'function') return
    const files = subAgentFiles(record)
    const text =
      'Sub-agent done for task ' + record.purpose + ' (' + record.agentId + ', status: ' + record.status + ').' +
      (record.error ? ' Error: ' + record.error : '') +
      (files.length > 0 ? '\\n\\nFiles it worked on (you are responsible for committing approved work): ' + files.join(', ') : '') +
      '\\n\\nThis is the final output of the sub-agent — use it as you continue your work:\\n\\n' +
      (record.finalOutput || record.output || '(the sub-agent produced no text output)')
    try {
      void pi.sendMessage(
        { customType: 'cio-subagent-done', content: text, display: false },
        { triggerTurn: true, deliverAs: 'steer' }
      )
    } catch {}
  }

  async function resolveSubAgentModel(parentCtx, reference) {
    const registry = parentCtx.modelRegistry
    const slashIndex = reference.indexOf('/')
    if (slashIndex > 0) {
      const found = registry.find(reference.slice(0, slashIndex), reference.slice(slashIndex + 1))
      if (found) return found
    }
    const available = registry.getAvailable()
    const byId = available.find(function (candidate) { return candidate.id === reference })
    if (byId) return byId
    const all = registry.getAll()
    return (
      all.find(function (candidate) { return candidate.id === reference }) ??
      // Case-insensitive fallback: model ids arrive from free-form tool args.
      all.find(function (candidate) {
        return candidate.id.toLowerCase() === reference.toLowerCase()
      })
    )
  }

  /** Built-in worker tools wrapped with the same permission gate as the primary. */
  function gatedWorkerTools(parentCtx, touchedFiles) {
    async function gate(toolName, params) {
      const hit = evaluateGate(toolName, recordValue(params) ?? {}, parentCtx.cwd)
      if (!hit) return null
      const payload = {
        permission: hit.permission,
        patterns: hit.patterns,
        tool: toolName,
        subagent: true,
        ...(hit.command === undefined ? {} : { command: hit.command })
      }
      const approved = await parentCtx.ui.confirm(
        'Sub-agent needs permission: ' + hit.reason,
        CIO_PERMISSION_MARKER + JSON.stringify(payload)
      )
      if (approved) return null
      return (
        'The user denied this sub-agent action in the permission card because it is destructive (' +
        hit.reason +
        '). Do not retry it as-is; continue with a safe alternative.'
      )
    }
    const builtins = [
      createReadToolDefinition(parentCtx.cwd),
      createBashToolDefinition(parentCtx.cwd),
      createEditToolDefinition(parentCtx.cwd),
      createWriteToolDefinition(parentCtx.cwd)
    ]
    return builtins.map(function (definition) {
      const inner = definition.execute.bind(definition)
      return {
        ...definition,
        async execute(toolCallId, params, signal, onUpdate, ctx) {
          const denial = await gate(definition.name, params)
          if (denial) {
            return { content: [{ type: 'text', text: denial }] }
          }
          // Track every file the worker edits or writes so the primary can
          // commit the work; shell-created files are reported by the worker
          // in its final message instead.
          if (
            touchedFiles &&
            (definition.name === 'edit' || definition.name === 'write') &&
            typeof params === 'object' &&
            params !== null &&
            typeof params.path === 'string' &&
            !touchedFiles.includes(params.path)
          ) {
            touchedFiles.push(params.path)
          }
          return inner(toolCallId, params, signal, onUpdate, ctx)
        }
      }
    })
  }

  async function runSubAgent(parentCtx, onUpdate, spec, signal) {
    let runningCount = 0
    for (const record of subAgents.values()) {
      if (record.status === 'running') runningCount += 1
    }
    if (runningCount >= CIO_SUBAGENT_MAX_CONCURRENT) {
      return {
        error:
          'Too many sub-agents are running (' + CIO_SUBAGENT_MAX_CONCURRENT + ' max). Collect finished results with ${CIO_AGENT_STATUS_TOOL_NAME} before spawning another.'
      }
    }
    let resolvedModel = parentCtx.model
    if (spec.model) {
      resolvedModel = await resolveSubAgentModel(parentCtx, spec.model)
      if (!resolvedModel) return { error: 'Model not found: ' + spec.model }
    }
    subAgentCounter += 1
    const agentId = 'cio-subagent-' + subAgentCounter
    // Declared before the session is built: gatedWorkerTools receives this
    // array at creation time, so it must not sit in the temporal dead zone.
    const touchedFiles = []
    let session
    try {
      const sessionDir = process.env.CIO_SUBAGENT_SESSION_DIR
      const sessionManager = sessionDir
        ? SessionManager.create(parentCtx.cwd, sessionDir)
        : SessionManager.create(parentCtx.cwd)
      const created = await createAgentSession({
        cwd: parentCtx.cwd,
        sessionManager,
        ...(resolvedModel ? { model: resolvedModel } : {}),
        ...(spec.thinkingLevel ? { thinkingLevel: spec.thinkingLevel } : {}),
        tools: ['read', 'bash', 'edit', 'write'],
        customTools: gatedWorkerTools(parentCtx, touchedFiles)
      })
      session = created.session
    } catch (error) {
      return {
        error:
          'Failed to start the sub-agent session: ' +
          (error && error.message ? error.message : String(error))
      }
    }
    // App-managed custom providers live only in the primary session's model
    // registry; mirror them so the sub-agent resolves the same models.
    for (const providerId of parentCtx.modelRegistry.getRegisteredProviderIds()) {
      const config = parentCtx.modelRegistry.getRegisteredProviderConfig(providerId)
      if (!config) continue
      try {
        session.modelRuntime.registerProvider(providerId, config)
      } catch {}
    }
    const record = {
      agentId,
      purpose: spec.purpose,
      childSessionId: session.sessionId,
      sessionFile: session.sessionFile,
      modelId: resolvedModel ? resolvedModel.provider + '/' + resolvedModel.id : '',
      thinkingLevel: spec.thinkingLevel ?? parentCtx.thinkingLevel ?? 'medium',
      status: 'running',
      output: '',
      files: touchedFiles,
      startedAt: Date.now(),
      session
    }
    subAgents.set(agentId, record)
    const onAbort = function () {
      void session.abort()
    }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    session.subscribe(function (event) {
      if (event.type !== 'message_end') return
      const text = subAgentText(event.message)
      if (!text) return
      record.output = capOutput(record.output ? record.output + '\\n\\n' + text : text)
      sendSubAgentUpdate(onUpdate, record)
    })
    record.promise = (async function () {
      try {
        await session.prompt(spec.instructions, { expandPromptTemplates: false })
        record.status = 'completed'
      } catch (error) {
        record.status = 'error'
        record.error = error && error.message ? error.message : String(error)
      } finally {
        // Only the sub-agent's final message goes back to the primary agent;
        // the accumulated output stays a live preview for the UI card.
        record.finalOutput = capOutput(subAgentText(lastAssistant(session)))
        record.endedAt = Date.now()
        sendSubAgentUpdate(onUpdate, record)
        // Background workers announce themselves; foreground spawns are
        // awaited inline by the primary and need no notification.
        if (spec.background) notifySubAgentDone(record)
      }
    })()
    return { record }
  }

  function lastAssistant(session) {
    for (let index = session.messages.length - 1; index >= 0; index -= 1) {
      const message = session.messages[index]
      if (message && message.role === 'assistant') return message
    }
    return null
  }

  function workerPrompt(spec) {
    return [
      'You are a CodeInOven sub-agent spawned by the primary agent to own one focused piece of work.',
      'Purpose: ' + spec.purpose + '.',
      'The user does not chat with you directly: your final message is returned to the primary agent, which reports to the user.',
      'Work autonomously and do not ask the user questions. Permission requests for destructive actions are surfaced to the user on the primary thread.',
      'Your final message MUST list every file you created or modified (relative to the project root), including files changed through shell commands — the primary agent is responsible for committing the work and needs this list.',
      '',
      'Instructions from the primary agent:',
      '',
      spec.instructions
    ].join('\\n')
  }

  pi.registerTool({
    name: '${CIO_SPAWN_AGENT_TOOL_NAME}',
    label: 'Spawn a sub-agent',
    description:
      'Spawn a sub-agent worker thread that executes one focused task (explore, implementation, tests, cleanup, documentation, or any custom purpose) and returns only its final result, keeping its transcript out of your context. By default — unless the user explicitly asks you to use sub-agents differently — delegate any task that can run in parallel with your own work to a sub-agent: explore or research a topic while you continue working, hand off long-running work so you can proceed without waiting and without polluting your context, and once your own work is done, spawn a sub-agent to run the checks for the files you touched (lint, typecheck, tests) so the work finishes faster. Run several sub-agents concurrently with background:true — each one automatically steers you a notification with its final output the moment it finishes, so you can keep working and act on results as they land. Omit background to block until the sub-agent finishes and returns its result directly — use that whenever you need the output before proceeding. You must never end your turn while any sub-agent is still running, regardless of outcome; workers report every file they touched because you are responsible for committing approved work. Sub-agents cannot spawn further sub-agents, and they inherit your model and thinking level unless you pass model/thinking_level overrides.',
    promptSnippet: 'Spawn sub-agent worker threads for focused or parallelizable tasks (explore, implement, tests, cleanup, docs)',
    promptGuidelines: [
      'By default, delegate parallelizable tasks to sub-agents instead of doing them inline: exploring a topic while you keep working, handing off work so you can continue without polluting your context, or running post-work checks (lint, typecheck, tests) for the files you touched.',
      'Give each sub-agent complete, self-contained instructions; spawn separate sub-agents for independent work and collect results with ${CIO_AGENT_STATUS_TOOL_NAME}. Never end your turn while sub-agents are still running — wait for every result (successful or failed) with ${CIO_AGENT_STATUS_TOOL_NAME} (wait: true) first, because the primary agent owns committing the files the workers changed.'
    ],
    parameters: Type.Object({
      purpose: Type.String({
        description: 'Short task category, e.g. explore, implementation, tests, cleanup, documentation.'
      }),
      instructions: Type.String({
        description: 'The complete, self-contained task instructions for the sub-agent.'
      }),
      model: Type.Optional(
        Type.String({
          description:
            "Model override as 'provider/model-id' or a model id. Defaults to the primary agent's model."
        })
      ),
      thinking_level: Type.Optional(
        Type.Union(CIO_SUBAGENT_THINKING_LEVELS.map(function (level) { return Type.Literal(level) }), {
          description:
            "Thinking-level override. Defaults to the primary agent's thinking level."
        })
      ),
      background: Type.Optional(
        Type.Boolean({
          description:
            'Run in the background and return immediately; the finished sub-agent steers you its final output automatically.'
        })
      )
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const spec = {
        purpose: params.purpose,
        instructions: params.instructions,
        model: params.model,
        thinkingLevel: params.thinking_level,
        background: params.background === true
      }
      const result = await runSubAgent(ctx, onUpdate, spec, signal ?? undefined)
      if (result.error) {
        return textResult({ spawned: false, error: result.error })
      }
      if (spec.background) {
        return textResult({
          spawned: true,
          agentId: result.record.agentId,
          childSessionId: result.record.childSessionId,
          status: result.record.status,
          note: 'Sub-agent is running in the background. When it finishes you will receive a steer message (sub-agent done for task …) carrying its final output — keep working until then; ${CIO_AGENT_STATUS_TOOL_NAME} (wait: true) is available for explicit polling.'
        })
      }
      await result.record.promise
      return textResult(subAgentResult(result.record))
    }
  })

  pi.registerTool({
    name: '${CIO_AGENT_STATUS_TOOL_NAME}',
    label: 'Check sub-agent status',
    description:
      'Check the status and output of spawned sub-agent threads. Background sub-agents steer you a completion notification with their final output automatically; use this tool to poll explicitly, or wait:true to block until every running sub-agent finishes (with or without a specific agent_id) — always do this before ending your turn so no result is lost.',
    promptSnippet: 'Check or wait for spawned sub-agent threads and collect their results',
    promptGuidelines: [
      'Background sub-agents announce completion themselves with a steer message containing their final output; use ${CIO_AGENT_STATUS_TOOL_NAME} to poll explicitly, with wait:true before finishing the turn so no result is lost.'
    ],
    parameters: Type.Object({
      agent_id: Type.Optional(
        Type.String({ description: 'A specific sub-agent id. Omit to report all sub-agents.' })
      ),
      wait: Type.Optional(
        Type.Boolean({
          description:
            'Wait for running sub-agents to finish (success or failure) before returning.'
        })
      )
    }),
    async execute(_toolCallId, params) {
      const wait = params.wait === true
      let records
      if (params.agent_id) {
        const record = subAgents.get(params.agent_id)
        if (!record) {
          return textResult({ found: false, error: 'Unknown sub-agent id: ' + params.agent_id })
        }
        records = [record]
      } else {
        records = [...subAgents.values()]
        if (records.length === 0) {
          return textResult({ agents: [], note: 'No sub-agents have been spawned in this session.' })
        }
      }
      if (wait) {
        const running = records.filter(function (record) { return record.status === 'running' })
        if (running.length > 0) {
          await Promise.all(running.map(function (record) { return record.promise }))
        }
      }
      return textResult({ agents: records.map(function (record) { return subAgentResult(record) }) })
    }
  })

  // Abort every live sub-agent when the owning session shuts down.
  pi.on('session_shutdown', async () => {
    for (const record of subAgents.values()) {
      if (record.status === 'running') {
        try {
          await record.session.abort()
        } catch {}
      }
    }
  })

  // Turn-end guard: the primary must never finish its work while sub-agents
  // are still running. When a run settles with live workers, wake the agent
  // with a fresh turn instructing it to collect every result (completed or
  // failed) before finishing. Loop terminates because the wait blocks until
  // the workers resolve.
  pi.on('agent_settled', async () => {
    const running = []
    for (const record of subAgents.values()) {
      if (record.status === 'running') {
        running.push(record.purpose + ' (' + record.agentId + ')')
      }
    }
    if (running.length === 0) return
    if (!pi || typeof pi.sendMessage !== 'function') return
    try {
      void pi.sendMessage(
        {
          customType: 'cio-subagent-wait',
          content:
            'Your turn ended while sub-agents are still running: ' +
            running.join(', ') +
            '. Do not finish your work yet. Call ${CIO_AGENT_STATUS_TOOL_NAME} with agent_id set to each running id (or omit agent_id) and wait:true to block until they finish, then incorporate every result — successful or failed — before ending your turn. Sub-agents report the files they changed; you are responsible for committing approved work.',
          display: false
        },
        { triggerTurn: true }
      )
    } catch {}
  })

  // Deliver the CodeInOven-composed instructions as a real system-role field
  // instead of duplicating them inside every user turn's text (see
  // loadCioSystemPrompt above for why).
  pi.on('before_agent_start', (event) => {
    const extra = loadCioSystemPrompt()
    const isProjectMode = extra.includes(CIO_PROJECT_MODE_MARKER)
    const base =
      isProjectMode && event.systemPrompt.includes(PI_ASSISTANT_IDENTITY_LINE)
        ? event.systemPrompt.replace(PI_ASSISTANT_IDENTITY_LINE, CIO_AGENT_IDENTITY_LINE)
        : event.systemPrompt
    if (base === event.systemPrompt && !extra) return undefined
    return { systemPrompt: extra ? base + '\\n\\n' + extra : base }
  })

  // Permission gate: destructive tool calls require an explicit permission
  // card. The confirm dialog's message carries the structured payload behind
  // the shared marker; the CodeInOven driver upgrades it into a real
  // permission request. In full-access mode the app auto-approves, so gating
  // stays transparent there.
  pi.on('tool_call', async (event, ctx) => {
    const input = recordValue(event.input) ?? {}
    const contaminated = findContaminatedToolArg(input)
    if (contaminated) {
      return {
        block: true,
        reason:
          'This tool call was not executed: its "' +
          contaminated.key +
          '" argument contains "' +
          contaminated.marker +
          '", meaning the previous response stream did not terminate the tool call cleanly and leaked raw text (reasoning, or a second tool-call attempt) into the argument. This is a streaming artifact, not a real command or file content, and not evidence of prompt injection or a fabricated transcript. Re-issue this tool call now with a single, clean argument containing only the intended command/content, and continue normally.'
      }
    }
    const hit = evaluateGate(event.toolName, input, ctx.cwd)
    if (!hit) return undefined
    const payload = {
      permission: hit.permission,
      patterns: hit.patterns,
      tool: event.toolName,
      ...(hit.command === undefined ? {} : { command: hit.command })
    }
    const approved = await ctx.ui.confirm(
      'Permission needed: ' + hit.reason,
      CIO_PERMISSION_MARKER + JSON.stringify(payload)
    )
    if (approved) return undefined
    return {
      block: true,
      reason:
        'The user denied this action in the permission card because it is destructive (' +
        hit.reason +
        '). Do not retry it as-is; continue the turn with a safe alternative.'
    }
  })
}
`
}
