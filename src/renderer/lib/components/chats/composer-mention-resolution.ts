import { isInsideUnclosedInlineCode, isQuotedMentionPosition } from '$shared/mention-context'
import type { ProjectFileEntry } from '$shared/types'
import { COMPOSER_BUILT_IN_TAGS, type ComposerBuiltInTag } from './composer-mentions'

/**
 * Auto-target a typed `@` tag on send.
 *
 * A user who types enough of a tag to name it exactly, then sends without ever
 * opening the dropdown or pressing Enter on a row, still means to target that
 * file or built-in tag. This module finds those typed tokens and resolves the
 * ones that name exactly one known thing, so the send carries the same tagged
 * reference a dropdown pick would have produced.
 *
 * Everything here is pure. The controller does the file lookup; this module
 * only scans a draft and matches already-fetched candidates, so a resolution
 * can be reasoned about and reused on every send surface.
 */

/** A typed `@token` a send might resolve, with the index of its `@`. */
export interface TypedComposerMention {
  /** The full typed token, `@` included. */
  token: string
  /** What the user typed after `@`, exactly. */
  query: string
  /** Index of the `@` in the scanned text. */
  start: number
}

/** A trailing run of sentence punctuation does not belong to a tag name, but a
 *  path's own dots do, so only the end of the token is trimmed. */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"”’]+$/u

/** Split a typed query into the name to match on and the punctuation a
 *  replacement must put back, so `@package.json.` keeps its final period. */
export function splitTypedMentionQuery(query: string): { name: string; suffix: string } {
  const name = query.replace(TRAILING_PUNCTUATION, '')
  return { name, suffix: query.slice(name.length) }
}

/**
 * Scan a draft for typed `@` tags that can be auto-targeted.
 *
 * The same exemptions the badge renderer and the session tags use apply: a tag
 * inside a fenced code block, an unclosed inline code span, a blockquote, or an
 * open double-quoted passage is a mention of a tag, never an invocation, so it
 * stays literal. Each line is scanned separately so a code fence toggles across
 * lines while a mention stays on one.
 */
export function typedComposerMentions(text: string): TypedComposerMention[] {
  const mentions: TypedComposerMention[] = []
  let offset = 0
  let inFence = false

  for (const line of text.split('\n')) {
    // Mirror the renderer, which only opens a fence at column zero.
    if (/^```/u.test(line)) {
      inFence = !inFence
      offset += line.length + 1
      continue
    }
    if (!inFence) {
      const pattern = /(^|\s)@([^\s@]+)/gu
      let match: RegExpExecArray | null
      while ((match = pattern.exec(line)) !== null) {
        const start = offset + match.index + (match[1]?.length ?? 0)
        if (
          isQuotedMentionPosition(text, start) ||
          isInsideUnclosedInlineCode(text.slice(0, start))
        ) {
          continue
        }
        mentions.push({ token: `@${match[2]}`, query: match[2] ?? '', start })
      }
    }
    offset += line.length + 1
  }

  return mentions
}

/**
 * The built-in tag a typed query names, if it names exactly one.
 *
 * The token without its `@` is the canonical name, so an exact token always
 * wins. A unique prefix is accepted too (`cio-des` → `cio-design`), but a
 * prefix shared by two tags resolves to neither rather than guessing.
 */
export function resolveBuiltInTag(query: string): ComposerBuiltInTag | null {
  const { name } = splitTypedMentionQuery(query)
  const needle = name.toLocaleLowerCase()
  if (!needle) return null

  const exact = COMPOSER_BUILT_IN_TAGS.find(
    (tag) => tag.token.slice(1).toLocaleLowerCase() === needle
  )
  if (exact) return exact
  if (needle.length < 3) return null

  const prefixMatches = COMPOSER_BUILT_IN_TAGS.filter((tag) =>
    tag.token.slice(1).toLocaleLowerCase().startsWith(needle)
  )
  return prefixMatches.length === 1 ? (prefixMatches[0] ?? null) : null
}

/**
 * The single project entry a typed query names, if it names exactly one.
 *
 * Matching is deliberately strict: the search behind it is fuzzy, so only an
 * exact path, an exact file/directory name, or a case-insensitive exact match
 * counts. Anything ambiguous returns null and the typed text stays literal.
 */
export function matchProjectEntry(
  query: string,
  entries: readonly ProjectFileEntry[]
): ProjectFileEntry | null {
  const { name } = splitTypedMentionQuery(query)
  if (!name) return null

  const byPath = entries.find((entry) => entry.path === name)
  if (byPath) return byPath
  const byName = entries.filter((entry) => entry.name === name)
  if (byName.length === 1) return byName[0] ?? null

  const needle = name.toLocaleLowerCase()
  const byPathFolded = entries.filter((entry) => entry.path.toLocaleLowerCase() === needle)
  if (byPathFolded.length === 1) return byPathFolded[0] ?? null
  const byNameFolded = entries.filter((entry) => entry.name.toLocaleLowerCase() === needle)
  return byNameFolded.length === 1 ? (byNameFolded[0] ?? null) : null
}
