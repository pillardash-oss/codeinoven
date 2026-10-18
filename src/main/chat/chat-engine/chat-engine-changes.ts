import { createHash } from 'crypto'
import { isAbsolute, relative, resolve } from 'path'
import { toPosixPath } from '../../../lib/paths'
import type { AgentPart, FileChangeSource } from '../../../lib/types'

export const MUTATING_FILE_TOOLS = new Set([
  'applydiff',
  'applypatch',
  'delete',
  'deletefile',
  'edit',
  'editfile',
  'filechange',
  'multiedit',
  'insertcontent',
  'multireplacefilecontent',
  'notebookedit',
  'patch',
  'replacefilecontent',
  'replaceinfile',
  'newfile',
  'searchandreplace',
  'writefile',
  'writetofile',
  'write'
])

/** Shell-like tools need explicit write targets as well as a verified content diff. */
export const UNBOUNDED_MUTATING_TOOLS = new Set([
  'execcommand',
  'writestdin',
  'bash',
  'commandexecution',
  'executecommand',
  'execute',
  'runcommand',
  'shell',
  'terminal'
])

export const MUTATING_FILE_PATH_KEYS = new Set([
  'absolutepath',
  'filepath',
  'notebookpath',
  'path',
  'targetfile'
])

export const SHELL_COMMAND_INPUT_KEYS = ['command', 'cmd', 'script'] as const

export const SHELL_WORKING_DIRECTORY_INPUT_KEYS = ['cwd', 'workdir', 'workingDirectory'] as const

export const STATIC_PATH_EXPRESSION = String.raw`(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[A-Za-z_$][\w$]*)`

export function normalizedToolName(tool: string): string {
  return tool.toLowerCase().replaceAll(/[^a-z0-9]/gu, '')
}

export function projectRelativePath(projectPath: string, candidate: string): string | null {
  const trimmed = candidate.trim()
  if (!trimmed || trimmed.includes('\0')) return null
  const absolutePath = isAbsolute(trimmed) ? resolve(trimmed) : resolve(projectPath, trimmed)
  const relativePath = toPosixPath(relative(resolve(projectPath), absolutePath))
  if (!relativePath || relativePath === '..' || relativePath.startsWith('../')) return null
  return relativePath
}

export function patchPaths(patch: string): string[] {
  return [...patch.matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File: |Move to: )(.+)$/gmu)].map(
    (match) => match[1] ?? ''
  )
}

