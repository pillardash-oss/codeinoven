import type { PrReactionContent } from './types'

/**
 * GitHub's reaction set, in the order its own picker draws them.
 *
 * The eight are fixed: GitHub accepts no other value, and its picker offers no
 * search. Each one carries the gemoji shortcode whose glyph draws it, which is
 * what keeps the app from owning a second emoji table: the renderer resolves the
 * shortcode through the same gemoji data that expands `:wave:` inside a comment.
 *
 * Kept in the shared layer rather than beside the picker because both sides need
 * it: main validates that a write names one of these values, and the renderer
 * draws them.
 */
export interface GithubReaction {
  content: PrReactionContent
  /** gemoji shortcode whose glyph draws this reaction. */
  shortcode: string
  /** What the reaction is called, for an accessible name and a tooltip. */
  label: string
}

export const GITHUB_REACTIONS: readonly GithubReaction[] = [
  { content: 'THUMBS_UP', shortcode: '+1', label: 'Thumbs up' },
  { content: 'THUMBS_DOWN', shortcode: '-1', label: 'Thumbs down' },
  { content: 'LAUGH', shortcode: 'smile', label: 'Laugh' },
  { content: 'HOORAY', shortcode: 'tada', label: 'Hooray' },
  { content: 'CONFUSED', shortcode: 'confused', label: 'Confused' },
  { content: 'HEART', shortcode: 'heart', label: 'Heart' },
  { content: 'ROCKET', shortcode: 'rocket', label: 'Rocket' },
  { content: 'EYES', shortcode: 'eyes', label: 'Eyes' }
]

const REACTION_CONTENTS = new Set<string>(GITHUB_REACTIONS.map((reaction) => reaction.content))

/**
 * Whether a value is one of GitHub's eight reaction values.
 *
 * The IPC boundary takes the value from the renderer, so it is checked here
 * rather than trusted: an unknown value would reach `addReaction` and come back
 * as a provider error the reader cannot act on.
 */
export function isReactionContent(value: string): value is PrReactionContent {
  return REACTION_CONTENTS.has(value)
}
