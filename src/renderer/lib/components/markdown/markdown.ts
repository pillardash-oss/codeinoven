/**
 * Markdown pipeline for chat messages — stream friendly by design.
 *
 * The renderer works on `marked` lexer tokens instead of one big HTML string:
 * while a response streams in, only the trailing block token changes, so
 * earlier blocks keep their cached HTML and the DOM stays stable. An unclosed
 * ``` fence is lexed as a code block, which means code streams live into a
 * highlighted block instead of flashing as plain text first.
 */
import { Marked, type Token, type Tokens } from 'marked'
import DOMPurify from 'dompurify'
import hljs from 'highlight.js/lib/common'
import {
  collectSectionKeys,
  linkifyFileCitations,
  linkifySectionReferences,
  parseAbsoluteFileCitationTarget,
  sectionAnchor,
  sectionKeyFromHeading
} from '$lib/agent-source-citations'
import { citationPathsState } from '$lib/stores/citation-paths.svelte'
import { faviconState } from '$lib/stores/favicons.svelte'

// A fragment URL survives DOMPurify's default URI policy while remaining
// entirely inside the renderer. MarkdownView intercepts it before navigation.
export const OPENCODE_SOURCE_PREFIX = '#opencode-source:'

export interface MarkdownFileCitationTarget {
  path: string
  line?: number
}

/** Read the current citation href format. */
export function fileCitationTarget(href: string): MarkdownFileCitationTarget | null {
  const prefix = href.startsWith(OPENCODE_SOURCE_PREFIX) ? OPENCODE_SOURCE_PREFIX : null
  if (!prefix) return parseAbsoluteFileCitationTarget(href)

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

// GitHub-flavored footnotes, implemented natively because `marked-footnote`
// keeps module-level mutable state that only resets in `walkTokens` (which the
// app's streaming `lexer()` path never runs) and crashes on the second lex.
// Definitions become a single `footnotes` section hoisted to the bottom;
// references become superscript links. Undefined references stay literal text.

const FOOTNOTE_DEF_SOURCE = /^\[\^([^\]\n]+)\]:(?:[ \t]+|$)(.*(?:\n(?![ \t]*(?:\[\^|\n|$))[^\n]*)*)/

/**
 * Build a parser instance.
 *
 * `breaks` keeps single newlines visible — chat prose relies on them the same
 * way the previous `whitespace-pre-wrap` rendering did.
 *
 * With `allowHtml` false the HTML tokenizers are disabled outright, so raw
 * tags are shown as literal text and never reach the DOM. That is the right
 * default for agent output and anything typed into the app. `allowHtml` true
 * lets the tags through to DOMPurify, which is what content authored on
 * GitHub (pull request bodies and comments) needs to read correctly.
 */
function createMarked(allowHtml: boolean): Marked {
  const instance = new Marked({ gfm: true, breaks: true })

  if (!allowHtml) {
    instance.use({
      tokenizer: {
        html() {
          return undefined
        },
        tag() {
          return undefined
        }
      }
    })
  }

  instance.use({
    extensions: [
      {
        name: 'footnoteDef',
        level: 'block',
        childTokens: ['content'],
        tokenizer(src: string) {
          const match = FOOTNOTE_DEF_SOURCE.exec(src)
          if (!match) return undefined
          const [, label, rawContent = ''] = match
          const content = rawContent
            .split('\n')
            .map((line) => line.replace(/^(?: {4}|[\t])/, ''))
            .join('\n')
            .trimEnd()
          return {
            type: 'footnoteDef',
            raw: match[0],
            label,
            content: this.lexer.blockTokens(content)
          }
        },
        renderer() {
          return ''
        }
      },
      {
        name: 'footnoteRef',
        level: 'inline',
        start(src: string) {
          return src.indexOf('[^')
        },
        tokenizer(src: string) {
          const match = /^\[\^([^\]\n]+)\]/.exec(src)
          if (!match) return undefined
          const defined = (this.lexer.tokens as Token[]).some(
            (token) =>
              token.type === 'footnoteDef' && (token as { label?: string }).label === match[1]
          )
          if (!defined) return undefined
          return { type: 'footnoteRef', raw: match[0], label: match[1], number: 0, refIndex: 0 }
        },
        renderer(token: Tokens.Generic) {
          const label = encodeURIComponent(token.label ?? '')
          const suffix = (token.refIndex as number) > 0 ? `-${(token.refIndex as number) + 1}` : ''
          return `<sup class="footnote-ref"><a href="#fn-${label}" id="fnref-${label}${suffix}" data-footnote-ref aria-describedby="footnote-label">${String(token.number)}</a></sup>`
        }
      },
      {
        name: 'footnotes',
        renderer(token: Tokens.Generic) {
          const items = (token.items ?? []) as Array<{
            label: string
            number: number
            content: Token[]
            refCount: number
          }>
          if (items.length === 0) return ''
          const lis = items
            .map((item) => {
              const label = encodeURIComponent(item.label)
              const content = this.parser.parse(item.content).replace(/<\/p>\s*$/, '')
              const backrefs = Array.from({ length: item.refCount }, (_, index) => {
                const suffix = index > 0 ? `-${index + 1}` : ''
                return ` <a href="#fnref-${label}${suffix}" data-footnote-backref aria-label="Back to reference ${String(item.number)}">↩</a>`
              }).join('')
              return `<li id="fn-${label}">${content}${backrefs}${content ? '</p>' : ''}</li>`
            })
            .join('\n')
          return `<section class="footnotes" data-footnotes>\n<h2 id="footnote-label" class="sr-only">Footnotes</h2>\n<ol>\n${lis}\n</ol>\n</section>`
        }
      },
      {
        // Section-numbered headings get a stable anchor id (`section-2-3`) plus
        // a `data-section` marker so `§2.3` references and the Sources panel can
        // resolve the heading deterministically — even when several messages
        // carry the same section numbers.
        name: 'heading',
        renderer(token: Tokens.Generic) {
          const heading = token as Tokens.Heading
          const key = sectionKeyFromHeading(heading.text)
          const attrs = key ? ` id="${sectionAnchor(key)}" data-section="${escapeHtml(key)}"` : ''
          const content = this.parser.parseInline(heading.tokens)
          return `<h${heading.depth}${attrs}>${content}</h${heading.depth}>\n`
        }
      }
    ]
  })

  return instance
}

