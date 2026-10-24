export interface IdeLanguageMapping {
  extension: string
  languageId: string
}
export interface IdeLanguageServer {
  id: string
  name: string
  enabled: boolean
  command: string
  args: string[]
  languages: IdeLanguageMapping[]
  env: Record<string, string>
  rootMarkers: string[]
  initializationOptions: Record<string, unknown>
  settings: Record<string, unknown>
}

function preset(
  id: string,
  name: string,
  command: string,
  args: string[],
  languages: Record<string, string>,
  rootMarkers: string[] = []
): IdeLanguageServer {
  return {
    id,
    name,
    command,
    args,
    enabled: true,
    languages: Object.entries(languages).map(([extension, languageId]) => ({
      extension,
      languageId
    })),
    env: {},
    rootMarkers,
    initializationOptions: {},
    settings: {}
  }
}
export const DEFAULT_IDE_LANGUAGE_SERVERS: IdeLanguageServer[] = [
  {
    ...preset(
      'typescript',
      'JavaScript / TypeScript',
      'typescript-language-server',
      ['--stdio'],
      {
        '.ts': 'typescript',
        '.mts': 'typescript',
        '.cts': 'typescript',
        '.tsx': 'typescriptreact',
        '.js': 'javascript',
        '.mjs': 'javascript',
        '.cjs': 'javascript',
        '.jsx': 'javascriptreact'
      },
      ['tsconfig.json', 'jsconfig.json', 'package.json']
    ),
    initializationOptions: {
      tsserver: { useSyntaxServer: 'never' },
      disableAutomaticTypingAcquisition: true,
      maxTsServerMemory: 128
    }
  },
  preset('svelte', 'Svelte', 'svelteserver', ['--stdio'], { '.svelte': 'svelte' }, [
    'svelte.config.js',
    'svelte.config.ts',
    'package.json'
  ]),
  preset(
    'python',
    'Python / Pyright',
    'pyright-langserver',
    ['--stdio'],
    { '.py': 'python', '.pyi': 'python' },
    ['pyproject.toml', 'pyrightconfig.json', 'setup.py']
  ),
  preset('go', 'Go', 'gopls', [], { '.go': 'go' }, ['go.work', 'go.mod']),
  preset(
    'php',
    'PHP / Intelephense',
    'intelephense',
    ['--stdio'],
    { '.php': 'php', '.phtml': 'php' },
    ['composer.json']
  ),
  preset('rust', 'Rust', 'rust-analyzer', [], { '.rs': 'rust' }, ['Cargo.toml']),
  preset(
    'clang',
    'C / C++',
    'clangd',
    [],
    { '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.hpp': 'cpp' },
    ['compile_commands.json', '.clangd']
  ),
  preset('css', 'CSS', 'vscode-css-language-server', ['--stdio'], {
    '.css': 'css',
    '.scss': 'scss',
    '.less': 'less'
  }),
  preset('html', 'HTML', 'vscode-html-language-server', ['--stdio'], {
    '.html': 'html',
    '.htm': 'html'
  }),
  preset('json', 'JSON', 'vscode-json-language-server', ['--stdio'], {
    '.json': 'json',
    '.jsonc': 'jsonc'
  })
]

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
function text(value: unknown, label: string, max = 4096): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0'))
    throw new TypeError(`${label} must be a non-empty string, at most ${max} characters`)
  return value.trim()
}
function jsonObject(value: unknown, label: string): Record<string, unknown> {
  if (!object(value)) throw new TypeError(`${label} must be a JSON object`)
  return value
}
export function validateIdeLanguageServers(input: unknown): IdeLanguageServer[] {
  if (
    !Array.isArray(input) ||
    input.length > 32 ||
    new TextEncoder().encode(JSON.stringify(input)).byteLength > 131072
  )
    throw new TypeError('Provide up to 32 language servers, within 128 KiB of JSON')
  const ids = new Set<string>()
  const extensions = new Set<string>()
  return input.map((value: unknown) => {
    if (!object(value)) throw new TypeError('Each language server must be an object')
    const id = text(value.id, 'Server ID', 80)
    if (!/^[a-zA-Z0-9_-]+$/u.test(id) || ids.has(id))
      throw new TypeError(
        'Server IDs must be unique and contain only letters, numbers, hyphens or underscores'
      )
    ids.add(id)
    if (typeof value.enabled !== 'boolean') throw new TypeError('Server enabled must be a boolean')
    if (
      !Array.isArray(value.args) ||
      value.args.length > 64 ||
      value.args.some((arg) => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0'))
    )
      throw new TypeError('Arguments must be an array of at most 64 strings')
    if (!Array.isArray(value.languages) || !value.languages.length || value.languages.length > 64)
      throw new TypeError('Provide at least one language mapping, up to 64')
    const local = new Set<string>()
    const languages = value.languages.map((mapping: unknown) => {
      if (!object(mapping)) throw new TypeError('Language mappings must be objects')
      const extension = text(mapping.extension, 'Extension', 40).toLowerCase()
      if (!/^\.[a-z0-9][a-z0-9._+-]*$/u.test(extension) || local.has(extension))
        throw new TypeError('Extensions must be unique and begin with a dot, for example .ts')
      local.add(extension)
      if (value.enabled && extensions.has(extension))
        throw new TypeError(`More than one enabled server handles ${extension}`)
      if (value.enabled) extensions.add(extension)
      return { extension, languageId: text(mapping.languageId, 'LSP language ID', 80) }
    })
    const env = jsonObject(value.env ?? {}, 'Environment')
    if (
      Object.keys(env).length > 64 ||
      Object.entries(env).some(
        ([key, value]) =>
          !/^[a-zA-Z_][a-zA-Z0-9_]*$/u.test(key) ||
          typeof value !== 'string' ||
          value.length > 4096 ||
          value.includes('\0')
      )
    )
      throw new TypeError('Environment must contain up to 64 named string values')
    const markers = value.rootMarkers ?? []
    if (
      !Array.isArray(markers) ||
      markers.length > 16 ||
      markers.some(
        (marker) =>
          typeof marker !== 'string' ||
          !marker.trim() ||
          marker.length > 120 ||
          marker.includes('/') ||
          marker.includes('\\') ||
          marker === '..' ||
          marker.includes('\0')
      )
    )
      throw new TypeError('Root markers must be up to 16 file or directory names')
    return {
      id,
      name: text(value.name, 'Server name', 120),
      enabled: value.enabled,
      command: text(value.command, 'Executable'),
      args: value.args as string[],
      languages,
      env: env as Record<string, string>,
      rootMarkers: (markers as string[]).map((marker) => marker.trim()),
      initializationOptions: jsonObject(
        value.initializationOptions ?? {},
        'Initialization options'
      ),
      settings: jsonObject(value.settings ?? {}, 'Server settings')
    }
  })
}
