import { isAbsolute, relative, resolve } from 'path'
import { toPosixPath } from '../../../lib/paths'
import type { AgentPart } from '../../../lib/types'

export const MUTATING_FILE_TOOLS = new Set([
  'applypatch',
  'delete',
  'deletefile',
  'edit',
  'editfile',
  'filechange',
  'multiedit',
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

/** Shell-like tools can mutate arbitrary paths, so their checkpoint diff cannot be path-filtered. */
export const UNBOUNDED_MUTATING_TOOLS = new Set([
  'bash',
  'commandexecution',
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

export function shellVariableValues(command: string): Map<string, string> {
  const values = new Map<string, string>()
  const assignments = new RegExp(
    String.raw`(?:^|[;\n"'])\s*(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*=\s*(${STATIC_PATH_EXPRESSION})`,
    'gmu'
  )
  for (const match of command.matchAll(assignments)) {
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
export function shellWritePaths(projectPath: string, input: Record<string, unknown>): string[] {
  const command = SHELL_COMMAND_INPUT_KEYS.map((key) => input[key]).find(
    (value): value is string => typeof value === 'string'
  )
  if (!command) return []
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
    for (const match of command.matchAll(pattern)) addExpression(match[1])
  }
  for (const match of command.matchAll(
    /(?:^|[\s;|&])(?:\d*)>>?\s*(?![&>])("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s;|&]+)/gmu
  )) {
    addExpression(match[1])
  }
  candidates.push(...patchPaths(command))
  const workingDirectory = shellWorkingDirectory(projectPath, input, command)
  return [
    ...new Set(
      candidates
        .map((candidate) =>
          projectRelativePath(
            projectPath,
            isAbsolute(candidate) ? candidate : resolve(workingDirectory, candidate)
          )
        )
        .filter((candidate): candidate is string => candidate !== null)
    )
  ]
}

export function changedPathsFromTool(
  projectPath: string,
  part: Extract<AgentPart, { type: 'tool' }>
): string[] {
  const tool = normalizedToolName(part.tool)
  if (UNBOUNDED_MUTATING_TOOLS.has(tool)) {
    return shellWritePaths(projectPath, part.state.input)
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
