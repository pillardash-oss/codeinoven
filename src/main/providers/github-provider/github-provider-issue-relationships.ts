import type { IssueRelationshipItem, IssueRelationships } from '../../../lib/types'
import type { IssueLinkInput } from '../../git/git-provider.interface'
import type { IssueTarget } from '../../git/git-provider.interface'
import {
  ADD_BLOCKED_BY_MUTATION,
  ADD_SUB_ISSUE_MUTATION,
  ProviderHttpError,
  REMOVE_BLOCKED_BY_MUTATION,
  REMOVE_SUB_ISSUE_MUTATION
} from '../github-provider'
import type { GitHubProvider } from '../github-provider'

/**  issue-relationships */
export class GitHubProviderIssueRelationships {
  constructor(private readonly host: GitHubProvider) {}

  /**
   * Make one issue a sub-issue of another.
   *
   * GraphQL rather than REST because that is where the mutation exists, and it takes
   * the two issues by node id. The payload returns the updated issue; the caller
   * re-reads the relationship list instead of trusting a partial answer, since the
   * reader draws the parent and the children together.
   */
  async addIssueSubIssue(input: IssueLinkInput): Promise<void> {
    await this.runRelationshipMutation(ADD_SUB_ISSUE_MUTATION, {
      issueId: input.issueNodeId,
      subIssueId: input.relatedNodeId
    })
  }

  /** Detach a sub-issue from its parent. */

  /** Detach a sub-issue from its parent. */
  async removeIssueSubIssue(input: IssueLinkInput): Promise<void> {
    await this.runRelationshipMutation(REMOVE_SUB_ISSUE_MUTATION, {
      issueId: input.issueNodeId,
      subIssueId: input.relatedNodeId
    })
  }

  /** Record that `relatedNodeId` blocks `issueNodeId`. */

  /** Record that `relatedNodeId` blocks `issueNodeId`. */
  async addIssueBlockedBy(input: IssueLinkInput): Promise<void> {
    await this.runRelationshipMutation(ADD_BLOCKED_BY_MUTATION, {
      issueId: input.issueNodeId,
      blockingIssueId: input.relatedNodeId
    })
  }

  /** Remove a blocking relationship between two issues. */

  /** Remove a blocking relationship between two issues. */
  async removeIssueBlockedBy(input: IssueLinkInput): Promise<void> {
    await this.runRelationshipMutation(REMOVE_BLOCKED_BY_MUTATION, {
      issueId: input.issueNodeId,
      blockingIssueId: input.relatedNodeId
    })
  }

  /**
   * Run one relationship mutation, discarding the payload.
   *
   * The payload carries the issue and its new counterpart, which the caller does not
   * use: the relationship list is re-read afterwards, so this only has to fail loudly
   * when GitHub refuses.
   */

  /**
   * Run one relationship mutation, discarding the payload.
   *
   * The payload carries the issue and its new counterpart, which the caller does not
   * use: the relationship list is re-read afterwards, so this only has to fail loudly
   * when GitHub refuses.
   */
  async runRelationshipMutation(
    document: string,
    variables: Record<string, string>
  ): Promise<void> {
    await this.host.runGraphql(document, variables)
  }

  /**
   * Where GitHub files an issue comment.
   *
   * Repository-scoped, with the issue number appearing nowhere in the path: a
   * comment is addressed by its own id, the same as the pull request conversation
   * comments that share this collection.
   */

  /**
   * An issue's relationships, as four reads that answer together.
   *
   * GitHub splits them across endpoints that share no shape: the parent is one
   * object that 404s when there is none, and the three lists are collections of
   * full issue objects. They are read together because the reader draws one block,
   * and because a partial answer would be shown as "none yet" for a relationship
   * that merely could not be read.
   */
  async listIssueRelationships(input: IssueTarget): Promise<IssueRelationships> {
    const [parent, subIssues, blockedBy, blocking] = await Promise.all([
      this.readIssueParent(input),
      this.listRelatedIssues(`${this.host.issuePath(input)}/sub_issues`, input),
      this.listRelatedIssues(`${this.host.issuePath(input)}/dependencies/blocked_by`, input),
      this.listRelatedIssues(`${this.host.issuePath(input)}/dependencies/blocking`, input)
    ])
    return { parent, subIssues, blockedBy, blocking }
  }