/** Default parser: raw HTML stays literal text. */
const marked = createMarked(false)
/** Parser for provider-authored content, where HTML is part of the format. */
const markedWithHtml = createMarked(true)

/**
 * Tags that never survive sanitizing, whatever the source.
 *
 * DOMPurify already drops `script` and every event-handler attribute, but its
 * default allow-list still permits `style`, `form`, and form controls — enough
 * to restyle or phish inside the panel. Naming them explicitly documents the
 * threat model and keeps it from drifting with DOMPurify's defaults.
 */
const SANITIZE_CONFIG = {
  // Keeps the string-returning `sanitize` overload; the renderer inserts the
  // result through `{@html}`, not a Trusted Types sink.
  RETURN_TRUSTED_TYPE: false,
  FORBID_TAGS: [
    'script',
    'iframe',
    'frame',
    'frameset',
    'object',
    'embed',
    'applet',
    'style',
    'link',
    'meta',
    'base',
    'form',
    'input',
    'button',
    'select',
    'option',
    'textarea'
  ],
  FORBID_ATTR: ['style', 'srcdoc', 'formaction', 'ping']
}

// Preserve citation metadata before DOMPurify removes the custom scheme
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
// Fragment links (footnotes, section anchors) stay inside the document.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName !== 'A') return
  const href = node.getAttribute('href')
  if (node.getAttribute('data-citation-path') || (href && href.startsWith('#'))) {
    node.removeAttribute('target')
    node.removeAttribute('rel')
  } else {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noreferrer noopener')
  }
})

/**
 * Split markdown source into top-level block tokens.
 *
 * Pass `allowHtml` only for content that came from a source where HTML is part
 * of the markdown dialect (GitHub pull requests). Anything the user or an
 * agent types must keep the default.
 */
export function lexMarkdown(text: string, allowHtml = false): Token[] {
  const parser = allowHtml ? markedWithHtml : marked
  const sectionLinked = linkifySectionReferences(text, collectSectionKeys(text))
  const tokens = parser.lexer(
    linkifyFileCitations(
      sectionLinked,
      (path) => citationPathsState.isValidPath(path),
      (path) => citationPathsState.isKnownExternalPath(path)
    )
  )
  return resolveFootnotes(tokens)
}

// ─── Footnote resolution ────────────────────────────────────────────────────
// Runs after lexing over the whole document so definitions anywhere can back
// references elsewhere. Numbering follows GitHub: order of first reference.
// Defined labels render as superscript links; a reference with no matching
// definition stays literal text. Definitions are removed from the flow and
// hoisted into a single `footnotes` section token appended at the end.

interface FootnoteRefToken extends Tokens.Generic {
  type: 'footnoteRef'
  label: string
  defined: boolean
  number: number
  refIndex: number
}

interface FootnoteDefToken extends Tokens.Generic {
  type: 'footnoteDef'
  label: string
  content: Token[]
}

interface FootnoteSectionToken extends Tokens.Generic {
  type: 'footnotes'
  items: Array<{
    label: string
    number: number
    refCount: number
    content: Token[]
  }>
}

function isFootnoteRef(token: Token): token is FootnoteRefToken {
  return token.type === 'footnoteRef'
}

function isFootnoteDef(token: Token): token is FootnoteDefToken {
  return token.type === 'footnoteDef'
}

