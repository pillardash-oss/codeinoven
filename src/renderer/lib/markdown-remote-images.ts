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

/** An `<img>` tag in sanitized HTML. */
export const IMAGE_TAG = /<img\b[^>]*>/giu

/** `src="…"` anywhere inside a tag. */
export const IMAGE_ATTR_SRC = /\bsrc="([^"]*)"/iu

/** The whole `src="…"` attribute, for a wholesale replacement. */
export const IMAGE_ATTR_SRC_ANY = /\bsrc="[^"]*"/iu

/** `alt="…"` anywhere inside a tag. */
export const IMAGE_ATTR_ALT = /\balt="([^"]*)"/iu

/** `class="…"` anywhere inside a tag. */
export const IMAGE_ATTR_CLASS = /\bclass="([^"]*)"/iu

/**
 * Whether a markdown source can produce a remote image at all.
 *
 * A cheap pre-test so the common case (no image anywhere in the block) never
 * pays for the extraction, and so a block with no image keeps a stable
 * resolution-independent cache key.
 */
export function hasRemoteImage(source: string): boolean {
  return /(?:!\[[^\]]*\]\(\s*https:\/\/)|(?:<img\b[^>]*\bsrc="https:\/\/)/iu.test(source)
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
  return urls
}

function push(urls: string[], url: string | undefined): void {
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
