/**
 * Inspect file operands, not arbitrary prose or tool capabilities. Kept
 * self-contained because bundled Pi embeds this function in its extension.
 */
export function sensitiveFileTargets(
  toolName: string,
  input: unknown,
  cwd: string,
  patterns: readonly string[],
  canonicalize?: (path: string) => string
): string[] {
  const targets = new Set<string>()
  const fields = new Set([
    'path',
    'paths',
    'file',
    'files',
    'file_path',
    'filePath',
    'filepath',
    'filename',
    'fileName',
    'file_paths',
    'filePaths',
    'directory',
    'directories',
    'root',
    'cwd',
    'sourcePath',
    'destinationPath',
    'oldPath',
    'newPath',
    'targetPath',
    'source',
    'destination',
    'target',
    'uri',
    'fileUri'
  ])

  function normalize(path: string): string {
    const parts: string[] = []
    const posix = path.replaceAll('\\', '/').normalize('NFC')
    for (const part of posix.split('/')) {
      if (!part || part === '.') continue
      if (part === '..') parts.pop()
      else parts.push(part)
    }
    return `${posix.startsWith('/') ? '/' : ''}${parts.join('/')}`
  }

  function glob(value: string, pattern: string): boolean {
    let cursor = 0
    let rule = 0
    let star = -1
    let retry = 0
    while (cursor < value.length) {
      if (rule < pattern.length && (pattern[rule] === '?' || pattern[rule] === value[cursor])) {
        cursor++
        rule++
      } else if (pattern[rule] === '*') {
        star = rule++
        retry = cursor
      } else if (star >= 0) {
        rule = star + 1
        cursor = ++retry
      } else return false
    }
    while (pattern[rule] === '*') rule++
    return rule === pattern.length
  }

  function matches(path: string, rawPattern: string): boolean {
    const pattern = rawPattern.replaceAll('\\', '/').normalize('NFC').replace(/\/$/u, '')
    if (!pattern) return false
    const subtree = pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern
    const pieces = path.split('/').filter(Boolean)
    const candidates = pattern.includes('/')
      ? [path, ...pieces.map((_, index) => pieces.slice(index).join('/'))]
      : pieces
    return candidates.some(
      (candidate) =>
        glob(candidate, pattern) ||
        candidate === subtree ||
        candidate.startsWith(`${subtree}/`) ||
        (/[?*]/u.test(candidate) &&
          candidate.replace(/[?*]/gu, '').length >= 2 &&
          glob(pattern.replaceAll('*', 'sample').replaceAll('?', 'x'), candidate))
    )
  }

  function add(value: string): void {
    if (targets.size >= 64 || !value || value.length > 4096 || /[\r\n]/u.test(value)) return
    let candidate = value.replace(/^["']|["']$/gu, '')
    if (candidate.startsWith('file://')) {
      try {
        candidate = decodeURIComponent(new URL(candidate).pathname)
      } catch {
        return
      }
    }
    if (!candidate || candidate.startsWith('-') || candidate.includes('://')) return
    const absolute = normalize(
      candidate.startsWith('/') || /^[a-z]:[/\\]/iu.test(candidate)
        ? candidate
        : `${cwd}/${candidate}`
    )
    let canonical = absolute
    try {
      canonical = normalize(canonicalize?.(candidate) ?? absolute)
    } catch {
      /* Match lexical paths too. */
    }
    if (patterns.some((pattern) => matches(absolute, pattern))) targets.add(absolute)
    else if (patterns.some((pattern) => matches(canonical, pattern))) targets.add(canonical)
  }

  function commandTargets(command: string, depth = 0): void {
    if (command.length > 65536 || depth > 3) return
    // Substitutions really execute even when their outer command is echo.
    for (const match of command.matchAll(/\$\(([^()]*)\)|`([^`]*)`/gu)) {
      commandTargets(match[1] ?? match[2] ?? '', depth + 1)
    }
    const tokens =
      command.match(/"(?:\\.|[^"\\])*"|'[^']*'|&&|\|\||<<|>>|[;|<>]|[^\s;|<>]+/gu) ?? []
    let executable = ''
    let skipPattern = false
    let skipOptionValue = false
    let redirect = false
    let embedded: 'shell' | 'language' | undefined

    function languageTargets(code: string): void {
      // Ignore quoted prose and comments inside programs. A string that merely
      // mentions open('.env') is not an attempted filesystem call.
      for (let index = 0; index < code.length; index++) {
        const character = code[index]
        if (character === '#' || (character === '/' && code[index + 1] === '/')) {
          const end = code.indexOf('\n', index)
          if (end < 0) break
          index = end
          continue
        }
        if (character === '"' || character === "'" || character === '`') {
          const quote = character
          while (++index < code.length) {
            if (code[index] === '\\') index++
            else if (code[index] === quote) break
          }
          continue
        }
        if (index > 0 && /[\w$]/u.test(code[index - 1] ?? '')) continue
        const match =
          /^(open|Path|readFile(?:Sync)?|writeFile(?:Sync)?|read_to_string|File\.(?:read|open|ReadAllText))\s*\(\s*(['"])([^'"\r\n]+)\2/u.exec(
            code.slice(index)
          )
        if (!match) continue
        if (
          match[1] !== 'Path' ||
          /^\s*\)\s*\.\s*(?:read_text|read_bytes|write_text|write_bytes|open|exists|stat|unlink)\s*\(/u.test(
            code.slice(index + match[0].length)
          )
        )
          add(match[3] ?? '')
        index += match[0].length - 1
      }
    }
    for (const raw of tokens) {
      if ([';', '|', '&&', '||'].includes(raw)) {
        executable = ''
        skipPattern = false
        skipOptionValue = false
        embedded = undefined
        continue
      }
      const token = raw.replace(/^["']|["']$/gu, '')
      if (['>', '>>', '<'].includes(token)) {
        redirect = true
        continue
      }
      if (token === '<<') {
        skipOptionValue = true
        continue
      }
      if (redirect) {
        add(token)
        redirect = false
        continue
      }
      if (embedded) {
        skipOptionValue = false
        if (embedded === 'shell') commandTargets(token, depth + 1)
        else {
          const code = token.replace(/\\(["'\\])/gu, '$1')
          languageTargets(code)
        }
        embedded = undefined
        continue
      }
      if (executable === 'git' && token === 'grep') {
        executable = 'grep'
        skipPattern = true
        continue
      }
      if (!executable) {
        if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(token)) continue
        executable = token.replaceAll('\\', '/').split('/').at(-1) ?? token
        skipPattern = ['rg', 'grep', 'egrep', 'fgrep'].includes(executable)
        continue
      }
      if (['echo', 'printf'].includes(executable)) continue
      if (skipOptionValue) {
        skipOptionValue = false
        continue
      }
      if (token.startsWith('-')) {
        if (['-c', '-lc', '-ec', '-Command', '-command'].includes(token)) {
          if (['sh', 'bash', 'zsh', 'dash', 'fish', 'pwsh', 'powershell'].includes(executable))
            embedded = 'shell'
          else if (
            /^(?:python[\d.]*|node|nodejs|bun|deno|ruby|perl|php)(?:\.exe)?$/u.test(executable)
          )
            embedded = 'language'
        }
        if (
          ['-e', '--eval'].includes(token) &&
          /^(?:node|nodejs|bun|deno|ruby|perl|php)(?:\.exe)?$/u.test(executable)
        )
          embedded = 'language'
        if (token === '--files') skipPattern = false
        if (['-e', '--regexp'].includes(token)) {
          skipOptionValue = true
          skipPattern = false
        } else if (
          [
            '-g',
            '--glob',
            '-t',
            '--type',
            '--type-add',
            '--include',
            '--exclude',
            '-A',
            '-B',
            '-C',
            '--after-context',
            '--before-context',
            '--context',
            '-m',
            '--max-count',
            '--max-depth',
            '--max-columns',
            '-j',
            '--threads'
          ].includes(token)
        )
          skipOptionValue = true
        if (
          token.startsWith('--regexp=') ||
          token.startsWith('-e') ||
          token === '-f' ||
          token === '--file'
        )
          skipPattern = false
        const equal = token.indexOf('=')
        if (equal > 0 && /(?:file|path|directory|config|key|cert)/iu.test(token.slice(0, equal)))
          add(token.slice(equal + 1))
        continue
      }
      if (skipPattern) {
        skipPattern = false
        continue
      }
      add(token)
    }
  }

  function inspect(value: unknown, key = '', depth = 0): void {
    if (depth > 6 || value === null || value === undefined) return
    if (typeof value === 'string') {
      if (fields.has(key) || (['find', 'glob'].includes(toolName) && key === 'pattern')) add(value)
      else if (key === 'command' || key === 'cmd') commandTargets(value)
      else if (key === 'patch' || key === 'patchText') {
        for (const match of value.matchAll(
          /^(?:\*\*\* (?:Update|Add|Delete) File: |(?:---|\+\+\+) [ab]\/)([^\r\n]+)/gmu
        ))
          add(match[1] ?? '')
      }
      return
    }
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 64)) inspect(item, key, depth + 1)
    } else if (typeof value === 'object') {
      for (const [name, item] of Object.entries(value).slice(0, 64)) {
        if (
          [
            'code',
            'content',
            'text',
            'prompt',
            'description',
            'message',
            'query',
            'title'
          ].includes(name)
        )
          continue
        inspect(item, name, depth + 1)
      }
    }
  }
  inspect(input)
  return [...targets]
}
