import type { AgentMessage } from '$shared/types'
import { isAbsoluteishPath, posixBasename, toPosixPath } from '$shared/paths'

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

// A citation's trailing line location. Ranges may be listed, comma separated
// (`:1-3,29-43`): the whole list belongs to the one citation, so the label keeps
// every range and nothing is left dangling behind the link. Only the first
// range becomes the link's line target.
const LINE_RANGES_SOURCE = '\\d+(?:-\\d+)?(?:,\\d+(?:-\\d+)?)*'
const LINE_RANGES_SUFFIX = new RegExp(`:(${LINE_RANGES_SOURCE})$`, 'u')
// A prose citation (`src/a/b.ts:12`) only counts when it is its own token. It may
// not be preceded by a word or path character (negative lookbehind), so a match
// can never start in the middle of a longer path or a URL, and it must be
// followed by sentence punctuation, a closing delimiter or end of line.
// Delimiters MAY precede it   that is how prose spells a citation, e.g.
// `(flag set at src/main/chat/chat-engine.ts:6774)`. The lookahead deliberately
// omits `]`: a trailing `]` means the candidate sits inside a markdown link
// label, which must never be rewritten from the inside.
const PLAIN_WITH_LINE = new RegExp(
  `(?<![\\w./~])((?:[\\w./-]+\\/)[\\w./-]+\\.${FILE_EXT_PATTERN}):(${LINE_RANGES_SOURCE})(?=$|[\\s.,;:!?)"'*_])`,
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
  return isAbsoluteishPath(value)
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
  path = toPosixPath(path).replace(/\/{2,}/gu, '/')
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

/** A path names something only when at least one of its segments is a real
 *  name. A separator-only candidate (`/`, `//`, `./`, `.`) normalizes to a
 *  root that resolves to the project directory, and linking it turned prose
 *  slashes into citation links, so it is not a citation at all. */
function hasNamedSegment(path: string): boolean {
  return path
    .split('/')
    .some((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
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
    //   they are markup, not file paths.
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
    const colonLocation = LINE_RANGES_SUFFIX.exec(target)
    if (colonLocation) {
      const [start, end] = (colonLocation[1] ?? '').split(',')[0]!.split('-')
      line = Number(start)
      lineEnd = end ? Number(end) : undefined
      target = target.slice(0, -colonLocation[0].length)
    }
  }

  const path = normalizeCitationPath(target)
  if (!path || !hasNamedSegment(path)) return null
  const pathTail = path.split('/').at(-1) ?? ''
  const recognizablePath =
    explicitLink ||
    path.includes('/') ||
    path.startsWith('.') ||
    new RegExp(`\\.${FILE_EXT_PATTERN}$`, 'iu').test(pathTail)
  if (!recognizablePath) return null
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
    const parsed = parseFileCitation(`${match[1] ?? ''}:${match[2] ?? ''}`)
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

  // Codex `:codex-file-citation{path="..."}` tokens   fence- and inline-code
  // aware   become links only when the cited path is known (in the project or
  // an existing external absolute path).
  result = linkifyCodexCitations(result, isClickable)

  // Every remaining pass runs line by line and never reaches inside fenced code
  // or an inline-code span. Rewriting a fragment of a span injects backticks
  // into it, the span breaks, and the citation link it was supposed to become
  // shows up as literal text in the thread, `#opencode-source:` target and all.
  const out: string[] = []
  scanMarkdownLines(result, (line, inFence) => {
    out.push(inFence ? line : linkifyLine(line, isClickable))
  })
  return out.join('\n')
}

/** Linkify one line of prose. Whole inline-code spans are claimed first, so the
 *  prose pass only ever sees the text between spans. */
function linkifyLine(line: string, isClickable: (path: string) => boolean): string {
  const withLinks = line.replace(
    MARKDOWN_LINK_PATTERN,
    (match, label: string, angleTarget?: string, plainTarget?: string) => {
      const parsed = parseFileCitation(angleTarget ?? plainTarget ?? '', true)
      if (!parsed || !isClickable(parsed.path)) return match
      return `[${label}](${citationHref(parsed)})`
    }
  )

  // Pair backticks by splitting once, left to right. Scanning them with a
  // regex whose opening backtick may not be preceded by `[`, which was there to
  // protect a markdown link label, desynchronizes the pairing as soon as a line
  // holds a backticked label such as `[\`path\`](url)`. Every later span is then
  // read from the wrong backtick: the text between two labels looked like a path
  // and prose slashes became `[/](#opencode-source:file?path=%2F)` links. A
  // split cannot drift, and a label span is recognized from its neighbors.
  const segments = withLinks.split('`')

  const out = segments.map((segment, index) =>
    index % 2 === 0 ? linkifyProseSegment(segment, isClickable) : segment
  )

  for (let index = 1; index < segments.length; index += 2) {
    const payload = segments[index] ?? ''
    // A span that is the label of a markdown link is never rewritten from the
    // inside; the link pass already handled its target.
    if (isInlineCodeLinkLabel(segments, index)) continue
    const parsed = parseFileCitation(payload)
    if (!parsed || !isClickable(parsed.path)) continue
    const before = out[index - 1]
    const after = out[index + 1]
    if (before === undefined || after === undefined) continue
    // The span's own backticks stay as the link label, so the opening `[` goes
    // on the segment before and the target on the segment after.
    out[index - 1] = `${before}[`
    out[index + 1] = `](${citationHref(parsed)})${after}`
  }

  return out.join('`')
}

/** Whether the inline-code span at `index` is the label of a markdown link
 *  (`[\`path\`](target)`), read from the segments around it. */
function isInlineCodeLinkLabel(segments: string[], index: number): boolean {
  const before = segments[index - 1] ?? ''
  const after = segments[index + 1] ?? ''
  return before.endsWith('[') && after.startsWith('](')
}

/** Linkify the parts of a line that sit outside inline code. */
function linkifyProseSegment(segment: string, isClickable: (path: string) => boolean): string {
  return segment.replace(
    PLAIN_WITH_LINE,
    (match, path: string, ranges: string, offset: number, whole: string) => {
      // A markdown link label always ends with `](`, so a citation followed by
      // at most emphasis markers and `](` is the text of a link, not a citation:
      // rewriting it would nest a link inside a link and break the label.
      if (/^[*_]{0,2}\]\(/u.test(whole.slice(offset + match.length))) return match
      const parsed = parseFileCitation(`${path}:${ranges}`)
      if (!parsed || !isClickable(parsed.path)) return match
      return `[\`${match}\`](${citationHref(parsed)})`
    }
  )
}

/** Split a markdown line into segments where even indices sit outside inline
 *  code and odd indices are code payloads. Link rewrites belong on even
 *  segments only. */
function splitAroundInlineCode(line: string): string[] {
  return line.split('`')
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
    const segments = splitAroundInlineCode(line)
    const linked = segments
      .map((segment, index) => {
        if (index % 2 === 1) return segment
        return segment.replace(CODEX_CITATION_PATTERN, (match, attributes: string) => {
          const parsed = parseCodexCitation(attributes ?? '')
          if (!parsed || !isKnown(parsed.path)) return match
          const name = posixBasename(parsed.path) || parsed.path
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
