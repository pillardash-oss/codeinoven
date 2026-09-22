import type { PrReactionContent, PrReactionGroup, PrReactionMap } from '$shared/types'
import { GITHUB_REACTIONS, type GithubReaction } from '$shared/github-reactions'
import { githubDisplayLogin } from '$lib/format/github-login'
import { emojiForShortcode } from '../markdown/github-emoji'
import type { ConversationEntry } from './git-pull-request-detail-format'

/** One reaction the picker offers, with the glyph its shortcode resolves to. */
export interface ReactionOption extends GithubReaction {
  /** The glyph gemoji draws for this shortcode, or the shortcode when it has none. */
  emoji: string
}

/**
 * The options, resolved once on the first surface that needs a glyph.
 *
 * `emojiForShortcode` builds gemoji's ~350KB lookup on its first call, so this is
 * lazy on purpose: a conversation whose comments nobody reacts to, and whose
 * pickers nobody opens, never pays for the emoji table.
 */
let options: Map<PrReactionContent, ReactionOption> | null = null

function optionMap(): Map<PrReactionContent, ReactionOption> {
  if (options === null) {
    options = new Map(
      GITHUB_REACTIONS.map((reaction) => [
        reaction.content,
        {
          ...reaction,
          // A shortcode gemoji does not know stays visible as itself rather than
          // drawing an empty button.
          emoji: emojiForShortcode(reaction.shortcode) ?? `:${reaction.shortcode}:`
        }
      ])
    )
  }
  return options
}

/** Every reaction, in GitHub's own picker order. */
export function reactionOptions(): ReactionOption[] {
  return [...optionMap().values()]
}

/** One reaction's glyph and name, or null for a value GitHub did not send. */
export function reactionOption(content: PrReactionContent): ReactionOption | null {
  return optionMap().get(content) ?? null
}

/** The reactions on one conversation entry, which the bundle keys by node id. */
export function entryReactions(
  entry: ConversationEntry,
  reactions: PrReactionMap
): PrReactionGroup[] {
  if (!entry.nodeId) return []
  return reactions[entry.nodeId] ?? []
}

/**
 * What a reaction chip says when the pointer rests on it.
 *
 * The count is GitHub's total and the actor list is capped by the read, so the
 * names are the first few and the remainder is counted rather than dropped: "You,
 * @pullfrog and 4 others" is honest about a list it could not finish.
 */
export function reactionTooltip(group: PrReactionGroup, viewerLogin: string | null): string {
  const option = reactionOption(group.content)
  const subject = option ? `${option.emoji} ${option.label}` : group.content
  const names = reactionActorNames(group, viewerLogin)
  const shown = names.slice(0, 3)
  const others = group.count - shown.length
  if (shown.length === 0) {
    return `${String(group.count)} ${group.count === 1 ? 'reaction' : 'reactions'}: ${subject}`
  }
  const tail = others > 0 ? ` and ${String(others)} ${others === 1 ? 'other' : 'others'}` : ''
  return `${shown.join(', ')}${tail} reacted with ${subject}`
}

/**
 * The reactors a chip can name, the signed-in account first.
 *
 * The viewer is read from the server's `viewerHasReacted` rather than matched
 * against the actor list, and is then left out of it: the actor list is capped, so
 * matching would name them twice whenever they happen to be in it and not at all
 * when they are not.
 */
function reactionActorNames(group: PrReactionGroup, viewerLogin: string | null): string[] {
  const names: string[] = []
  if (group.viewerHasReacted) names.push('You')
  const viewer = viewerLogin?.toLowerCase() ?? null
  for (const actor of group.actors) {
    if (viewer !== null && actor.login.toLowerCase() === viewer) continue
    names.push(`@${githubDisplayLogin(actor.login)}`)
  }
  return names
}
