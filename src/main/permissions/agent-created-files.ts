/**
 * File targets of an agent's own write and delete calls.
 *
 * Auto Review lets an agent remove a file it created itself, wherever it put
 * it: a throwaway probe script, a staged package, a scratch note in `/tmp`.
 * The block list exists to protect work the session does not own, and a file
 * the session just made is not that.
 *
 * Two facts are needed to decide that, and this module owns both without
 * touching the file system so callers stay in control of I/O:
 *
 *  - what a tool call creates (`agentCreationTargets`), so the chat engine can
 *    remember the paths a session brought into existence, and
 *  - what a delete request removes (`deletionTargets`), so the permission
 *    policy can check it against that remembered set.
 *
 * Everything here is deliberately conservative. A command that carries a glob,
 * a variable, or a command substitution hides its targets, so it yields
 * `undefined` and the ordinary card still asks. Only a call whose targets are
 * fully readable qualifies.
 */
import { basename, isAbsolute, resolve } from 'path'
import { toPosixPath } from '../../lib/paths'

/** Tool names whose input names a file the call creates, compared after
 *  `normalizeToolName` (lower case, separators removed). */
const CREATION_TOOLS = new Set([
  'write',
  'writefile',
  'createfile',
  'newfile',
  'savefile',
  'putfile'
])

/** Tool names that run a shell command string, normalized the same way. */
const SHELL_TOOLS = new Set([
  'bash',
  'sh',
  'shell',
  'shellcommand',
  'shellexec',
  'runcommand',
  'executecommand',
  'execcommand',
  'terminal',
  'cmd',
  'powershell',
  'pwsh'
])

/** Command names that remove entries from the file system. */
const DELETE_COMMANDS = new Set(['rm', 'rmdir', 'del', 'erase', 'rd', 'remove-item', 'ri'])

/** Command names that create entries, with how their operands are read:
 *  `all` creates every operand, `last` only the destination. */
const CREATION_COMMANDS = new Map<string, 'all' | 'last'>([
  ['touch', 'all'],
  ['mkdir', 'all'],
  ['mktemp', 'all'],
  ['truncate', 'all'],
  ['tee', 'all'],
  ['install', 'all'],
  ['cp', 'last'],
  ['mv', 'last'],
  ['ln', 'last']
])

const PATH_FIELDS = ['path', 'file_path', 'filePath', 'filepath', 'filename', 'fileName', 'file']
const COMMAND_FIELDS = ['command', 'cmd', 'shell_command', 'commandLine', 'command_line']

/** Lower-case a tool name and drop its separators, so `write_file`, `Write`
 *  and `writeFile` all compare equal. */
function normalizeToolName(toolName: string): string {
  return toolName
    .trim()
    .toLowerCase()
    .replace(/[\s._-]+/gu, '')
}

