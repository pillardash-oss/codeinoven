/**
 * GitHub emoji shortcodes (`:wave:`) → unicode.
 *
 * Content authored on GitHub uses gemoji shortcodes, and GitHub expands the
 * ones that have a unicode form. Names that only exist as a GitHub-hosted
 * image emoji (`:shipit:`) or as an org custom emoji have no unicode form and
 * must stay literal text, exactly as they do on github.com.
 *
 * This module is intentionally standalone: it owns the marked inline extension
 * and it does not reach into the markdown pipeline. The shortcode table itself
 * lives in `github-emoji-data.svelte.ts`, in its own chunk, because gemoji is
 * data the first paint must not pay for.
 */
import type { Token, Tokens, TokensList, TokenizerAndRendererExtension } from 'marked'
import {
  emojiForShortcode,
  ensureGithubEmojiData,
  githubEmojiLoaded
} from './github-emoji-data.svelte'

/**
 * Resolve a shortcode to its unicode character.
 *
 * Exact match only: GitHub's shortcodes are lowercase, and `:WAVE:` is literal
 * text on github.com, so arbitrary casing is never normalised into a match.
 * Returns `null` for image/custom shortcodes, and for every shortcode until the
 * table chunk has landed (call `ensureGithubEmojiData` to fetch it, or read
 * `githubEmojiRevision` to be re-run when it arrives).
 */
export { emojiForShortcode }

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

/**
 * Whether a run of text can contain a shortcode at all.
 *
 * Callers use this to decide whether their memoized output depends on the
 * shortcode table: text without a candidate renders identically before and
 * after the table lands, so it must not be keyed on the table's revision (that
 * would re-lex a whole conversation for nothing) and must not trigger a fetch.
 */
export function hasGithubEmojiCandidate(text: string): boolean {
  return SHORTCODE_CANDIDATE.test(text)
}

// GitHub refuses to expand a shortcode whose opening colon is glued to an
// alphanumeric character or another colon: `foo:wave:baz`, `10:30:15` and
// `::wave:` all stay literal. marked reports the preceding character only
// through the previously emitted inline text token.
const SHORTCODE_BLOCKED_PRECEDING = /[0-9A-Za-z:]/

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
    // The table arrives after the first paint. A shortcode lexed while it is
    // still missing stays literal for this pass and is re-lexed when the
    // table's revision bumps (see `lexMarkdownCached`), so the fetch is kicked
    // off here rather than from render code.
    if (!githubEmojiLoaded()) void ensureGithubEmojiData()
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
