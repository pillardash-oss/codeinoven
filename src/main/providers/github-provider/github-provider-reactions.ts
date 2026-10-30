import type {
  PrReactionActor,
  PrReactionGroup,
  PrReactionMap,
  SetPrReactionInput
} from '../../../lib/types'
import { isReactionContent } from '../../../lib/github-reactions'
import {
  REACTION_BATCH_SIZE,
  REACTION_GROUPS_QUERY,
  REACTION_GROUP_SELECTION
} from '../github-provider'
import type { GitHubProvider } from '../github-provider'

/**  reactions */
export class GitHubProviderReactions {
  constructor(private readonly host: GitHubProvider) {}

  /**
   * Read the reactions on many subjects at once.
   *
   * Reactions hang off the subject rather than off a comment list, and GitHub
   * answers `nodes(ids:)` for up to a hundred subjects per request, so a whole
   * conversation is one round trip instead of one per comment. The answer is
   * keyed by node id rather than positional: a subject that could not be
   * resolved comes back as a null entry, and the id it was asked under is what
   * keeps the rest of the batch placeable.
   */
  async listReactions(subjectNodeIds: string[]): Promise<PrReactionMap> {
    const unique = [...new Set(subjectNodeIds.filter((id) => id.length > 0))]
    if (unique.length === 0) return {}
    const batches: string[][] = []
    for (let index = 0; index < unique.length; index += REACTION_BATCH_SIZE) {
      batches.push(unique.slice(index, index + REACTION_BATCH_SIZE))
    }
    const answers = await Promise.all(
      batches.map((ids) => this.host.runGraphql(REACTION_GROUPS_QUERY, { ids }))
    )
    const reactions: PrReactionMap = {}
    for (const data of answers) {
      const nodes = data['nodes']
      if (!Array.isArray(nodes)) continue
      for (const node of nodes) {
        if (typeof node !== 'object' || node === null) continue
        const record = node as Record<string, unknown>
        const nodeId = this.host.readString(record, 'id')
        const groups = this.toReactionGroups(record)
        // A subject nobody has reacted to is left out rather than carried as an
        // empty list: GitHub answers all eight groups for every subject, and
        // seven of them saying nothing is noise the reader would filter anyway.
        if (!nodeId || groups.length === 0) continue
        reactions[nodeId] = groups
      }
    }
    return reactions
  }

  /**
   * Add or take back the signed-in account's reaction on one subject.
   *
   * GitHub has one mutation per direction and both answer with the subject, so
   * the write and the read are the same round trip: the caller corrects the
   * comment it is showing from the server's answer instead of refetching a
   * conversation that is already on screen.
   */

  /**
   * Add or take back the signed-in account's reaction on one subject.
   *
   * GitHub has one mutation per direction and both answer with the subject, so
   * the write and the read are the same round trip: the caller corrects the
   * comment it is showing from the server's answer instead of refetching a
   * conversation that is already on screen.
   */
  async setReaction(input: SetPrReactionInput): Promise<PrReactionGroup[]> {
    const field = input.add ? 'addReaction' : 'removeReaction'
    const data = await this.host.runGraphql(
      `mutation SetReaction($subjectId: ID!, $content: ReactionContent!) { ${field}(input: { subjectId: $subjectId, content: $content }) { subject { ... on Reactable { ${REACTION_GROUP_SELECTION} } } } }`,
      { subjectId: input.nodeId, content: input.content }
    )
    const mutation = this.host.readRecord(data, field)
    const subject = mutation ? this.host.readRecord(mutation, 'subject') : null
    if (!subject) {
      throw new Error('The provider did not answer with the subject that was reacted to')
    }
    return this.toReactionGroups(subject)
  }

  /**
   * The reaction groups on one subject that actually carry a reaction.
   *
   * `count` is GitHub's own total, which is authoritative: the actor list is
   * capped by the query, so a popular reaction names its first few reactors and
   * still reports every one of them.
   */

  /**
   * The reaction groups on one subject that actually carry a reaction.
   *
   * `count` is GitHub's own total, which is authoritative: the actor list is
   * capped by the query, so a popular reaction names its first few reactors and
   * still reports every one of them.
   */
  toReactionGroups(record: Record<string, unknown>): PrReactionGroup[] {
    const groups = record['reactionGroups']
    if (!Array.isArray(groups)) return []
    return groups.flatMap((entry): PrReactionGroup[] => {
      if (typeof entry !== 'object' || entry === null) return []
      const group = entry as Record<string, unknown>
      const content = this.host.readString(group, 'content')
      if (!content || !isReactionContent(content)) return []
      const reactors = this.host.readRecord(group, 'reactors')
      const count = reactors ? this.host.readNumber(reactors, 'totalCount') : 0
      if (count <= 0) return []
      return [
        {
          content,
          viewerHasReacted: group['viewerHasReacted'] === true,
          count,
          actors: this.toReactionActors(reactors)
        }
      ]
    })
  }

  /** The reactors a reaction group carries, skipping any without a login. */

  /** The reactors a reaction group carries, skipping any without a login. */
  toReactionActors(reactors: Record<string, unknown> | null): PrReactionActor[] {
    const nodes = reactors ? reactors['nodes'] : null
    if (!Array.isArray(nodes)) return []
    return nodes.flatMap((node): PrReactionActor[] => {
      if (typeof node !== 'object' || node === null) return []
      const record = node as Record<string, unknown>
      const login = this.host.readString(record, 'login')
      if (!login) return []
      return [{ login, avatarUrl: this.host.readString(record, 'avatarUrl') }]
    })
  }

  /** The numeric comment ids a GraphQL thread node holds, in thread order. */
}
