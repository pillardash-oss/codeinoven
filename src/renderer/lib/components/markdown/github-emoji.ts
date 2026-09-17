/**
 * GitHub emoji shortcodes (`:wave:`) → unicode.
 *
 * Content authored on GitHub uses gemoji shortcodes, and GitHub expands the
 * ones that have a unicode form. Names that only exist as a GitHub-hosted
 * image emoji (`:shipit:`) or as an org custom emoji have no unicode form and
 * must stay literal text, exactly as they do on github.com.
 *
 * This module is intentionally standalone: it owns the gemoji data and a
 * marked inline extension, and it does not reach into the markdown pipeline.
 */
import { nameToEmoji } from 'gemoji'
import type { Token, Tokens, TokensList, TokenizerAndRendererExtension } from 'marked'

/** Token type emitted for a shortcode that resolved to unicode. */
export const GITHUB_EMOJI_TOKEN_TYPE = 'githubEmoji'

export interface GithubEmojiToken extends Tokens.Generic {
  type: typeof GITHUB_EMOJI_TOKEN_TYPE
  name: string
  emoji: string
}

// GitHub shortcodes are `[a-z0-9_+-]+` (`:+1:` and `:-1:` are the reason for
// the two operators). Anchored because marked hands the tokenizer the source
// from the current scan position, not the whole document.
const SHORTCODE_PATTERN = /^:([a-z0-9_+-]+):/
// The same shape used by `start`, so text before the next *plausible*
// shortcode is consumed in one chunk without surfacing dead colons.
const SHORTCODE_CANDIDATE = /:[a-z0-9_+-]+:/

// GitHub refuses to expand a shortcode whose opening colon is glued to an
// alphanumeric character or another colon: `foo:wave:baz`, `10:30:15` and
// `::wave:` all stay literal. marked reports the preceding character only
// through the previously emitted inline text token.
const SHORTCODE_BLOCKED_PRECEDING = /[0-9A-Za-z:]/

// gemoji ships ~350KB of data. Building the lookup Map eagerly would make
// every renderer boot pay for a feature most messages never use, so the Map is
// built on the first lookup   and only the first lookup   then reused.
let shortcodeMap: Map<string, string> | null = null

function shortcodeLookup(): Map<string, string> {
  if (shortcodeMap === null) shortcodeMap = new Map(Object.entries(nameToEmoji))
  return shortcodeMap
}

/**
 * Resolve a shortcode to its unicode character.
 *
 * Exact match only: GitHub's shortcodes are lowercase, and `:WAVE:` is literal
 * text on github.com, so arbitrary casing is never normalised into a match.
 * Returns `null` for image/custom shortcodes so callers keep them literal.
 */
export function emojiForShortcode(name: string): string | null {
  return shortcodeLookup().get(name) ?? null
}

/** Last character of the previously emitted inline text token, if any. */
function lastTextChar(tokens: Token[] | TokensList): string | null {
  const previous = tokens.length > 0 ? tokens[tokens.length - 1] : undefined
  if (!previous || previous.type !== 'text') return null
  const text = (previous as Tokens.Text).text
  return text.length > 0 ? text.slice(-1) : null
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Inline extension that expands GitHub emoji shortcodes.
 *
 * Register it with `marked` (`instance.use({ extensions: [githubEmojiExtension] })`)
 * or hand its tokenizer to the app's own parser. Unresolvable names never
 * tokenize, so they survive as ordinary text through the rest of the pipeline.
 */
export const githubEmojiExtension: TokenizerAndRendererExtension = {
  name: 'githubEmoji',
  level: 'inline',
  start(src: string): number | undefined {
    const index = src.search(SHORTCODE_CANDIDATE)
    return index === -1 ? undefined : index
  },
  tokenizer(src: string, tokens: Token[] | TokensList): Tokens.Generic | undefined {
    const match = SHORTCODE_PATTERN.exec(src)
    if (!match) return undefined
    const name = match[1]
    const emoji = emojiForShortcode(name)
    if (emoji === null) return undefined
    const preceding = lastTextChar(tokens)
    if (preceding !== null && SHORTCODE_BLOCKED_PRECEDING.test(preceding)) return undefined
    const token: GithubEmojiToken = {
      type: GITHUB_EMOJI_TOKEN_TYPE,
      raw: match[0],
      name,
      emoji
    }
    return token
  },
  renderer(token: Tokens.Generic): string {
    const resolved = token as GithubEmojiToken
    // Inline-only wrapper: a span keeps the emoji inside the surrounding
    // paragraph/line, and the plain character needs no escaping.
    return `<span class="emoji" data-emoji="${escapeHtml(resolved.name)}">${resolved.emoji}</span>`
  }
}
