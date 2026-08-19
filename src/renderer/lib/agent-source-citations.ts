import type { AgentMessage } from '$shared/types'

export interface FileCitation {
  kind: 'file'
  path: string
  line?: number
  lineEnd?: number
  raw: string
}

export interface WebCitation {
  kind: 'web'
  url: string
  raw: string
}

export type SourceCitation = FileCitation | WebCitation

interface ParsedFileCitation {
  path: string
  line?: number
  lineEnd?: number
}

const FILE_EXT =
  'ts|js|tsx|jsx|svelte|vue|astro|mjs|cjs|mts|cts|dts|json|css|scss|less|html|md|mdx|yaml|yml|toml|env|py|rb|go|rs|zig|mojo|c|cpp|h|hpp|java|kt|swift|sh|bash|zsh|fish|sql|graphql|prisma|tf|lock|wasm|xml|svg|sass|styl'

const FILE_EXT_PATTERN = `(?:${FILE_EXT})`
const BACKTICK_CANDIDATE = /(?<!\[)`([^`\n]+)`/gu
const PLAIN_WITH_LINE = new RegExp(
  `(?<=^|\\s)((?:[\\w./-]+\\/)[\\w./-]+\\.${FILE_EXT_PATTERN}):(\\d+)(?:-(\\d+))?(?=[.,;:!?]?(?:$|\\s))`,
  'giu'
)
const URL_PATTERN = /https?:\/\/[^\s<>"'`)\]}]+/gu
const MARKDOWN_LINK_PATTERN = /(?<!!)\[([^\]]+)\]\((?:<([^>\n]+)>|([^) \t\n]+))\)/gu
const MARKDOWN_WEB_LINK_PATTERN = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/gu

// Codex CLI / ChatGPT agent file citations, e.g.
//   :codex-file-citation{path="/abs/file.pdf" purpose="source"}.
// Prefix may be `:`, `::` or `:::`. Only `path` is required; values are
// double-quoted (may escape `\"` and `\\`), and braces inside quotes are
// content. Optional unquoted `line_range_start`/`line_range_end` carry the
// line span. Sentence punctuation follows the closing `}` in prose.
const CODEX_CITATION_PATTERN = /:{1,3}codex-file-citation\{((?:[^"{}]|"(?:[^"\\]|\\.)*")*)\}/gu
const CODEX_PATH_ATTRIBUTE = /(?:^|\s)path="((?:[^"\\]|\\.)*)"/u
const CODEX_LINE_START_ATTRIBUTE = /(?:^|\s)line_range_start=(\d+)/u
const CODEX_LINE_END_ATTRIBUTE = /(?:^|\s)line_range_end=(\d+)/u

/** True for absolute filesystem paths (POSIX `/…`, Windows `C:/…`, UNC). */
export function isAbsoluteCitationPath(value: string): boolean {
  return /^(\/|[a-zA-Z]:[\\/]|\/\/)/u.test(value)
}

function cleanUrl(value: string): string {
  return value.replace(/[.,;:!?]+$/gu, '')
}

// ─── Section references (§N, §N.N) ────────────────────────────────────────