  /**
   * The issue this one is a sub-issue of, or null when it has no parent.
   *
   * A missing parent is a 404 rather than an empty answer, so it is translated here
   * instead of being left to read as a failure. Every other error still reaches the
   * caller, which is what keeps a timeout from looking like "no parent".
   */

  /**
   * The issue this one is a sub-issue of, or null when it has no parent.
   *
   * A missing parent is a 404 rather than an empty answer, so it is translated here
   * instead of being left to read as a failure. Every other error still reaches the
   * caller, which is what keeps a timeout from looking like "no parent".
   */
  async readIssueParent(input: IssueTarget): Promise<IssueRelationshipItem | null> {
    try {
      const payload = await this.host.request(`${this.host.issuePath(input)}/parent`, {
        method: 'GET'
      })
      return this.toRelationshipItem(payload, input)
    } catch (failure) {
      if (failure instanceof ProviderHttpError && failure.status === 404) return null
      throw failure
    }
  }

  /**
   * One collection of related issues, each mapped, or dropped when unusable.
   *
   * A hundred items is GitHub's ceiling for these collections and one request, the
   * same bound the comment reads use. A parent with more sub-issues than that shows
   * the first hundred rather than the first thirty, which is what GitHub's own
   * default page would silently do.
   */

  /**
   * One collection of related issues, each mapped, or dropped when unusable.
   *
   * A hundred items is GitHub's ceiling for these collections and one request, the
   * same bound the comment reads use. A parent with more sub-issues than that shows
   * the first hundred rather than the first thirty, which is what GitHub's own
   * default page would silently do.
   */
  async listRelatedIssues(path: string, input: IssueTarget): Promise<IssueRelationshipItem[]> {
    const response = await this.host.request(`${path}?per_page=100`, { method: 'GET' })
    const items = Array.isArray(response) ? response : []
    return items.flatMap((item): IssueRelationshipItem[] => {
      const related = this.toRelationshipItem(item, input)
      return related ? [related] : []
    })
  }

  /**
   * One related issue, or null when the payload has no usable number.
   *
   * The item's repository is read from the payload and only falls back to this
   * issue's own. That is not cosmetic: a dependency may live in another repository,
   * and labelling it with the wrong one is how a reader ends up clicking a link they
   * cannot place.
   */

  /**
   * One related issue, or null when the payload has no usable number.
   *
   * The item's repository is read from the payload and only falls back to this
   * issue's own. That is not cosmetic: a dependency may live in another repository,
   * and labelling it with the wrong one is how a reader ends up clicking a link they
   * cannot place.
   */
  toRelationshipItem(payload: unknown, input: IssueTarget): IssueRelationshipItem | null {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
    const record = payload as Record<string, unknown>
    const number = this.host.readNumber(record, 'number')
    if (number <= 0) return null
    const repository = this.host.readRecord(record, 'repository')
    return {
      number,
      title: this.host.readString(record, 'title') ?? `Issue #${number}`,
      url:
        this.host.readString(record, 'html_url') ??
        `https://github.com/${input.owner}/${input.repo}/issues/${number}`,
      state: this.host.readString(record, 'state') === 'closed' ? 'closed' : 'open',
      stateReason: this.host.toStateReason(this.host.readString(record, 'state_reason')),
      repository:
        (repository ? this.host.readString(repository, 'full_name') : null) ??
        `${input.owner}/${input.repo}`,
      nodeId: this.host.readString(record, 'node_id')
    }
  }
}
