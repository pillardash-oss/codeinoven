/**
 * Markdown pipeline for chat messages — stream friendly by design.
 *
 * The renderer works on `marked` lexer tokens instead of one big HTML string:
 * while a response streams in, only the trailing block token changes, so
 * earlier blocks keep their cached HTML and the DOM stays stable. An unclosed
 * ``` fence is lexed as a code block, which means code streams live into a
 * highlighted block instead of flashing as plain text first.
 */
import { Marked, type Token } from 'marked'
import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/common'
import { linkifyFileCitations } from '$lib/agent-source-citations'
import { citationPathsState } from '$lib/stores/citation-paths.svelte'

// A fragment URL survives DOMPurify's default URI policy while remaining
// entirely inside the renderer. MarkdownView intercepts it before navigation.
export const OPENCODE_SOURCE_PREFIX = '#opencode-source:'
export const LEGACY_OPENCODE_SOURCE_PREFIX = 'opencode-source:'

export interface MarkdownFileCitationTarget {
  path: string
  line?: number
}

/** Read both current and pre-migration citation hrefs. */
export function fileCitationTarget(href: string): MarkdownFileCitationTarget | null {
  const prefix = href.startsWith(OPENCODE_SOURCE_PREFIX)
    ? OPENCODE_SOURCE_PREFIX
    : href.startsWith(LEGACY_OPENCODE_SOURCE_PREFIX)
      ? LEGACY_OPENCODE_SOURCE_PREFIX
      : null
  if (!prefix) return null

  try {
    const url = new URL(href.substring(prefix.length), 'resolve://citation/')
    const path = url.searchParams.get('path')
    const line = url.searchParams.get('line')
    if (!path) return null
    return { path, ...(line ? { line: Number(line) } : {}) }
  } catch {
    return null
  }
}

// `breaks` keeps single newlines visible — chat prose relies on them the same
// way the previous `whitespace-pre-wrap` rendering did.
const marked = new Marked({ gfm: true, breaks: true })

// Only markdown syntax is parsed — raw HTML tags are shown as literal text.
marked.use({
  tokenizer: {
    html() {
      return undefined
    },
    tag() {
      return undefined
    }
  }
})

// Preserve citation metadata before DOMPurify removes a legacy custom-scheme
// href. Current fragment hrefs survive sanitization, but cached/persisted
// Markdown from the previous scheme must remain clickable too.
DOMPurify.addHook('beforeSanitizeAttributes', (node) => {
  if (node.tagName !== 'A') return
  const href = node.getAttribute('href')
  const citation = href ? fileCitationTarget(href) : null
  if (citation) {
    node.setAttribute('data-citation-path', citation.path)
    if (citation.line) node.setAttribute('data-citation-line', String(citation.line))
  }
})

// Links must leave the app through the default browser. Forcing them to
// `target="_blank"` routes clicks into the main process window-open handler,
// which denies the window and calls `shell.openExternal` instead.
// Citation links are handled through click delegation in MarkdownView.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName !== 'A') return
  if (node.getAttribute('data-citation-path')) {
    node.removeAttribute('target')
    node.removeAttribute('rel')
  } else {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noreferrer noopener')
  }
})

/** Split markdown source into top-level block tokens. */
export function lexMarkdown(text: string): Token[] {
  return marked.lexer(linkifyFileCitations(text, (path) => citationPathsState.isValidPath(path)))
}

// Rendered-block cache — every stream delta re-derives all tokens, but only
// the last one's `raw` actually changes. Keyed by raw source, bounded so a
// long session cannot grow it without limit.
const htmlCache = new Map<string, string>()
const HTML_CACHE_LIMIT = 500
const HTML_CACHE_VERSION = 2

/** Render a single non-code block token to sanitized HTML. */
export function blockHtml(token: Token): string {
  const cacheKey = `${HTML_CACHE_VERSION}:${token.raw}`
  const cached = htmlCache.get(cacheKey)
  if (cached !== undefined) return cached
  const html = DOMPurify.sanitize(marked.parser([token]))
  if (htmlCache.size >= HTML_CACHE_LIMIT) htmlCache.clear()
  htmlCache.set(cacheKey, html)
  return html
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Highlight code to HTML. Unknown or missing languages fall back to escaped
 * plain text — no auto-detection, which would jitter between grammars while
 * a block is still streaming. highlight.js output is escaped text plus
 * `<span class="hljs-*">` wrappers, so it needs no further sanitizing.
 */
export function highlightCode(code: string, lang?: string): string {
  if (lang && hljs.getLanguage(lang)) {
    try {
      return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
    } catch {
      // Grammar hiccup mid-stream — plain text below is always safe.
    }
  }
  return escapeHtml(code)
}