export function staticStringValue(value: string): string | null {
  const quote = value[0]
  if ((quote !== '"' && quote !== "'" && quote !== '`') || value.at(-1) !== quote) return null
  const content = value.slice(1, -1)
  if (quote === '`' && content.includes('${')) return null
  return content.replaceAll(/\\([\\'"` ])/gu, '$1')
}

/** Mark code positions so printed examples and comments cannot become write evidence. */
function scriptCodePositions(source: string): Uint8Array {
  const code = new Uint8Array(source.length).fill(1)
  for (let i = 0; i < source.length; i++) {
    const char = source[i]
    const start = i
    if (char === '#' || source.startsWith('//', i)) {
      while (i < source.length && source[i] !== '\n') i++
    } else if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2)
      i = end < 0 ? source.length : end + 2
    } else if (char === "'" || char === '"' || char === '`') {
      const quote = source.startsWith(char.repeat(3), i) ? char.repeat(3) : char
      i += quote.length
      while (i < source.length) {
        if (source[i] === '\\') i += 2
        else if (source.startsWith(quote, i)) {
          i += quote.length
          break
        } else i++
      }
    } else continue
    code.fill(0, start, i)
    i--
  }
  return code
}

export function shellVariableValues(command: string): Map<string, string> {
  const values = new Map<string, string>()
  const code = scriptCodePositions(command)
  const assignments = new RegExp(
    String.raw`(?:^|[;\n"'])\s*(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*=\s*(${STATIC_PATH_EXPRESSION})`,
    'gmu'
  )
  for (const match of command.matchAll(assignments)) {
    if (!code[match.index]) continue
    const name = match[1]
    const literal = match[2]
    if (!name || !literal) continue
    const value = staticStringValue(literal)
    if (value !== null) values.set(name, value)
  }
  return values
}

export function shellWorkingDirectory(
  projectPath: string,
  input: Record<string, unknown>,
  command: string
): string {
  let workingDirectory = projectPath
  for (const key of SHELL_WORKING_DIRECTORY_INPUT_KEYS) {
    const candidate = input[key]
    if (typeof candidate !== 'string') continue
    const normalized = projectRelativePath(projectPath, candidate)
    if (normalized) workingDirectory = resolve(projectPath, normalized)
    break
  }
  const directoryChanges = new RegExp(
    String.raw`(?:^|&&|;|\n)\s*cd\s+("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s;&|]+)(?=\s*(?:&&|;|\n|$))`,
    'gmu'
  )
  for (const match of command.matchAll(directoryChanges)) {
    const literal = match[1]
    if (!literal) continue
    const directory = staticStringValue(literal) ?? literal
    if (directory === null || directory.includes('$')) continue
    const absolute = isAbsolute(directory)
      ? resolve(directory)
      : resolve(workingDirectory, directory)
    if (projectRelativePath(projectPath, absolute)) workingDirectory = absolute
  }
  return workingDirectory
}

/** Extract conservatively identifiable write targets from shell source. The
 * completion snapshot validates every path, so a command that names a file but
 * leaves its content unchanged cannot create a file-card entry. */
interface ShellWord {
  value: string
  operator: boolean
}

/** Tokenize without executing expansions. Quoted operators stay inside their word. */
function shellWords(command: string): ShellWord[] {
  const words: ShellWord[] = []
  let value = ''
  let active = false
  let quote = ''
  const flush = (): void => {
    if (active) words.push({ value, operator: false })
    value = ''
    active = false
  }
  for (let i = 0; i < command.length; i++) {
    const char = command[i] ?? ''
    if (char === '\\' && quote !== "'") {
      const next = command[++i]
      if (next !== undefined && next !== '\n') {
        value += next
        active = true
      }
    } else if (quote) {
      if (char === quote) quote = ''
      else value += char
    } else if (char === "'" || char === '"') {
      quote = char
      active = true
    } else if (';|&<>\n'.includes(char)) {
      flush()
      const next = command[i + 1]
      const operator = next === char && char !== '\n' ? char + command[++i] : char
      words.push({ value: operator, operator: true })
    } else if (/\s/u.test(char)) {
      flush()
    } else {
      value += char
      active = true
    }
  }
  if (quote) return [] // Incomplete input is not write evidence.
  flush()
  return words
}

function scriptWritePaths(command: string): string[] {
  const code = scriptCodePositions(command)
  const variables = shellVariableValues(command)
  const candidates: string[] = []
  const addExpression = (expression: string | undefined): void => {
    if (!expression) return
    const literal = staticStringValue(expression)
    const candidate =
      literal ??
      variables.get(expression) ??
      (/[/.[\]\\]/u.test(expression) ? expression : undefined)
    if (candidate) candidates.push(candidate)
  }
  const firstArgumentWriters = new RegExp(
    String.raw`\b(?:Bun\s*\.\s*write|Deno\s*\.\s*(?:writeFile|writeTextFile)|(?:fs\s*\.\s*(?:promises\s*\.\s*)?)?(?:appendFile|appendFileSync|outputFile|outputFileSync|writeFile|writeFileSync))\s*\(\s*(${STATIC_PATH_EXPRESSION})`,
    'gmu'
  )
  const pythonOpenMode = new RegExp(
    String.raw`\bopen\s*\(\s*(${STATIC_PATH_EXPRESSION})\s*,\s*["'][^"']*[awx+][^"']*["']`,
    'gmu'
  )
  const pythonOpenWrite = new RegExp(
    String.raw`\bopen\s*\(\s*(${STATIC_PATH_EXPRESSION})\s*\)\s*\.\s*(?:truncate|write|writelines)\s*\(`,
    'gmu'
  )
  const pythonPathWriter = new RegExp(
    String.raw`\bPath\s*\(\s*(${STATIC_PATH_EXPRESSION})\s*\)\s*\.\s*(?:touch|write_bytes|write_text)\s*\(`,
    'gmu'
  )
  for (const pattern of [firstArgumentWriters, pythonOpenMode, pythonOpenWrite, pythonPathWriter]) {
    for (const match of command.matchAll(pattern)) {
      if (code[match.index]) addExpression(match[1])
    }
  }
  return candidates
}

/** Only actual command operands and interpreter code can supply write evidence.
 * Read-command arguments and output are never scanned for write-like strings. */
export function shellWritePaths(projectPath: string, input: Record<string, unknown>): string[] {
  const command = SHELL_COMMAND_INPUT_KEYS.map((key) => input[key]).find(
    (value): value is string => typeof value === 'string'
  )
  if (!command || command.length > 262_144) return []
  let sourceCommand = command
  let words = shellWords(sourceCommand)
  // Codex exposes the launch wrapper as its command. Unwrap a literal shell -c argument.
  const head = words[0]?.value.split('/').at(-1)
  if (head && ['sh', 'bash', 'zsh', 'dash'].includes(head)) {
    const commandIndex = words.findIndex(
      (word) => !word.operator && /^-[a-z]*c[a-z]*$/u.test(word.value)
    )
    const source = words[commandIndex + 1]
    if (commandIndex >= 0 && source && !source.operator) {
      sourceCommand = source.value
      words = shellWords(sourceCommand)
    }
  }
  let workingDirectory = shellWorkingDirectory(projectPath, input, '')
  const paths = new Set<string>()
  const add = (candidate: string | undefined): void => {
    // Runtime expansion, command substitution and globs cannot establish an exact target.
    if (!candidate || /[$`*?{}]/u.test(candidate)) return
    const path = projectRelativePath(projectPath, resolve(workingDirectory, candidate))
    if (path) paths.add(path)
  }
  const segments: ShellWord[][] = [[]]
  for (const word of words) {
    if (word.operator && [';', '\n', '|', '||', '&&', '&'].includes(word.value)) segments.push([])
    else segments.at(-1)?.push(word)
  }
  for (const segment of segments) {
    const args: string[] = []
    for (let i = 0; i < segment.length; i++) {
      const word = segment[i]
      if (!word) continue
      if (word.operator) {
        if (word.value === '>' || word.value === '>>') add(segment[i + 1]?.value)
        i++ // The redirection operand is not a command argument.
      } else args.push(word.value)
    }
    while (/^[A-Za-z_][A-Za-z_0-9]*=/u.test(args[0] ?? '')) args.shift()
    const executable = args.shift()?.split('/').at(-1)
    if (!executable) continue
    const operands = args.filter((arg) => !arg.startsWith('-'))
    if (executable === 'cd') {
      const directory = operands[0]
      if (directory && !/[$`*?]/u.test(directory))
        workingDirectory = resolve(workingDirectory, directory)
    } else if (['touch', 'rm', 'unlink', 'tee'].includes(executable)) {
      for (const operand of operands) add(operand)
    } else if (['cp', 'mv', 'install'].includes(executable)) {
      add(operands.at(-1))
      if (executable === 'mv') for (const operand of operands.slice(0, -1)) add(operand)
    } else if (
      executable === 'sed' &&
      args.some((arg) => arg === '--in-place' || arg.startsWith('-i'))
    ) {
      add(operands.at(-1))
    } else if (/^(?:python[\d.]*|node|bun|deno)$/u.test(executable)) {
      const codeIndex = args.findIndex((arg) =>
        ['-c', '-e', '--eval', '-p', '--print'].includes(arg)
      )
      const code = codeIndex >= 0 ? args[codeIndex + 1] : undefined
      if (code) for (const path of scriptWritePaths(code)) add(path)
    }
  }
  // Quoted heredocs carry code outside shell arguments. Limit inspection to a
  // writer's own delimiter body, never arbitrary quoted strings or log output.
  const heredoc =
    /(?:^|[;\n])\s*(python[\d.]*|node|bun|deno|apply_patch)\b[^\n]*<<-?\s*['"]?([A-Za-z_][A-Za-z_0-9]*)['"]?[^\n]*\n([\s\S]*?)\n\2(?:\n|$)/gmu
  for (const match of sourceCommand.matchAll(heredoc)) {
    const code = match[3] ?? ''
    for (const path of match[1] === 'apply_patch' ? patchPaths(code) : scriptWritePaths(code))
      add(path)
  }
  return [...paths]
}

export function changedPathsFromTool(
  projectPath: string,
  part: Extract<AgentPart, { type: 'tool' }>
): string[] {
  if (part.state.status !== 'completed' && part.state.status !== 'error') return []
  return toolWriteTargets(projectPath, part)
}

/** Candidate operands for a pre-execution fingerprint. This alone never claims a change. */
export function toolWriteTargets(
  projectPath: string,
  part: Extract<AgentPart, { type: 'tool' }>
): string[] {
  const tool = normalizedToolName(part.tool)
  if (UNBOUNDED_MUTATING_TOOLS.has(tool)) {
    return shellWritePaths(projectPath, {
      ...part.state.input,
      // Older Codex transcripts carried the command only in the title.
      ...(shellCommand(part) ? { command: shellCommand(part) } : {})
    })
  }
  if (!MUTATING_FILE_TOOLS.has(tool)) return []
  const candidates: string[] = []
  const input = part.state.input
  for (const [key, value] of Object.entries(input)) {
    if (MUTATING_FILE_PATH_KEYS.has(normalizedToolName(key)) && typeof value === 'string') {
      candidates.push(value)
    }
  }
  const changes = input['changes']
  if (Array.isArray(changes)) {
    for (const value of changes) {
      if (!value || typeof value !== 'object') continue
      const record = value as Record<string, unknown>
      for (const [key, candidate] of Object.entries(record)) {
        if (MUTATING_FILE_PATH_KEYS.has(normalizedToolName(key)) && typeof candidate === 'string') {
          candidates.push(candidate)
        }
      }
    }
  }
  for (const key of ['patch', 'patchText', 'diff']) {
    if (typeof input[key] === 'string') candidates.push(...patchPaths(input[key]))
  }
  const paths = [
    ...new Set(
      candidates
        .map((candidate) => projectRelativePath(projectPath, candidate))
        .filter((candidate): candidate is string => candidate !== null)
    )
  ]
  return paths
}

/** Commands are evidence only when attached to the actual tool call, never inferred from prose. */
export function shellCommand(part: Extract<AgentPart, { type: 'tool' }>): string | undefined {
  const command = SHELL_COMMAND_INPUT_KEYS.map((key) => part.state.input[key]).find(
    (value): value is string => typeof value === 'string'
  )
  return (
    command ?? (normalizedToolName(part.tool) === 'commandexecution' ? part.state.title : undefined)
  )
}

export function fileChangeSource(
  part: Extract<AgentPart, { type: 'tool' }>
): FileChangeSource | undefined {
  if (part.state.status !== 'completed' && part.state.status !== 'error') return undefined
  const command = UNBOUNDED_MUTATING_TOOLS.has(normalizedToolName(part.tool))
    ? shellCommand(part)
    : undefined
  return {
    tool: part.tool,
    toolPartId: part.id,
    messageId: part.messageID,
    callId: part.callID,
    status: part.state.status,
    ...(command
      ? {
          command: command.slice(0, 4096),
          commandTruncated: command.length > 4096,
          commandHash: createHash('sha256').update(command).digest('hex')
        }
      : {}),
    verification: 'tool-target-and-content'
  }
}
