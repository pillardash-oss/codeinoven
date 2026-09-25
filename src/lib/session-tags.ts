import { isQuotedMentionPosition } from './mention-context'

/**
 * The two session tags, in one place because three layers judge them.
 *
 * A design session and a video session are both opened by the user typing a tag,
 * and the same question about it is asked in the main process (which turn mode a
 * turn carries, which authored-work kind a thread is in) and in the renderer
 * (whether the send the user is about to make is the one that opens a session).
 * A second copy of the pattern is how the two answers drift apart, so the tokens,
 * the predicates and the modes live here and both layers read them.
 *
 * The prompts themselves stay in the main process: they are the contract a turn
 * carries, not a fact about a tag.
 */

/** Stable built-in tag that opens a design session on an explicit turn. */
export const CIO_DESIGN_TAG = '@cio-design'

/** Stable built-in tag that opens a video session on an explicit turn. */
export const CIO_VIDEO_TAG = '@cio-video'

const CIO_DESIGN_TAG_PATTERN = /(^|\s)@cio-design(?=\s|$|[.,:;!?])/giu
const CIO_VIDEO_TAG_PATTERN = /(^|\s)@cio-video(?=\s|$|[.,:;!?])/giu

/**
 * Whether this text opens a design session.
 *
 * A tag inside a quote or a blockquote is a mention of the tag rather than an
 * invocation of it, which is what keeps documentation about `@cio-design` from
 * starting a session. Shared with the other tags through
 * `isQuotedMentionPosition` so every tag agrees on what counts as quoting.
 */
export function isCioDesignRequest(text: string): boolean {
  for (const match of text.matchAll(CIO_DESIGN_TAG_PATTERN)) {
    const mentionStart = (match.index ?? 0) + (match[1]?.length ?? 0)
    if (!isQuotedMentionPosition(text, mentionStart)) return true
  }
  return false
}

/**
 * Whether this text opens a video session. The same rule as the design tag: a
 * quoted tag is a mention, never an invocation.
 */
export function isCioVideoRequest(text: string): boolean {
  for (const match of text.matchAll(CIO_VIDEO_TAG_PATTERN)) {
    const mentionStart = (match.index ?? 0) + (match[1]?.length ?? 0)
    if (!isQuotedMentionPosition(text, mentionStart)) return true
  }
  return false
}

/** Which authored-work session, if any, a piece of text opens. */
export type SessionTagKind = 'none' | 'design' | 'video'

/**
 * The session a message opens, for a surface that only needs to know which one.
 *
 * A message naming both tags is read as a design session: the two write to
 * different roots, so one of them has to win, and the first tag the user reaches
 * for is the more likely intent.
 */
export function sessionTagKind(text: string): SessionTagKind {
  if (isCioDesignRequest(text)) return 'design'
  if (isCioVideoRequest(text)) return 'video'
  return 'none'
}

/** Which design contract a turn carries: none, the first one, or a continuation. */
export type DesignSessionMode = 'off' | 'start' | 'continue'

/** Which video contract a turn carries: none, the first one, or a continuation. */
export type VideoSessionMode = 'off' | 'start' | 'continue'
