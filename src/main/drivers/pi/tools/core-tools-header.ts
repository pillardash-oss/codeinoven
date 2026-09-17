/**
 * Header of the generated Pi core-tools extension: imports, shared constants, permission-gate rule tables, helper functions, and the extension function opener.
 *
 * The returned text is one fragment of the generated core-tools extension
 * source; pi-core-tools-extension.ts concatenates every fragment in order so
 * the emitted module is byte-for-byte identical to the original single string.
 */
import {
  CIO_AGENT_OUTPUT_TOOL_NAME,
  CIO_AGENT_STATUS_TOOL_NAME,
  CIO_SPAWN_AGENT_TOOL_NAME
} from '../../../../lib/core-tools'

export function piCoreToolsHeaderSource(): string {
  return `import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
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
const CIO_ALLOWED_TOOLS_PATH = '__CIO_ALLOWED_TOOLS_PATH__'

// The tools pi bundles itself. When the driver hands this session a tool
// allowlist (File-System-OFF chat threads), every call to one of these that
// the allowlist does not name is routed through the permission card so the
// app's policy can auto-approve attached files and ask for everything else.
// Interactive custom tools (question, todo, file requests, gateway) are never
// restricted here.
const CIO_PI_BUILTIN_TOOLS = new Set([
  'read',
  'write',
  'edit',
  'bash',
  'grep',
  'find',
  'ls',
  'powershell'
])

// Sub-agent tools belong to an unrestricted primary session. Any session that
// publishes a tool allowlist (audits, read-only prompt turns, filesystem-off
// chat, brainstorm turns) never gets them: an auditor has to run every check
// itself, and a restricted scope must not be able to open a full-access
// worker. The allowlist names them explicitly if a future scope needs them.
const CIO_SUBAGENT_TOOL_NAMES = new Set([
  '${CIO_SPAWN_AGENT_TOOL_NAME}',
  '${CIO_AGENT_STATUS_TOOL_NAME}',
  '${CIO_AGENT_OUTPUT_TOOL_NAME}'
])

// The sub-agent prompt text lives in one place so a scoped session can drop the
// exact lines from its base prompt before the model ever sees them.
const CIO_SUBAGENT_PROMPT_GUIDELINES = [
  'By default, delegate parallelizable tasks to sub-agents instead of doing them inline: exploring a topic while you keep working, handing off work so you can continue without polluting your context, or running post-work checks (lint, typecheck, tests) for the files you touched.',
  'Give each sub-agent complete, self-contained instructions; spawn separate sub-agents for independent work. Never end your turn while sub-agents are still running: wait with ${CIO_AGENT_STATUS_TOOL_NAME} (wait: true), then read every finished worker with ${CIO_AGENT_OUTPUT_TOOL_NAME}   successful or failed   because the primary agent owns committing the files the workers changed.'
]

// Pi's own bundled system prompt opens with a "you are an assistant" framing
// that pushes models toward generic chatbot hedging (permission-seeking,
// disclaiming, "I should be cautious") instead of acting as an autonomous
// engineering agent. This only gets swapped for genuine project-thread work
// (Engineering and regular project chats with full workspace scope), never
// for plain/temporary chat or file-system-enabled chat threads   those are
// still meant to read as a chat assistant, not an autonomous engineering
// agent. The full workspace-scope block (buildWorkspaceContext in
// prompt-assembler.ts) is the only prompt layer that ever contains this
// marker line, so its presence is the reliable "this is project mode, not
// chat mode" signal.
const CIO_PROJECT_MODE_MARKER = 'WORKING SCOPE   this overrides ambiguous instructions:'
const PI_ASSISTANT_IDENTITY_LINE =
  'You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.'
const CIO_AGENT_IDENTITY_LINE =
  'You are the agentic engine driving CodeInOven, an Agentic Development Environment (ADE) for autonomous software engineering   not a chat assistant. You act directly: read files, execute commands, edit code, and write new files to complete real engineering work end to end on the open project, without waiting for permission to do what you were already asked to do.'

// The driver rewrites this file per turn with the CodeInOven-composed
// instructions (work ethic, persistent preferences, working scope, skills).
// Reading it here and returning it from before_agent_start delivers it as a
// real system-role field on every request, instead of the driver
// concatenating it into the user turn's text   which replayed the same
// multi-kilobyte block inside every "user" message and made models mistake
// the repeated block for injected/duplicated content.
function loadCioSystemPrompt() {
  try {
    return readFileSync(CIO_SYSTEM_PROMPT_PATH, 'utf8').trim()
  } catch {
    return ''
  }
}

// The driver rewrites this file per turn with the session's allowed built-in
// tool names (empty JSON array = unrestricted). Read at every tool call so a
// File-System toggle takes effect without restarting the pi session.
function loadCioAllowedTools() {
  try {
    const raw = readFileSync(CIO_ALLOWED_TOOLS_PATH, 'utf8').trim()
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(function (entry) {
      return typeof entry === 'string'
    })
  } catch {
    return []
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

// Recursive or bulk deletes   flat out denied without explicit approval.
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

// Worktree lifecycle belongs to CodeInOven. A raw linked worktree is invisible
// to the scope board, its health checks, its environment propagation and its
// sync tooling, so creating or removing one by hand has to be the user's
// explicit decision. The app's own route is the scope capability behind the
// utility gateway, which the agent discovers by searching for it.
const RAW_WORKTREE_RULES: DenyRule[] = [
  {
    pattern: /(?:^|[;&|]\\s*)git\\s+worktree\\s+(?:add|remove|move|lock|unlock|prune)\\b/u,
    label:
      'a raw git worktree command (use the app-managed scope capability through the utility gateway instead)'
  }
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

const CIO_INTRINSIC_SKILL_ROOTS = [
  join(homedir(), '.agents', 'skills'),
  join(homedir(), '.pi', 'agent', 'skills')
]

function isWithinPath(candidatePath, root) {
  const rel = relative(root, resolve(candidatePath))
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel))
}

// Shared and Pi-native skills are part of the harness runtime, not user file
// access. Resolve these reads before any permission gate so no session mode
// flashes a card, races an asynchronous auto-approval, or blocks a read-only
// chat that only wants to load the skill its turn matches.
function isIntrinsicSkillRead(toolName, input, cwd) {
  if (!['read', 'grep', 'find', 'ls'].includes(toolName)) return false
  const rawPath = firstString(input['path'], input['file_path'], input['filePath'], input['filename'])
  if (!rawPath) return false
  const candidate = isAbsolute(rawPath) ? resolve(rawPath) : resolve(cwd, rawPath)
  return CIO_INTRINSIC_SKILL_ROOTS.some(function (root) {
    return isWithinPath(candidate, root)
  })
}

// Filesystem-off chat still has ordinary internet access. Permit an HTTP curl
// request, including quoted query strings and escaped multiline commands, when
// it has no shell composition, interpolation, local-file input, upload, or
// output flags. Broader shell use remains gated.
function hasUnsafeCurlShellSyntax(command) {
  let quote = ''
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]
    if (character === '\\n' || character === '\\r') return true
    if (character === '\\\\') {
      if (command[index + 1] === '\\n') {
        index += 1
        continue
      }
      if (command[index + 1] === '\\r' && command[index + 2] === '\\n') {
        index += 2
        continue
      }
      if (quote !== "'") index += 1
      continue
    }
    if (character === "'" && quote !== '"') {
      quote = quote === "'" ? '' : "'"
      continue
    }
    if (character === '"' && quote !== "'") {
      quote = quote === '"' ? '' : '"'
      continue
    }
    if (quote === "'") continue
    if (character.charCodeAt(0) === 96) return true
    if (character === '$' && /[({A-Za-z_]/u.test(command[index + 1] ?? '')) return true
    if (!quote && /[;&|<>]/u.test(character)) return true
  }
  return quote !== ''
}

function isSafeNetworkCurl(toolName, input) {
  if (toolName !== 'bash' || typeof input['command'] !== 'string') return false
  const command = input['command'].trim()
  if (!/^curl(?:\\s|$)/u.test(command)) return false
  if (hasUnsafeCurlShellSyntax(command)) return false
  if (!/https?:\\/\\//iu.test(command) || /file:\\/\\//iu.test(command)) return false
  if (/(?:^|\\s)(?:-o|-O|--output|--remote-name|--remote-header-name|--output-dir|-T|--upload-file|-K|--config|--unix-socket|--netrc-file|--cookie|--cookie-jar|--cert|--key|--cacert|--capath)(?:\\s|=|$)/u.test(command)) return false
  return !/(?:^|\\s)(?:-d|--data|--data-ascii|--data-binary|--data-raw|--data-urlencode|--json|--form|-F)(?:\\s|=)["']?[^\\s"']*@/u.test(command)
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
// mid-stream: the model keeps emitting raw text   its own reasoning, a
// second tool-call attempt in the model's native pseudo-XML tool syntax
// (<tool_call>...<arg_key>...</arg_key><arg_value>...)   and it all lands
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
    for (const rule of RAW_WORKTREE_RULES) {
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
  // Disable the sub-agent tools whenever this session published a tool
  // allowlist that does not name them. Pi drops an inactive tool from the
  // request, so its description and guidelines leave the prompt too, and the
  // model stops treating delegation as an option. Called on session start and
  // before every agent start, so a scope change applies to the next turn
  // without restarting the pi session.
  function applyCioSubAgentScope() {
    const allowedTools = loadCioAllowedTools()
    if (allowedTools.length === 0) return
    if (allowedTools.some(function (name) { return CIO_SUBAGENT_TOOL_NAMES.has(name) })) return
    const active = pi.getActiveTools()
    const scoped = active.filter(function (name) { return !CIO_SUBAGENT_TOOL_NAMES.has(name) })
    if (scoped.length === active.length) return
    pi.setActiveTools(scoped)
  }

  // Pi builds the base prompt before this turn's scope is published, so the
  // first request of a fresh scoped session still advertised the sub-agent
  // tools and their "delegate by default" guidance. Drop those exact lines from
  // the prompt text as well, on top of disabling the tools above.
  function stripCioSubAgentPrompt(prompt) {
    const allowedTools = loadCioAllowedTools()
    if (allowedTools.length === 0) return prompt
    if (allowedTools.some(function (name) { return CIO_SUBAGENT_TOOL_NAMES.has(name) })) return prompt
    const lines = prompt.split('\\n')
    const kept = lines.filter(function (line) {
      const trimmed = line.trim()
      const entry = /^- ([a-z0-9_]+):/.exec(trimmed)
      if (entry && CIO_SUBAGENT_TOOL_NAMES.has(entry[1])) return false
      return !CIO_SUBAGENT_PROMPT_GUIDELINES.some(function (guideline) {
        return trimmed === '- ' + guideline
      })
    })
    return kept.length === lines.length ? prompt : kept.join('\\n')
  }

`
}
