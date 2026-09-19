/**
 * Where images live in provider-authored markdown, and how to read them back.
 *
 * Two callers need the same answer and must not drift apart: the markdown
 * renderer, which rewrites an `<img>` into something the CSP allows, and the
 * image store, which has to know which URLs to ask main for. The renderer works
 * on sanitized HTML and the store works on raw source, so the rules sit here
 * once instead of being spelled twice with two chances to disagree.
 *
 * Provider content is the reason both spellings matter. GitHub renders
 * `![alt](url)` to an `<img>`, and its API also returns raw HTML for the parts of
 * a comment it generates itself (a bot's footer line carries `<img>` tags), so a
 * source can legitimately contain either.
 */

/** `![alt](https://…)` in markdown source. Capture group 1 is the URL. */
export const MARKDOWN_IMAGE_SOURCE = /!\[[^\]]*\]\(\s*(https:\/\/[^\s)]+)/gu

/** `<img src="https://…">` in raw HTML. Capture group 1 is the escaped URL. */
export const HTML_IMAGE_SOURCE = /<img\b[^>]*\bsrc="(https:\/\/[^"]*)"/giu

/**
 * A `<source>` tag inside a provider's `<picture>`, exactly as written.
 *
 * This is the dark half of a picture: GitHub's markdown offers a second asset for
 * a dark surface and lets the browser choose it with
 * `media="(prefers-color-scheme: dark)"`. Only `<img src>` used to be read, so the
 * variant was never fetched and the renderer had nothing to pick.
 */
export const HTML_SOURCE_TAG = /<source\b[^>]*>/giu

/** The `srcset` attribute of a tag, as written. */
export const TAG_ATTR_SRCSET = /\bsrcset="([^"]*)"/iu

/** The `media` attribute of a tag, as written. */
export const TAG_ATTR_MEDIA = /\bmedia="([^"]*)"/iu

/**
 * Whether a `<source>` tag is the one a browser picks on a dark surface.
 *
 * The one rule that has to hold on both sides: the store uses it to decide which
 * URL to fetch, and the renderer uses it to decide which URL to draw. A loose
 * `includes('dark')` would treat any media query mentioning the word as the dark
 * asset, and the two sides reading different sources is how a picture ends up
 * fetched but never drawn.
 */
export function isDarkSchemeSource(tag: string): boolean {
  const media = TAG_ATTR_MEDIA.exec(tag)?.[1]
  if (media === undefined) return false
  return /prefers-color-scheme\s*:\s*dark/iu.test(decodeMarkdownAttribute(media))
}

/**
 * The first URL in a `srcset` candidate list, when it is a remote one.
 *
 * A `srcset` is `url [descriptor], url [descriptor], …`, and a descriptor (`2x`,
 * `640w`) selects a resolution rather than a different picture: the first
 * candidate is the one to inline. Provider content writes a single candidate, and
 * a dark-mode asset gets its own `<source>` instead of a second candidate.
 */
export function firstSrcsetUrl(srcset: string): string | null {
  const candidate = srcset.split(',')[0]?.trim().split(/\s+/)[0] ?? ''
  return /^https:\/\//iu.test(candidate) ? candidate : null
}

/** An `<img>` tag in sanitized HTML. */
export const IMAGE_TAG = /<img\b[^>]*>/giu

/** `src="…"` anywhere inside a tag. */
export const IMAGE_ATTR_SRC = /\bsrc="([^"]*)"/iu

/** The whole `src="…"` attribute, for a wholesale replacement. */
export const IMAGE_ATTR_SRC_ANY = /\bsrc="[^"]*"/iu

/**
 * The whole `srcset="…"` attribute.
 *
 * Dropped when an image is inlined: a browser prefers `srcset` over `src`
 * wherever it can use it, and every URL in a provider-authored `srcset` is a
 * remote one the renderer CSP cannot load, so leaving it would keep the broken
 * picture the `data:` URL was meant to replace.
 */
export const IMAGE_ATTR_SRCSET_ANY = /\ssrcset="[^"]*"/iu

/** `alt="…"` anywhere inside a tag. */
export const IMAGE_ATTR_ALT = /\balt="([^"]*)"/iu

/** `class="…"` anywhere inside a tag. */
export const IMAGE_ATTR_CLASS = /\bclass="([^"]*)"/iu

/**
 * Whether a markdown source can produce a remote image at all.
 *
 * A cheap pre-test so the common case (no image anywhere in the block) never
 * pays for the extraction, and so a block with no image keeps a stable
 * resolution-independent cache key. Deliberately loose about a `<source>`: any
 * srcset pointing at a remote URL takes the image path, and which of those URLs is
 * actually wanted is settled later by `isDarkSchemeSource`.
 */
export function hasRemoteImage(source: string): boolean {
  return /(?:!\[[^\]]*\]\(\s*https:\/\/)|(?:<img\b[^>]*\bsrc="https:\/\/)|(?:<source\b[^>]*\bsrcset="[^"]*https:\/\/)/iu.test(
    source
  )
}

/** Undo the entity escaping DOMPurify applied to an attribute value. */
export function decodeMarkdownAttribute(value: string): string {
  return (
    value
      .replace(/&quot;/gu, '"')
      .replace(/&#39;/gu, "'")
      .replace(/&lt;/gu, '<')
      .replace(/&gt;/gu, '>')
      // `&amp;` last: decoding it first would turn a literal `&amp;quot;` into `"`.
      .replace(/&amp;/gu, '&')
  )
}

/**
 * Every remote image URL in a markdown source, in first-seen order.
 *
 * Scans the source rather than the rendered HTML because the store's caller runs
 * in an effect, where the rendered markup does not exist yet   it is produced
 * inside the `{@html}` evaluation.
 *
 * A URL that appears inside a code fence is returned too. It costs one wasted
 * download in a rare shape, and the alternative   lexing the document to find
 * fences   would spend more on every message that has no image at all.
 */
export function imageUrlsFromMarkdown(source: string): string[] {
  if (!source.includes('https://')) return []
  const urls: string[] = []
  for (const match of source.matchAll(MARKDOWN_IMAGE_SOURCE)) {
    push(urls, match[1])
  }
  for (const match of source.matchAll(HTML_IMAGE_SOURCE)) {
    push(urls, match[1] ? decodeMarkdownAttribute(match[1]) : '')
  }
  for (const match of source.matchAll(HTML_SOURCE_TAG)) {
    const tag = match[0]
    if (!isDarkSchemeSource(tag)) continue
    const srcset = TAG_ATTR_SRCSET.exec(tag)?.[1]
    push(urls, firstSrcsetUrl(srcset ? decodeMarkdownAttribute(srcset) : ''))
  }
  return urls
}

function push(urls: string[], url: string | null | undefined): void {
  if (url && !urls.includes(url)) urls.push(url)
}

/**
 * Whether an `alt` is already the emoji character itself.
 *
 * GitHub serves emoji as images on some endpoints and labels them with the
 * character they stand for (`<img class="emoji" alt="👋" src="…">`). Drawing that
 * alt as text is strictly better than fetching the PNG: it is instant, works with
 * no network at all, and lands on the same glyph the image would show. Skin-tone
 * modifiers, variation selectors and zero-width-joiner sequences are spelled out
 * because each is a separate code point in a single visual glyph.
 */
export const EMOJI_GLYPH_PATTERN =
  /^\p{Extended_Pictographic}(?:\uFE0F|[\u{1F3FB}-\u{1F3FF}]|(?:\u200D\p{Extended_Pictographic}))*$/u
