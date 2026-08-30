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
 * The marker constant is shared with the driver: `CIO_PERMISSION_MARKER`.
 */

export const CIO_PERMISSION_MARKER = 'cio-permission:'

/** Tool names registered by the core-tools extension (exported for tests). */
export const PI_CORE_TOOLS_TOOL_NAMES = [
  'cio_ask_user',
  'cio_todo_write',
  'cio_request_files'
] as const

export function piCoreToolsExtension(): string {
  return `import { existsSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

const CIO_PERMISSION_MARKER = 'cio-permission:'

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

export default function codeInOvenCoreToolsExtension(pi) {
  pi.registerTool({
    name: 'cio_ask_user',
    label: 'Ask the user a question',
    description:
      'Ask the user one or more structured questions and wait for their answers. Each question may offer predefined answer options or free text. Use this whenever a decision, preference, or clarification is needed before continuing.',
    promptSnippet: 'Ask the user structured questions (options or free text) and wait for answers',
    promptGuidelines: [
      'Use cio_ask_user when a decision, preference, or clarification from the user is needed before continuing.',
      'Provide short option labels with a separate question field; keep each question self-contained.'
    ],
    parameters: Type.Object({
      questions: Type.Array(
        Type.Object({
          question: Type.String({ description: 'The question text.' }),
          header: Type.Optional(Type.String({ description: 'Very short label (max 30 chars).' })),
          description: Type.Optional(Type.String({ description: 'Optional background context.' })),
          options: Type.Optional(
            Type.Array(Type.String(), { description: 'Predefined answer options.' })
          ),
          multiple: Type.Optional(
            Type.Boolean({ description: 'Allow multiple options to be selected.' })
          )
        }),
        { description: 'Questions to ask, in order.', minItems: 1 }
      )
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const answers = []
      for (const question of params.questions) {
        const prompt = question.header
          ? question.header + ': ' + question.question
          : question.question
        let value
        if (Array.isArray(question.options) && question.options.length > 0 && !question.multiple) {
          value = await ctx.ui.select(prompt, question.options)
        } else {
          const placeholder = Array.isArray(question.options) && question.options.length > 0
            ? 'Choose one or more, separated by commas: ' + question.options.join(', ')
            : 'Type your answer'
          value = await ctx.ui.input(prompt, placeholder)
        }
        if (value === undefined) {
          answers.push({ question: question.question, dismissed: true, answer: [] })
          continue
        }
        const parts = value
          .split(question.multiple ? /[,\\n]/u : /\\n/u)
          .map((part) => part.trim())
          .filter(Boolean)
        answers.push({ question: question.question, dismissed: false, answer: parts })
      }
      return textResult({ answers })
    }
  })

  pi.registerTool({
    name: 'cio_todo_write',
    label: 'Write the todo list',
    description:
      'Create or update the visible todo list so the user can track progress. Replace the whole list on every call: give every task with its current status (pending, in_progress, or completed). Mark tasks in_progress just before starting and completed immediately after finishing.',
    promptSnippet: 'Publish or update the shared todo list (task tracking)',
    promptGuidelines: [
      'Use cio_todo_write as soon as a task spans multiple steps: publish the full plan, keep exactly one task in_progress, and update statuses as work advances.'
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
    name: 'cio_request_files',
    label: 'Request files from the user',
    description:
      'Ask the user to share files by typing their paths. The paths are validated against the filesystem and returned so you can read them. Use this when the work needs files that are not yet in the conversation.',
    promptSnippet: 'Ask the user to share file paths and receive a validated file list',
    promptGuidelines: [
      'Use cio_request_files when the task needs files the user has not shared yet; pass a clear message about which files and formats help.'
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

  // Permission gate: destructive tool calls require an explicit permission
  // card. The confirm dialog's message carries the structured payload behind
  // the shared marker; the CodeInOven driver upgrades it into a real
  // permission request. In full-access mode the app auto-approves, so gating
  // stays transparent there.
  pi.on('tool_call', async (event, ctx) => {
    const input = recordValue(event.input) ?? {}
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