function resolveFootnotes(tokens: Token[]): Token[] {
  const defs = new Map<string, FootnoteDefToken>()
  const refs: FootnoteRefToken[] = []
  const body: Token[] = []

  for (const token of tokens) {
    if (isFootnoteDef(token)) {
      if (!defs.has(token.label)) defs.set(token.label, token)
    } else {
      body.push(token)
    }
  }

  if (defs.size === 0) return body

  // Number every reference in document order; a label gets its number at its
  // first reference and all later refs to it share that number.
  let nextNumber = 1
  const numberByLabel = new Map<string, number>()
  const countByLabel = new Map<string, number>()
  marked.walkTokens(body, (token) => {
    if (!isFootnoteRef(token)) return
    token.defined = defs.has(token.label)
    if (!token.defined) return
    if (!numberByLabel.has(token.label)) numberByLabel.set(token.label, nextNumber++)
    token.number = numberByLabel.get(token.label) ?? 0
    token.refIndex = countByLabel.get(token.label) ?? 0
    countByLabel.set(token.label, (countByLabel.get(token.label) ?? 0) + 1)
    refs.push(token)
  })

  if (refs.length === 0) return body

  const items = [...numberByLabel.entries()]
    .sort((left, right) => left[1] - right[1])
    .map(([label, number]) => ({
      label,
      number,
      refCount: countByLabel.get(label) ?? 1,
      content: defs.get(label)?.content ?? []
    }))

  const section: FootnoteSectionToken = {
    type: 'footnotes',
    // The raw folds the definition sources in so the block cache re-renders as
    // definitions stream in (labels/numbers alone would stay cached forever).
    raw: items.map((item) => defs.get(item.label)?.raw ?? '').join('\n'),
    items
  }
  body.push(section)
  return body
}

// Rendered-block cache — every stream delta re-derives all tokens, but only
// the last one's `raw` actually changes. Keyed by raw source, bounded so a
// long session cannot grow it without limit. The favicon version is folded in
// so a resolved favicon re-renders a link with its icon (plain link before).
const htmlCache = new Map<string, string>()
const HTML_CACHE_LIMIT = 500
const HTML_CACHE_VERSION = 4

/** Render a single non-code block token to sanitized HTML. */
export function blockHtml(token: Token, allowHtml = false): string {
  const hasExternalLink = EXTERNAL_LINK_SOURCE_PATTERN.test(token.raw)
  const footnoteKey = footnoteCacheKey(token)
  // Only link-bearing blocks depend on favicon resolution, so the cache key is
  // stable for everything else (no re-render churn as favicons resolve). The
  // HTML mode is part of the key so the same source never serves the other
  // mode's output.
  const mode = allowHtml ? 'h' : 'p'
  const cacheKey = hasExternalLink
    ? `${HTML_CACHE_VERSION}:${mode}:f${faviconState.version}:${footnoteKey}:${token.raw}`
    : `${HTML_CACHE_VERSION}:${mode}:${footnoteKey}:${token.raw}`
  const cached = htmlCache.get(cacheKey)
  if (cached !== undefined) return cached
  const parser = allowHtml ? markedWithHtml : marked
  const sanitized = DOMPurify.sanitize(parser.parser([token]), SANITIZE_CONFIG)
  const html = hasExternalLink ? injectLinkFavicons(sanitized) : sanitized
  if (htmlCache.size >= HTML_CACHE_LIMIT) htmlCache.clear()
  htmlCache.set(cacheKey, html)
  return html
}

/**
 * Footnote resolution depends on the whole document (a reference is a link
 * only when its definition exists anywhere). That state changes mid-stream, so
 * it must be part of the cache key — otherwise a paragraph lexed before its
 * footnote definition arrives would keep the literal `[^2]` forever.
 */
function footnoteCacheKey(token: Token): string {
  if (!token.raw.includes('[^')) return ''
  const parts: string[] = []
  collectFootnoteRefs(token, (ref) => {
    parts.push(`${ref.label}:${ref.defined ? '1' : '0'}:${ref.number}:${ref.refIndex}`)
  })
  return parts.length > 0 ? `n${parts.join('|')}` : ''
}

function collectFootnoteRefs(token: Token, visit: (ref: FootnoteRefToken) => void): void {
  if (isFootnoteRef(token)) {
    visit(token)
    return
  }
  const children = (token as { tokens?: Token[] }).tokens
  if (!Array.isArray(children)) return
  for (const child of children) collectFootnoteRefs(child, visit)
}

const EXTERNAL_LINK_SOURCE_PATTERN = /https?:\/\//iu
const EXTERNAL_LINK_OPEN = /<a\b[^>]*\bhref="https?:\/\/[^"]+"[^>]*>/giu

/**
 * Insert a favicon into external link anchors. The renderer CSP blocks remote
 * images, so only already-resolved `data:` URLs are injected; unresolved links
 * stay plain until `faviconState.version` bumps and the block re-renders.
 */
function injectLinkFavicons(html: string): string {
  return html.replace(EXTERNAL_LINK_OPEN, (anchor) => {
    const href = /\bhref="(https?:\/\/[^"]+)"/iu.exec(anchor)?.[1]
    if (!href) return anchor
    const dataUrl = faviconState.faviconFor(href)
    if (!dataUrl) return anchor
    return `${anchor}<img class="markdown-link-favicon" src="${dataUrl}" alt="" loading="lazy">`
  })
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
