/**
 * Markdown pipeline for chat messages   stream friendly by design.
 *
 * The renderer works on `marked` lexer tokens instead of one big HTML string:
 * while a response streams in, only the trailing block token changes, so
 * earlier blocks keep their cached HTML and the DOM stays stable. An unclosed
 * ``` fence is lexed as a code block, which means code streams live into a
 * highlighted block instead of flashing as plain text first.
 */
import { Marked, walkTokens, type Token, type Tokens } from 'marked'
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
import { githubImageState } from '$lib/stores/github-images.svelte'
import { schemeState } from '$lib/stores/scheme.svelte'
import type { ResolvedTheme } from '$lib/theme'
import {
  EMOJI_GLYPH_PATTERN,
  HTML_SOURCE_TAG,
  IMAGE_ATTR_ALT,
  IMAGE_ATTR_CLASS,
  IMAGE_ATTR_SRC,
  IMAGE_ATTR_SRC_ANY,
  IMAGE_ATTR_SRCSET_ANY,
  IMAGE_TAG,
  TAG_ATTR_SRCSET,
  decodeMarkdownAttribute,
  firstSrcsetUrl,
  hasRemoteImage,
  isDarkSchemeSource
} from '$lib/markdown-remote-images'
import { githubReferencesExtension, type GithubRepoContext } from '$lib/github-references'
import { githubEmojiExtension } from './github-emoji'

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
 * `breaks` keeps single newlines visible   chat prose relies on them the same
 * way the previous `whitespace-pre-wrap` rendering did.
 *
 * With `allowHtml` false the HTML tokenizers are disabled outright, so raw
 * tags are shown as literal text and never reach the DOM. That is the right
 * default for agent output and anything typed into the app. `allowHtml` true
 * lets the tags through to DOMPurify, which is what content authored on
 * GitHub (pull request bodies and comments) needs to read correctly.
 *
 * `repository` is the repository the content was authored in. It enables
 * GitHub's own reference linkification (`#150`, `@login`), which is meaningless
 * without knowing where the text came from, so it stays off everywhere else.
 *
 * Emoji shortcodes are expanded in both modes: `:wave:` becomes 👋 wherever it
 * appears, because a shortcode that is not a real emoji name stays literal and
 * the expansion is therefore never wrong, only useful.
 */
