/**
 * The gemoji shortcode table, fetched after the text it decorates.
 *
 * `gemoji` is ~350KB of data, and every renderer boot used to pay for it
 * because `github-emoji.ts` imported it eagerly: the shortcode name-to-unicode
 * map is a third of what the markdown chunk weighs, for a feature that only
 * provider-authored text uses. It therefore lives in its own chunk, fetched
 * when something either needs it (a shortcode appears in the text) or after the
 * conversation has painted (see `warmMarkdown`), and never on the first paint.
 *
 * Shortcodes are rendered from the table, so a fetch that lands after a block
 * was lexed must be able to repaint that block. `revision` is the reactive
 * version that makes it possible: `lexMarkdownCached` and `blockHtml` read it
 * in the caller's reactive context and fold it into their cache keys, exactly
 * as `citationPathsState.revision` does for late-resolved file citations.
 * Because a message without a `:shortcode:` candidate can never change when the
 * table arrives, the revision is only read (and only keyed) for text that
 * actually contains one, so a load never re-lexes a conversation that does not
 * need it.
 */

let table: Readonly<Record<string, string>> | null = null
let revisionState = $state(0)
let loading: Promise<void> | null = null

/** Reactive revision of the shortcode table. Read it in a reactive context. */
export function githubEmojiRevision(): number {
  return revisionState
}

/** Whether the table is in memory, so a shortcode resolves right now. */
export function githubEmojiLoaded(): boolean {
  return table !== null
}

/**
 * Resolve a shortcode to its unicode character, or null when the name has no
 * unicode form (a GitHub image emoji or an org custom emoji stays literal) or
 * when the table has not arrived yet.
 */
export function emojiForShortcode(name: string): string | null {
  return table?.[name] ?? null
}

/**
 * Fetch the shortcode table once.
 *
 * Idempotent, and safe to call from a tokenizer that needs the answer now: a
 * failed fetch is forgotten rather than memoized, so the next shortcode tries
 * again instead of leaving the feature dead for the rest of the session.
 */
export function ensureGithubEmojiData(): Promise<void> {
  if (table !== null) return Promise.resolve()
  loading ??= import('gemoji').then(
    (module) => {
      table = module.nameToEmoji
      revisionState += 1
    },
    () => {
      loading = null
    }
  )
  return loading
}