/** First non-empty string value of the fields a call might name. */
function firstString(
  input: Record<string, unknown>,
  fields: readonly string[]
): string | undefined {
  for (const field of fields) {
    const value = input[field]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

/** Absolute POSIX form of one operand, or undefined when it cannot be read as
 *  a plain path (`~`, a variable, a substitution, or an empty token). */
function resolveTarget(base: string, operand: string): string | undefined {
  const candidate = operand.trim()
  if (!candidate || candidate.startsWith('~') || candidate.startsWith('-')) return undefined
  if (/[$`\0]/u.test(candidate)) return undefined
  const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(base, candidate)
  return toPosixPath(absolute)
}

/**
 * Split a shell command into its `&&`/`||`/`;`/`|` segments, honoring quotes so
 * an operator inside an argument stays part of it. Returns undefined when the
 * quotes do not balance, because the intended targets are then unreadable.
 */
function shellSegments(command: string): string[][] | undefined {
  const segments: string[][] = []
  let segment: string[] = []
  let token = ''
  let quote: '"' | "'" | null = null
  const endToken = (): void => {
    if (token) segment.push(token)
    token = ''
  }
  const endSegment = (): void => {
    endToken()
    if (segment.length > 0) segments.push(segment)
    segment = []
  }
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!
    if (quote !== null) {
      if (character === quote) quote = null
      else token += character
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === ' ' || character === '\t' || character === '\n' || character === '\r') {
      endToken()
      continue
    }
    if (character === '&' || character === '|' || character === ';') {
      endSegment()
      if ((character === '&' || character === '|') && command[index + 1] === character) index += 1
      continue
    }
    token += character
  }
  if (quote !== null) return undefined
  endSegment()
  return segments
}

/** Operands of one segment, with flags and Windows-style switches dropped. */
function segmentOperands(segment: readonly string[]): string[] {
  return segment.slice(1).filter((token) => {
    if (!token || token === '--' || token.startsWith('-')) return false
    // `del /s`, `rd /q` and friends are switches, not paths.
    return !/^\/[A-Za-z]$/u.test(token)
  })
}

/** Absolute paths a shell command is about to create. Redirections, `touch`,
 *  `mkdir`, `tee`, and copy destinations are all read; anything unreadable is
 *  simply left out, so a creation the parser misses keeps its ordinary card. */
export function shellCreationTargets(command: string, cwd: string): string[] {
  if (!command.trim() || command.length > 8192) return []
  const segments = shellSegments(command)
  if (!segments) return []
  const operands: string[] = []
  for (const segment of segments) {
    for (let index = 0; index < segment.length; index += 1) {
      const token = segment[index]!
      const redirect = /^(?:\d+|&)?(>>?)(.*)$/u.exec(token)
      if (redirect) {
        const inline = redirect[2]!
        if (inline) {
          // `>&2` and `2>&1` duplicate descriptors instead of naming a file.
          if (inline.startsWith('&') || /^\d+$/u.test(inline)) continue
          operands.push(inline)
          continue
        }
        const next = segment[index + 1]
        if (next !== undefined && !/^(?:\d+|&)?>>?/u.test(next)) {
          operands.push(next)
          index += 1
        }
        continue
      }
    }
    const name = basename(segment[0] ?? '')
      .toLowerCase()
      .replace(/\.(?:exe|cmd|bat|ps1)$/u, '')
    const rule = CREATION_COMMANDS.get(name)
    if (!rule) continue
    const targets = segmentOperands(segment)
    if (rule === 'all') operands.push(...targets)
    else {
      const destination = targets[targets.length - 1]
      if (targets.length >= 2 && destination) operands.push(destination)
    }
  }
  const resolved = operands.map((operand) => resolveTarget(cwd, operand))
  return [...new Set(resolved.filter((target): target is string => target !== undefined))]
}

/**
 * Absolute paths one shell command removes, or undefined when the command is
 * not a delete this module can read completely. Every segment has to be a
 * delete: a chain that also runs something else could remove more than it
 * names, so it keeps its card.
 */
export function shellDeletionTargets(command: string, cwd: string): string[] | undefined {
  if (!command.trim() || command.length > 8192) return undefined
  // Globs, variables, and substitutions hide their targets.
  if (/[$`*?[\]{}]/u.test(command)) return undefined
  const segments = shellSegments(command)
  if (!segments || segments.length === 0) return undefined
  const operands: string[] = []
  for (const segment of segments) {
    const name = basename(segment[0] ?? '')
      .toLowerCase()
      .replace(/\.(?:exe|cmd|bat|ps1)$/u, '')
    if (DELETE_COMMANDS.has(name)) {
      const targets = segmentOperands(segment)
      if (targets.length === 0) return undefined
      operands.push(...targets)
      continue
    }
    if (name === 'find' && segment.includes('-delete')) {
      const targets = segment
        .slice(1, segment.indexOf('-delete'))
        .filter((token) => !token.startsWith('-'))
      if (targets.length === 0) return undefined
      operands.push(...targets)
      continue
    }
    return undefined
  }
  const resolved = operands.map((operand) => resolveTarget(cwd, operand))
  if (resolved.some((target) => target === undefined)) return undefined
  return [...new Set(resolved as string[])]
}

/**
 * Absolute paths a tool call is about to create, when the tool is one this
 * module can read. Callers check each target against the file system to learn
 * whether the call genuinely creates it, so an overwrite is never mistaken for
 * a creation.
 */
export function agentCreationTargets(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string
): string[] {
  const name = normalizeToolName(toolName)
  if (CREATION_TOOLS.has(name)) {
    const path = firstString(input, PATH_FIELDS)
    const target = path === undefined ? undefined : resolveTarget(cwd, path)
    return target === undefined ? [] : [target]
  }
  if (SHELL_TOOLS.has(name)) {
    const command = firstString(input, COMMAND_FIELDS)
    return command === undefined ? [] : shellCreationTargets(command, cwd)
  }
  return []
}

/**
 * Absolute paths a permission request removes, or undefined when the request is
 * not a readable deletion. A permission that carries commands is read from
 * them; a permission that names its targets directly (a `delete` tool) is read
 * from those instead.
 */
export function deletionTargets(
  permission: string,
  paths: readonly string[],
  commands: readonly string[],
  cwd: string
): string[] | undefined {
  if (commands.length > 0) {
    const resolved: string[] = []
    for (const command of commands) {
      const targets = shellDeletionTargets(command, cwd)
      if (targets === undefined) return undefined
      resolved.push(...targets)
    }
    return resolved.length > 0 ? [...new Set(resolved)] : undefined
  }
  // Without a command, only a permission that names deletion itself can be a
  // removal, and it has to name what it removes.
  const terms = permission.split('-').filter(Boolean)
  if (!terms.some((term) => RESTRICTED_DELETE_TERMS.has(term))) return undefined
  if (paths.length === 0) return undefined
  const resolved = paths.map((path) => resolveTarget(cwd, path))
  if (resolved.some((target) => target === undefined)) return undefined
  return [...new Set(resolved as string[])]
}

/** Permission-name terms that mean the call removes something. */
const RESTRICTED_DELETE_TERMS = new Set(['delete', 'remove', 'destroy', 'erase', 'wipe'])
