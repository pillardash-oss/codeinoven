/**
 * HTML containers in provider-authored markdown.
 *
 * A GitHub comment can open a block element and leave it open across a blank
 * line, which is how every bot comment on the platform writes a collapsible log:
 *
 * ```html
 * <details><summary>Recent agent stderr</summary>
 *
 * ```
 * …
 * ```
 *
 * </details>
 * ```
 *
 * CommonMark ends the HTML block at the first blank line, so the fenced block
 * arrives as its own token, and the browser only nests it inside the `<details>`
 * because it parses the *whole* document at once. This renderer draws each block
 * token as its own node, so an element opened in one block is already closed by
 * the time the next block's markup is parsed and the fold ends up empty.
 *
 * The fix is to keep the document's own nesting: a token run is turned into a
 * tree where an unclosed container tag becomes a real element and every following
 * block token becomes its child. Nothing here parses or rewrites markup — a tag
 * is only a *boundary*, and its own text stays in the fragment rendered through
 * the existing sanitizer.
 */
import type { Token } from 'marked'

/** A block token, drawn by its own renderer. */
export interface MarkdownTokenNode {
  kind: 'token'
  token: Token
}

/** Raw HTML that belongs to the surrounding level, sanitized as one run. */
export interface MarkdownHtmlNode {
  kind: 'html'
  raw: string
}

/** An element that is still open when the next block token arrives. */
export interface MarkdownContainerNode {
  kind: 'container'
  /** Lowercase tag name, ready for a dynamic element. */
  tag: string
  /** Sanitized-by-allow-list attributes from the opening tag. */
  attrs: Record<string, string | true>
  children: MarkdownNode[]
}

export type MarkdownNode = MarkdownTokenNode | MarkdownHtmlNode | MarkdownContainerNode

/**
 * Tags whose contribution to the parse a browser keeps open across siblings.
 *
 * Deliberately excludes the tags the HTML parser auto-closes (`p`, `li`, `td`,
 * `option`…) and inferred containers (`table`, `tbody`): making those into
 * element nodes would nest content the browser would have made a sibling of.
 * Inline tags stay out too, so an unclosed `<span>` keeps behaving the way it
 * does today — closed at the end of its own fragment.
 */
const CONTAINER_TAGS = new Set([
  'details',
  'summary',
  'div',
  'section',
  'article',
  'aside',
  'figure',
  'figcaption',
  'header',
  'footer',
  'main',
  'nav',
  'blockquote',
  'pre'
])

/** Elements with no closing tag, so they can never be a container. */
const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr'
])

/**
 * Attributes carried onto a container element. The container is a real DOM node
 * built by the renderer rather than an `{@html}` string, so it never passes
 * through DOMPurify: this list is the sanitizer for it. It is deliberately
 * presentational only — no `src`, no `href`, and above all no `on*`, which would
 * be written straight onto the element as a property.
 */
const CONTAINER_ATTRIBUTES = new Set(['open', 'class', 'id', 'title', 'dir', 'lang', 'role'])

/** A comment, doctype or tag. Quoted values may contain `>` of their own. */
const HTML_TAG_PATTERN = /<!--[\s\S]*?-->|<\/?[a-zA-Z!](?:"[^"]*"|'[^']*'|[^'">])*>/gu
const TAG_NAME_PATTERN = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)/
const TAG_ATTRIBUTES_PATTERN = /<[a-zA-Z][a-zA-Z0-9-]*((?:"[^"]*"|'[^']*'|[^'">])*)/
const ATTRIBUTE_PATTERN = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu

interface HtmlTag {
  /** Offset of the `<`. */
  start: number
  /** Offset just past the `>`. */
  end: number
  name: string
  closing: boolean
  selfClosing: boolean
  attributes: string
}

/** Every tag in a raw HTML run, in document order, comments and doctypes skipped. */
function scanTags(source: string): HtmlTag[] {
  const tags: HtmlTag[] = []
  for (const match of source.matchAll(HTML_TAG_PATTERN)) {
    const text = match[0]
    const name = TAG_NAME_PATTERN.exec(text)?.[1]?.toLowerCase()
    if (!name) continue
    const start = match.index ?? 0
    tags.push({
      start,
      end: start + text.length,
      name,
      closing: text.startsWith('</'),
      selfClosing: text.endsWith('/>') || VOID_TAGS.has(name),
      attributes: TAG_ATTRIBUTES_PATTERN.exec(text)?.[1] ?? ''
    })
  }
  return tags
}

/**
 * The open tags this run closes itself. An open tag that is *not* in here is
 * still open when the run ends, which is exactly what makes it a container.
 */
function matchedOpenTags(tags: HtmlTag[]): Set<HtmlTag> {
  const opened: HtmlTag[] = []
  const matched = new Set<HtmlTag>()
  for (const tag of tags) {
    if (tag.closing) {
      for (let index = opened.length - 1; index >= 0; index -= 1) {
        if (opened[index].name === tag.name) {
          matched.add(opened[index])
          opened.splice(index, 1)
          break
        }
      }
      continue
    }
    if (!tag.selfClosing) opened.push(tag)
  }
  return matched
}

/** Attribute text to the allow-listed subset a container element may carry. */
function parseContainerAttributes(attributes: string): Record<string, string | true> {
  const parsed: Record<string, string | true> = {}
  for (const match of attributes.matchAll(ATTRIBUTE_PATTERN)) {
    const name = match[1].toLowerCase()
    if (!CONTAINER_ATTRIBUTES.has(name)) continue
    parsed[name] = match[2] ?? match[3] ?? match[4] ?? true
  }
  return parsed
}

/** The raw HTML a token carries, or null when it is not an HTML block. */
function htmlTokenText(token: Token): string | null {
  if (token.type !== 'html') return null
  const text = (token as { text?: unknown }).text
  return typeof text === 'string' ? text : token.raw
}

/**
 * Turn a block token run into a render tree.
 *
 * Every token keeps its position; only a run that leaves a container open gains
 * a level. A run with no HTML in it comes back as the same sequence of token
 * nodes, so nothing changes for the markdown the app and its agents write.
 */
export function groupHtmlContainers(tokens: Token[]): MarkdownNode[] {
  const root: MarkdownNode[] = []
  const open: MarkdownContainerNode[] = []
  const sink = (): MarkdownNode[] => (open.length > 0 ? open[open.length - 1].children : root)
  const addFragment = (raw: string): void => {
    if (!raw.trim()) return
    sink().push({ kind: 'html', raw })
  }

  for (const token of tokens) {
    const raw = htmlTokenText(token)
    if (raw === null) {
      sink().push({ kind: 'token', token })
      continue
    }
    const tags = scanTags(raw)
    if (tags.length === 0) {
      addFragment(raw)
      continue
    }
    const matched = matchedOpenTags(tags)
    let cursor = 0
    for (const tag of tags) {
      if (tag.closing) {
        const innermost = open[open.length - 1]
        if (innermost && innermost.tag === tag.name) {
          addFragment(raw.slice(cursor, tag.start))
          open.pop()
          cursor = tag.end
        }
        continue
      }
      if (tag.selfClosing || matched.has(tag) || !CONTAINER_TAGS.has(tag.name)) continue
      addFragment(raw.slice(cursor, tag.start))
      const container: MarkdownContainerNode = {
        kind: 'container',
        tag: tag.name,
        attrs: parseContainerAttributes(tag.attributes),
        children: []
      }
      sink().push(container)
      open.push(container)
      cursor = tag.end
    }
    addFragment(raw.slice(cursor))
  }

  return root
}