const SECTION_REF_PATTERN = /§\s*((?:[A-Za-z]-)?\d+(?:\.\d+)*)/gu
const HEADING_PATTERN = /^ {0,3}(#{1,6})\s+(.+)$/u
const FENCE_OPEN_PATTERN = /^ {0,3}(`{3,}|~{3,})/u

/**
 * A section key is the leading number/code of a heading, e.g. `2.3` from
 * `## 2.3 Working-tree caveat` or `9` from `## 9. Authoritative references`.
 * Optional leading letters cover codes like `A-01`.
 */
export function sectionKeyFromHeading(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  const body = trimmed.startsWith('§') ? trimmed.replace(/^§+/u, '').trim() : trimmed
  return /^((?:[A-Za-z]-)?\d+(?:\.\d+)*)/u.exec(body)?.[1] ?? null
}

/** Stable, HTML-id-safe anchor for a section key (`2.3` → `section-2-3`). */
export function sectionAnchor(key: string): string {
  return `section-${key.toLowerCase().replace(/[^a-z0-9]+/gu, '-')}`
}

/** Fence-aware line scan: tracks fenced code blocks so callers can skip them. */
function scanMarkdownLines(text: string, visit: (line: string, inFence: boolean) => void): void {
  const lines = text.split('\n')
  let fenceChar: string | null = null
  let fenceLength = 0
  for (const line of lines) {
    if (fenceChar) {
      const closing = new RegExp(
        `^ {0,3}${escapeRegExp(fenceChar)}{${fenceLength},}[ \\t]*$`,
        'u'
      ).test(line)
      if (closing) {
        fenceChar = null
        fenceLength = 0
        visit(line, false)
        continue
      }
      visit(line, true)
      continue
    }
    const opening = FENCE_OPEN_PATTERN.exec(line)
    if (opening) {
      fenceChar = opening[1]?.[0] ?? null
      fenceLength = opening[1]?.length ?? 0
      visit(line, true)
      continue
    }
    visit(line, false)
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/** Distinct section keys referenced in the text (`§2.3`, `§9`), skipping code. */
export function extractSectionReferences(text: string): string[] {
  const keys = new Set<string>()
  scanMarkdownLines(text, (line, inFence) => {
    if (inFence) return
    for (const segment of line.split('`').filter((_, index) => index % 2 === 0)) {
      for (const match of segment.matchAll(SECTION_REF_PATTERN)) {
        if (match[1]) keys.add(match[1])
      }
    }
  })
  return [...keys]
}

/** Section keys of headings present in the text (`## 2.3 Foo` → `2.3`). */
export function collectSectionKeys(text: string): Set<string> {
  const keys = new Set<string>()
  scanMarkdownLines(text, (line, inFence) => {
    if (inFence) return
    const heading = HEADING_PATTERN.exec(line)
    const key = heading ? sectionKeyFromHeading(heading[2] ?? '') : null
    if (key) keys.add(key)
  })
  return keys
}

/** Rewrite `§N.N` to a same-document anchor link when the section exists.
 *  Code (fenced or inline) and heading lines are left untouched. */
export function linkifySectionReferences(text: string, knownKeys: ReadonlySet<string>): string {
  const out: string[] = []
  scanMarkdownLines(text, (line, inFence) => {
    if (inFence || HEADING_PATTERN.test(line)) {
      out.push(line)
      return
    }
    const segments = line.split('`')
    const linked = segments
      .map((segment, index) => {
        if (index % 2 === 1) return segment
        return segment.replace(SECTION_REF_PATTERN, (match, key: string) =>
          knownKeys.has(key) ? `[${match}](#${sectionAnchor(key)})` : match
        )
      })
      .join('`')
    out.push(linked)
  })
  return out.join('\n')
}

function decodePath(value: string): string {
  try {
    return decodeURI(value)
  } catch {
    return value
  }
}

/** Canonicalize agent-authored path spelling before matching or navigation. */
export function normalizeCitationPath(value: string): string {
  let path = value.trim().replaceAll('\\/', '/')
  if (path.startsWith('file://')) {
    try {
      path = decodeURIComponent(new URL(path).pathname)
    } catch {
      path = path.replace(/^file:\/+/u, '/')
    }
  } else {
    path = decodePath(path)
  }
  path = path.replace(/\\/gu, '/').replace(/\/{2,}/gu, '/')
  while (path.startsWith('./')) path = path.slice(2)
  if (path.length > 1) path = path.replace(/\/+$/gu, '')
  return path
}

/** Decode a Codex attribute value: only `\"` and `\\` are escapes. A leading
 *  double backslash (UNC path) is preserved verbatim. */
function decodeCodexAttribute(value: string): string {
  const isUnc = value.startsWith('\\\\')
  const decoded = value.replace(/\\(["\\])/gu, '$1')
  return isUnc ? `\\${decoded}` : decoded
}

/** Parse the attribute block of a `:codex-file-citation{...}` token. */
function parseCodexCitation(attributes: string): ParsedFileCitation | null {
  const pathMatch = CODEX_PATH_ATTRIBUTE.exec(attributes)
  if (!pathMatch) return null
  const path = decodeCodexAttribute(pathMatch[1] ?? '')
  if (!path) return null
  const result: ParsedFileCitation = { path }
  const lineStart = CODEX_LINE_START_ATTRIBUTE.exec(attributes)
  const lineEnd = CODEX_LINE_END_ATTRIBUTE.exec(attributes)
  if (lineStart) result.line = Number(lineStart[1])
  if (lineEnd) result.lineEnd = Number(lineEnd[1])
  return result
}

function parseFileCitation(value: string, explicitLink = false): ParsedFileCitation | null {
  let target = value.trim()
  if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1)
  target = target.replaceAll('\\/', '/')
  if (
    !target ||
    /^(?:https?:|mailto:|data:|#(?!L\d))/iu.test(target) ||
    target.startsWith('opencode-source:') ||
    // Reject `:name{...}` directive tokens (e.g. backticked codex citations)
    // — they are markup, not file paths.
    /^:{1,3}[a-z0-9-]+\{/iu.test(target)
  ) {
    return null
  }

  let line: number | undefined
  let lineEnd: number | undefined
  const hashLocation = target.match(/#L(\d+)(?:-L?(\d+))?$/iu)
  if (hashLocation) {
    line = Number(hashLocation[1])
    lineEnd = hashLocation[2] ? Number(hashLocation[2]) : undefined
    target = target.slice(0, -hashLocation[0].length)
  } else {
    const colonLocation = target.match(/:(\d+)(?:-(\d+))?$/u)
    if (colonLocation) {
      line = Number(colonLocation[1])
      lineEnd = colonLocation[2] ? Number(colonLocation[2]) : undefined
      target = target.slice(0, -colonLocation[0].length)
    }
  }

  const path = normalizeCitationPath(target)
  const pathTail = path.split('/').at(-1) ?? ''
  const recognizablePath =
    explicitLink ||
    path.includes('/') ||
    path.startsWith('.') ||
    new RegExp(`\\.${FILE_EXT_PATTERN}$`, 'iu').test(pathTail)
  if (!path || !recognizablePath) return null
  return { path, line, lineEnd }
}

/** Parse an absolute filesystem path before asynchronous existence checks finish. */
export function parseAbsoluteFileCitationTarget(
  value: string
): { path: string; line?: number } | null {
  if (value.startsWith('file://')) return null
  const parsed = parseFileCitation(value, true)
  if (!parsed || !isAbsoluteCitationPath(parsed.path)) return null
  return {
    path: parsed.path,
    ...(parsed.line === undefined ? {} : { line: parsed.line })
  }
}

function citationHref(citation: ParsedFileCitation): string {
  const params = new URLSearchParams({ path: citation.path })
  if (citation.line) params.set('line', String(citation.line))
  if (citation.lineEnd) params.set('lineEnd', String(citation.lineEnd))
  return `#opencode-source:file?${params.toString()}`
}

function normalizeEscapedSlashes(value: string): string {
  return value.replaceAll('\\/', '/')
}

export function extractCitations(text: string): SourceCitation[] {
  const normalizedText = normalizeEscapedSlashes(text)
  const citations: SourceCitation[] = []
  const indexes = new Map<string, number>()

  function add(citation: SourceCitation): void {
    const key = citation.kind === 'file' ? `file:${citation.path}` : `web:${citation.url}`
    const existingIndex = indexes.get(key)
    if (existingIndex === undefined) {
      indexes.set(key, citations.length)
      citations.push(citation)
      return
    }
    const existing = citations[existingIndex]
    if (
      existing?.kind === 'file' &&
      citation.kind === 'file' &&
      existing.line === undefined &&
      citation.line !== undefined
    ) {
      citations[existingIndex] = citation
    }
  }

  for (const match of normalizedText.matchAll(MARKDOWN_LINK_PATTERN)) {
    const parsed = parseFileCitation(match[2] ?? match[3] ?? '', true)
    if (!parsed) continue
    add({ kind: 'file', ...parsed, raw: match[0] })
  }

  for (const match of normalizedText.matchAll(BACKTICK_CANDIDATE)) {
    const parsed = parseFileCitation(match[1] ?? '')
    if (!parsed) continue
    add({ kind: 'file', ...parsed, raw: match[0] })
  }

  for (const match of normalizedText.matchAll(PLAIN_WITH_LINE)) {
    const parsed = parseFileCitation(
      `${match[1] ?? ''}:${match[2] ?? ''}${match[3] ? `-${match[3]}` : ''}`
    )
    if (!parsed) continue
    add({ kind: 'file', ...parsed, raw: match[0] })
  }

  // Codex file citations are skipped inside fenced code blocks and inline code.
  scanMarkdownLines(normalizedText, (line, inFence) => {
    if (inFence) return
    const segments = line.split('`')
    for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 2) {
      const segment = segments[segmentIndex]
      if (!segment) continue
      for (const match of segment.matchAll(CODEX_CITATION_PATTERN)) {
        const parsed = parseCodexCitation(match[1] ?? '')
        if (!parsed) continue
        add({ kind: 'file', ...parsed, raw: match[0] })
      }
    }
  })

  for (const match of normalizedText.matchAll(MARKDOWN_WEB_LINK_PATTERN)) {
    add({
      kind: 'web',
      url: cleanUrl(match[2] ?? ''),
      raw: match[0]
    })
  }

  for (const match of normalizedText.matchAll(URL_PATTERN)) {
    const url = cleanUrl(match[0])
    add({ kind: 'web', url, raw: match[0] })
  }

  return citations
}

export function linkifyFileCitations(
  text: string,
  isValidPath?: (path: string) => boolean,
  isExternalPath?: (path: string) => boolean
): string {
  let result = normalizeEscapedSlashes(text)

  // A candidate becomes a link when it is confirmed either inside the active
  // project (`isValidPath`) or, for absolute paths, as an existing external
  // entry (`isExternalPath`). Both are verified asynchronously by main before
  // they ever return true, so every link target is known to exist on disk.
  const isClickable = (path: string): boolean =>
    isKnownCitation(path, isValidPath) || (isExternalPath?.(path) ?? false)

  // Codex `:codex-file-citation{path="..."}` tokens — fence- and inline-code
  // aware — become links only when the cited path is known (in the project or
  // an existing external absolute path).
  result = linkifyCodexCitations(result, isClickable)

  result = result.replace(
    MARKDOWN_LINK_PATTERN,
    (match, label: string, angleTarget?: string, plainTarget?: string) => {
      const parsed = parseFileCitation(angleTarget ?? plainTarget ?? '', true)
      if (!parsed || !isClickable(parsed.path)) return match
      return `[${label}](${citationHref(parsed)})`
    }
  )

  result = result.replace(BACKTICK_CANDIDATE, (match, value: string) => {
    const parsed = parseFileCitation(value)
    if (!parsed || !isClickable(parsed.path)) return match
    return `[\`${value}\`](${citationHref(parsed)})`
  })

  result = result.replace(
    PLAIN_WITH_LINE,
    (match, path: string, line: string, lineEnd?: string) => {
      const parsed = parseFileCitation(`${path}:${line}${lineEnd ? `-${lineEnd}` : ''}`)
      if (!parsed || !isClickable(parsed.path)) return match
      return `[\`${match}\`](${citationHref(parsed)})`
    }
  )

  return result
}

/** A file candidate becomes a link only when it is confirmed to exist on disk;
 *  without a validator (no project context) it is never linked. */
function isKnownCitation(path: string, isValidPath?: (path: string) => boolean): boolean {
  return isValidPath ? isValidPath(path) : false
}

/** Rewrite `:codex-file-citation{...}` tokens to citation links. Skips fenced
 *  code blocks and inline code spans; only known paths become links. */
function linkifyCodexCitations(text: string, isKnown: (path: string) => boolean): string {
  const out: string[] = []
  scanMarkdownLines(text, (line, inFence) => {
    if (inFence) {
      out.push(line)
      return
    }
    const segments = line.split('`')
    const linked = segments
      .map((segment, index) => {
        if (index % 2 === 1) return segment
        return segment.replace(CODEX_CITATION_PATTERN, (match, attributes: string) => {
          const parsed = parseCodexCitation(attributes ?? '')
          if (!parsed || !isKnown(parsed.path)) return match
          const name = parsed.path.split(/[\\/]/u).at(-1) || parsed.path
          return `[\`${name}\`](${citationHref(parsed)})`
        })
      })
      .join('`')
    out.push(linked)
  })
  return out.join('\n')
}

/** Extract the normalized file-citation paths a renderer should verify on disk. */
export function extractCitationCandidates(text: string): string[] {
  const candidates: string[] = []
  for (const citation of extractCitations(normalizeEscapedSlashes(text))) {
    if (citation.kind === 'file') candidates.push(citation.path)
  }
  return candidates
}

export function collectTextCitations(messages: AgentMessage[]): SourceCitation[] {
  const citations = new Map<string, SourceCitation>()
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const part of message.parts) {
      if (part.type !== 'text') continue
      for (const citation of extractCitations(part.text)) {
        const key = citation.kind === 'file' ? `file:${citation.path}` : `web:${citation.url}`
        const existing = citations.get(key)
        if (
          !existing ||
          (existing.kind === 'file' &&
            citation.kind === 'file' &&
            existing.line === undefined &&
            citation.line !== undefined)
        ) {
          citations.set(key, citation)
        }
      }
    }
  }
  return [...citations.values()]
}
