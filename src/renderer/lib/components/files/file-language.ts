import { highlightCode } from '../markdown/markdown'

const MAX_HIGHLIGHTED_CHARACTERS = 250_000

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  bash: 'bash',
  c: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  go: 'go',
  h: 'c',
  html: 'xml',
  htm: 'xml',
  java: 'java',
  js: 'javascript',
  jsx: 'javascript',
  json: 'json',
  jsonc: 'json',
  kt: 'kotlin',
  md: 'markdown',
  php: 'php',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  scss: 'scss',
  sh: 'bash',
  sql: 'sql',
  svelte: 'xml',
  swift: 'swift',
  toml: 'ini',
  ts: 'typescript',
  tsx: 'typescript',
  vue: 'xml',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml'
}

export function languageForPath(path: string): string | undefined {
  const extension = path.split('.').at(-1)?.toLocaleLowerCase()
  return extension ? LANGUAGE_BY_EXTENSION[extension] : undefined
}

export function highlightFileContent(content: string, path: string): string {
  if (content.length > MAX_HIGHLIGHTED_CHARACTERS) return highlightCode(content)
  return highlightCode(content, languageForPath(path))
}