function createMarked(allowHtml: boolean, repository: GithubRepoContext | null): Marked {
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
      githubEmojiExtension,
      // Registered last so the built-in link and URL tokenizers win wherever
      // they also match; a reference only tokenizes when nothing else claimed
      // the position first.
      ...(repository ? [githubReferencesExtension(repository)] : []),
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
        // resolve the heading deterministically   even when several messages
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

/**
 * Parser instances, keyed by content mode and repository.
 *
 * Reference linkification is repo-scoped, so a parser cannot be a single shared
 * constant any more. The set stays tiny (a session reads a handful of
 * repositories) and is bounded, and a parser is reused across every block of
 * every message in that repository instead of being rebuilt per render.
 */
const parserCache = new Map<string, Marked>()
const PARSER_CACHE_LIMIT = 8

function parserFor(allowHtml: boolean, repository: GithubRepoContext | null): Marked {
  const key = `${allowHtml ? 'h' : 'p'}:${repository ? `${repository.owner}/${repository.repo}` : ''}`
  const cached = parserCache.get(key)
  if (cached) return cached
  const parser = createMarked(allowHtml, repository)
  if (parserCache.size >= PARSER_CACHE_LIMIT) parserCache.clear()
  parserCache.set(key, parser)
  return parser
}

/**
 * Tags that never survive sanitizing, whatever the source.
 *
 * DOMPurify already drops `script` and every event-handler attribute, but its
 * default allow-list still permits `style`, `form`, and form controls   enough
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
export function lexMarkdown(
  text: string,
  allowHtml = false,
  repository: GithubRepoContext | null = null
): Token[] {
  const parser = parserFor(allowHtml, repository)
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

/** Bounded memo cache for lexed message markdown. Completed message text is
 *  immutable, but the lex OUTPUT also depends on the reactive citation-path
 *  state (file citations become links only once their existence is confirmed),
 *  so the cache key folds in the store's revision. Without it, a cache hit
 *  after a resolution bump would return stale, un-linkified tokens forever  
 *  the reason linkify appeared dead until a thread was left and re-opened.
 *  Entries hold the exact source string as key; callers treat the returned
 *  tokens as read-only (blockHtml already memoizes its output). */
const LEX_CACHE_LIMIT = 24
const lexCache = new Map<string, Token[]>()

export function lexMarkdownCached(
  text: string,
  allowHtml = false,
  repository: GithubRepoContext | null = null
): Token[] {
  // Read the revision in the caller's reactive context so a resolution bump
  // re-evaluates this expression, and use it as part of the key so the bumped
  // evaluation cannot hit a stale pre-resolution entry. The repository belongs in
  // the key too: the same text lexes to different links in a different repo.
  const revision = citationPathsState.revision
  const scope = repository ? `${repository.owner}/${repository.repo}` : ''
  const key = `\u0000rev${revision}\u0000${allowHtml ? '\u0000html\u0000' : ''}\u0000${scope}\u0000${text}`
  const cached = lexCache.get(key)
  if (cached) {
    // Refresh for LRU ordering   most recently used survives eviction.
    lexCache.delete(key)
    lexCache.set(key, cached)
    return cached
  }
  const tokens = lexMarkdown(text, allowHtml, repository)
  lexCache.set(key, tokens)
  if (lexCache.size > LEX_CACHE_LIMIT) {
    const oldest = lexCache.keys().next().value
    if (oldest !== undefined) lexCache.delete(oldest)
  }
  return tokens
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
  walkTokens(body, (token) => {
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

// Rendered-block cache   every stream delta re-derives all tokens, but only
// the last one's `raw` actually changes. Keyed by raw source, bounded so a
// long session cannot grow it without limit. The favicon and image versions are
// folded in so a resolved picture re-renders the block that waits on it, and the
// repository is part of the key because the same text links differently in it.
const htmlCache = new Map<string, string>()
const HTML_CACHE_LIMIT = 500
// Bumped from 4 by the emoji shortcode, reference linkification and inlined image
// renderers: the same source now produces different HTML, so every entry a
// previous version of this file cached must be recomputed.
const HTML_CACHE_VERSION = 5

/**
 * Render a single non-code block token to sanitized HTML.
 *
 * `repository` scopes GitHub reference linkification and belongs in the cache
 * key: `#150` is a different link depending on the repository the text came
 * from, so two repositories must never share a rendered block.
 */
export function blockHtml(
  token: Token,
  allowHtml = false,
  repository: GithubRepoContext | null = null
): string {
  const hasExternalLink = EXTERNAL_LINK_SOURCE_PATTERN.test(token.raw)
  const hasImage = hasRemoteImage(token.raw)
  const footnoteKey = footnoteCacheKey(token)
  // Only link- and image-bearing blocks depend on resolution, so the cache key is
  // stable for everything else (no re-render churn as pictures resolve). The
  // HTML mode is part of the key so the same source never serves the other
  // mode's output.
  const mode = allowHtml ? 'h' : 'p'
  const scope = repository ? `${repository.owner}/${repository.repo}` : ''
  const resolution = `${hasExternalLink ? `f${faviconState.version}` : ''}${
    hasImage ? `i${githubImageState.version}` : ''
  }`
  // A picture's variant depends on the app's scheme, so that is part of the key
  // for a picture-bearing block only: folding it into every image block would make
  // a theme switch recompute HTML that cannot differ.
  const variant = PICTURE_SOURCE.test(token.raw) ? `v${schemeState.isDark ? 'd' : 'l'}` : ''
  const cacheKey = `${HTML_CACHE_VERSION}:${mode}:${scope}:${resolution}${variant}:${footnoteKey}:${token.raw}`
  const cached = htmlCache.get(cacheKey)
  if (cached !== undefined) return cached
  const parser = parserFor(allowHtml, repository)
  const sanitized = DOMPurify.sanitize(parser.parser([token]), SANITIZE_CONFIG)
  const withFavicons = hasExternalLink ? injectLinkFavicons(sanitized) : sanitized
  const html = hasImage
    ? injectContentImages(selectPictureVariant(withFavicons, schemeState.current))
    : withFavicons
  if (htmlCache.size >= HTML_CACHE_LIMIT) htmlCache.clear()
  htmlCache.set(cacheKey, html)
  return html
}

/**
 * Render a raw HTML fragment that a container split out of its block.
 *
 * An HTML block's own markup   the `<summary>` inside a `<details>`, or the
 * text between two elements   has to be sanitized exactly like a whole block,
 * images and favicons included, so it takes the same path `blockHtml` does. The
 * synthetic token carries the fragment as both source and text, which is what
 * marked's own HTML renderer passes through.
 *
 * `allowHtml` is not a parameter because only HTML mode ever produces a
 * fragment: with the HTML tokenizers off there is no raw markup to split.
 */
export function htmlFragment(raw: string, repository: GithubRepoContext | null = null): string {
  if (!raw.trim()) return ''
  const token: Tokens.HTML = { type: 'html', block: true, raw, pre: false, text: raw }
  return blockHtml(token, true, repository)
}

/**
 * Footnote resolution depends on the whole document (a reference is a link
 * only when its definition exists anywhere). That state changes mid-stream, so
 * it must be part of the cache key   otherwise a paragraph lexed before its
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
/**
 * A whole external anchor: its attributes, its href and its content.
 *
 * Matching the element rather than its opening tag is what makes the favicon
 * decision below possible — whether an image already *is* the link cannot be
 * answered from the opening tag alone.
 */
const EXTERNAL_LINK_ANCHOR = /<a\b([^>]*\bhref="(https?:\/\/[^"]*)"[^>]*)>([\s\S]*?)<\/a>/giu

/**
 * Insert a favicon into external link anchors. The renderer CSP blocks remote
 * images, so only already-resolved `data:` URLs are injected; unresolved links
 * stay plain until `faviconState.version` bumps and the block re-renders.
 *
 * An anchor whose content is already a picture gets nothing: a bot comment that
 * links its own logo writes `<a href="…"><img …></a>`, and a favicon there would
 * be a second image inside the same link.
 */
function injectLinkFavicons(html: string): string {
  return html.replace(
    EXTERNAL_LINK_ANCHOR,
    (anchor: string, attributes: string, href: string, inner: string) => {
      if (isMediaOnlyAnchor(inner)) return anchor
      const dataUrl = faviconState.faviconFor(href)
      if (!dataUrl) return anchor
      return `<a${attributes}><img class="markdown-link-favicon" src="${dataUrl}" alt="" loading="lazy">${inner}</a>`
    }
  )
}

/**
 * Whether an anchor draws a picture and nothing else.
 *
 * Text is what a favicon sits beside; an anchor that is only an image has no
 * text to decorate. `&nbsp;` is not text: it is the spacing a bot footer pads
 * its logo with.
 */
function isMediaOnlyAnchor(inner: string): boolean {
  if (!/<(?:img|picture|svg|video)\b/iu.test(inner)) return false
  return (
    inner
      .replace(/<[^>]*>/gu, '')
      .replace(/&nbsp;/giu, '')
      .trim() === ''
  )
}

const PICTURE_ELEMENT = /<picture\b[^>]*>([\s\S]*?)<\/picture>/giu
/** Whether a source can hold a `<picture>` at all, for the cache key. */
const PICTURE_SOURCE = /<picture\b/iu
const IMG_TAG = /<img\b[^>]*>/iu

/**
 * The remote URL of a `<picture>`'s dark asset, as written, or null.
 *
 * Read from the tag rather than from a capture group of the whole element because
 * a picture can carry several sources (format hints, width queries), and only the
 * one asking for a dark surface is a second *picture* rather than a second
 * encoding of the same one.
 */
function darkPictureSource(inner: string): string | null {
  for (const match of inner.matchAll(HTML_SOURCE_TAG)) {
    const tag = match[0]
    if (!isDarkSchemeSource(tag)) continue
    const srcset = TAG_ATTR_SRCSET.exec(tag)?.[1]
    if (!srcset) continue
    return firstSrcsetUrl(srcset)
  }
  return null
}

/**
 * Replace a `<picture>` with the one asset this app should draw.
 *
 * A provider offers its artwork twice: a `<source media="(prefers-color-scheme:
 * dark)">` for a dark surface, and the `<img>` beside it as the fallback. Both are
 * remote, and the renderer CSP blocks remote hosts, so what has to survive is one
 * `<img>` whose `src` this module can then inline. Which one is decided by the
 * app's own scheme rather than by the browser: the media query inside the source
 * asks the OS, so a reader who picked light in Appearance while their OS is dark
 * would get dark artwork on a light panel.
 *
 * Replacing the `src` instead of rebuilding the tag keeps the `<img>`'s other
 * attributes (alt, width, height, class), which GitHub's logo relies on for its
 * 9px box.
 */
function selectPictureVariant(html: string, scheme: ResolvedTheme): string {
  return html.replace(PICTURE_ELEMENT, (whole: string, inner: string) => {
    const imgTag = IMG_TAG.exec(inner)?.[0] ?? null
    // Anything else in the picture is an encoding hint whose URL the fallback
    // already covers, so a light app has nothing to choose between.
    const dark = scheme === 'dark' ? darkPictureSource(inner) : null
    if (!dark) return imgTag ?? whole
    if (!imgTag) return `<img src="${dark}" alt="">`
    return imgTag.replace(IMAGE_ATTR_SRC_ANY, `src="${dark}"`)
  })
}

/**
 * Replace every remote `<img>` with something the renderer is allowed to draw.
 *
 * The CSP permits `img-src 'self' data:` and nothing remote, so an image in a
 * GitHub body currently renders as a broken-image icon. Three outcomes:
 *
 * - an emoji-class image whose alt is already the glyph   drawn as the glyph;
 * - a URL main has already inlined   the `data:` URL replaces the remote one,
 *   keeping every other attribute (alt, width, height, class) untouched;
 * - anything still unresolved   a labelled placeholder, so an unloaded picture
 *   reads as a picture rather than as a failure.
 *
 * Resolution is asynchronous and version-driven: `githubImageState.version` is
 * part of the block's cache key, so a landed picture re-renders this block with
 * the `data:` URL.
 */
function injectContentImages(html: string): string {
  return html.replace(IMAGE_TAG, (tag) => {
    const encodedSrc = IMAGE_ATTR_SRC.exec(tag)?.[1]
    if (!encodedSrc || !/^https:\/\//iu.test(encodedSrc)) return tag
    const src = decodeMarkdownAttribute(encodedSrc)
    const alt = decodeMarkdownAttribute(IMAGE_ATTR_ALT.exec(tag)?.[1] ?? '')
    const className = decodeMarkdownAttribute(IMAGE_ATTR_CLASS.exec(tag)?.[1] ?? '')

    if (/\bemoji\b/u.test(className) && EMOJI_GLYPH_PATTERN.test(alt.trim())) {
      return `<span class="emoji">${escapeHtml(alt.trim())}</span>`
    }

    const dataUrl = githubImageState.imageFor(src)
    if (dataUrl) {
      // `srcset` wins over `src` wherever a browser can use it, and every URL in
      // it is a remote one this renderer cannot draw, so the attribute has to go
      // with the `src` it replaces.
      return tag.replace(IMAGE_ATTR_SRC_ANY, `src="${dataUrl}"`).replace(IMAGE_ATTR_SRCSET_ANY, '')
    }

    const label = escapeHtmlAttribute(alt)
    return `<span class="markdown-image-pending" role="img" aria-label="${label}" title="${label}">${escapeHtml(alt)}</span>`
  })
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * Escape a value that lands inside a double-quoted attribute.
 *
 * Distinct from `escapeHtml` on purpose: a quote in text content is harmless and
 * `&quot;` there is noise, but a quote in an attribute value breaks out of it. The
 * alt this escapes comes from third-party markdown, and the markup below is
 * inserted after sanitizing, so nothing else would catch it.
 */
function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value).replace(/"/g, '&quot;')
}

/**
 * Highlight code to HTML. Unknown or missing languages fall back to escaped
 * plain text   no auto-detection, which would jitter between grammars while
 * a block is still streaming. highlight.js output is escaped text plus
 * `<span class="hljs-*">` wrappers, so it needs no further sanitizing.
 */
/** Highlighting beyond this budget is skipped   the tail renders as plain
 *  escaped text inside the same block. Tokenizing a 100KB+ single-line dump
 *  can block the renderer for tens of milliseconds per block, and grammar
 *  coloring past the first screenful adds nothing a reader can perceive. */
const HIGHLIGHT_BUDGET = 32 * 1024

export function highlightCode(code: string, lang?: string): string {
  if (lang && hljs.getLanguage(lang)) {
    // Slice BEFORE highlighting: hljs tokenizes exactly the budgeted text, so
    // every span it emits is balanced. The remainder is appended as escaped
    // plain text   visually uniform, structurally valid HTML.
    const budgeted = code.length > HIGHLIGHT_BUDGET ? code.slice(0, HIGHLIGHT_BUDGET) : code
    try {
      const highlighted = hljs.highlight(budgeted, { language: lang, ignoreIllegals: true }).value
      if (budgeted.length < code.length) {
        return highlighted + escapeHtml(code.slice(HIGHLIGHT_BUDGET))
      }
      return highlighted
    } catch {
      // Grammar hiccup mid-stream   plain text below is always safe.
    }
  }
  return escapeHtml(code)
}
