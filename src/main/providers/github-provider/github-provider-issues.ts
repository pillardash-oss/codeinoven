import type {
  IssueDetail,
  IssuePage,
  IssueReference,
  IssueSummary,
  IssueTimelineEvent,
  PullRequestComment
} from '../../../lib/types'
import type { SearchIssueCandidatesInput } from '../../git/git-provider.interface'
import type {
  CreateIssueCommentInput,
  CreateIssueInput,
  IssueCommentTarget,
  IssueTarget,
  ListIssuePageInput,
  SetIssueStateInput,
  UpdateIssueCommentInput,
  UpdateIssueInput
} from '../../git/git-provider.interface'
import {
  ISSUE_CANDIDATE_LIMIT,
  ISSUE_LIST_QUERY,
  LIST_SORTS,
  ProviderGraphqlError,
  ProviderHttpError
} from '../github-provider'
import type { GitHubProvider } from '../github-provider'

/**  issues */
export class GitHubProviderIssues {
  constructor(private readonly host: GitHubProvider) {}

  async listIssuePage(input: ListIssuePageInput): Promise<IssuePage> {
    const state = input.state ?? 'open'
    const qualifiers = ['is:issue', `repo:${input.owner}/${input.repo}`]
    if (state === 'open') qualifiers.push('is:open')
    else if (state === 'closed') qualifiers.push('is:closed')
    if (input.filter === 'created') qualifiers.push('author:@me')
    else if (input.filter === 'assigned') qualifiers.push('assignee:@me')
    else if (input.filter === 'mentioned') qualifiers.push('mentions:@me')
    else if (input.filter === 'involves') qualifiers.push('involves:@me')
    qualifiers.push(LIST_SORTS[input.sort])

    // Ask for exactly the page size. An over-fetch of one extra would move
    // `endCursor` past the first row of the next page, because the cursor is the
    // last node the search returned.
    const perPage = Math.min(Math.max(input.perPage, 1), 50)
    try {
      const data = await this.host.runGraphql(ISSUE_LIST_QUERY, {
        q: qualifiers.join(' '),
        first: perPage,
        after: input.cursor
      })
      const search = this.host.readRecord(data, 'search')
      const nodes: unknown[] = search && Array.isArray(search['nodes']) ? search['nodes'] : []
      const items = nodes.flatMap((node) => {
        const summary = this.host.toGraphqlIssueSummary(node, input.owner, input.repo)
        return summary ? [summary] : []
      })
      const pageInfo = search ? this.host.readRecord(search, 'pageInfo') : null
      const hasMore = pageInfo?.['hasNextPage'] === true
      return {
        items,
        page: input.page,
        hasMore,
        nextCursor: hasMore && pageInfo ? this.host.readString(pageInfo, 'endCursor') : null
      }
    } catch (failure) {
      // The IPC handler tells a repository the App cannot see apart from a
      // transient outage by HTTP status, so a GraphQL access failure has to
      // arrive as the same `ProviderHttpError` the REST calls raise.
      if (failure instanceof ProviderGraphqlError) {
        if (failure.type === 'FORBIDDEN') throw new ProviderHttpError(403, failure.message)
        if (failure.type === 'NOT_FOUND') throw new ProviderHttpError(404, failure.message)
      }
      throw failure
    }
  }

  async getIssue(input: IssueTarget): Promise<IssueDetail> {
    const response = await this.host.request(this.host.issuePath(input), { method: 'GET' })
    const record = Array.isArray(response) ? {} : response
    // A pull request is an issue carrying a `pull_request` link. The GitHub
    // issues endpoints answer with both kinds, so the issue reader refuses the
    // other one rather than opening onto something it cannot represent.
    if (this.host.readRecord(record, 'pull_request')) {
      throw new Error(`#${input.issueNumber} is a pull request, not an issue`)
    }
    const summary = this.host.toIssueSummary(record, input.owner, input.repo)
    if (!summary) throw new Error(`Issue #${input.issueNumber} could not be read`)
    return {
      ...summary,
      body: this.host.readString(record, 'body') ?? '',
      nodeId: this.host.readString(record, 'node_id'),
      authorAssociation: this.host.toAuthorAssociation(record),
      closedAt: this.host.readString(record, 'closed_at')
    }
  }

  async createIssue(input: CreateIssueInput): Promise<IssueReference> {
    const payload: Record<string, unknown> = { title: input.title }
    if (input.body !== undefined) payload['body'] = input.body
    if (input.labels && input.labels.length > 0) payload['labels'] = input.labels
    if (input.assignees && input.assignees.length > 0) payload['assignees'] = input.assignees
    const response = await this.host.request(`${this.host.repoPath(input)}/issues`, {
      method: 'POST',
      body: JSON.stringify(payload)
    })
    const reference = this.host.toIssueReference(response, input)
    if (!reference) throw new Error('The issue was created but could not be read back')
    return reference
  }

  async updateIssue(input: UpdateIssueInput): Promise<IssueReference> {
    const payload: Record<string, unknown> = {}
    if (input.title !== undefined) payload['title'] = input.title
    if (input.body !== undefined) payload['body'] = input.body
    const response = await this.host.request(this.host.issuePath(input), {
      method: 'PATCH',
      body: JSON.stringify(payload)
    })
    const reference = this.host.toIssueReference(response, input)
    if (!reference) throw new Error('The issue was saved but could not be read back')
    return reference
  }

  async setIssueState(input: SetIssueStateInput): Promise<IssueReference> {
    const payload: Record<string, unknown> = { state: input.state }
    // GitHub records why an issue was closed, and clears the reason itself on
    // reopen, so a reason is only ever sent with a close.
    if (input.state === 'closed' && input.stateReason) payload['state_reason'] = input.stateReason
    const response = await this.host.request(this.host.issuePath(input), {
      method: 'PATCH',
      body: JSON.stringify(payload)
    })
    const reference = this.host.toIssueReference(response, input)
    if (!reference) throw new Error('The issue state change was not confirmed')
    return reference
  }

  async listIssueComments(input: IssueTarget): Promise<PullRequestComment[]> {
    const response = await this.host.request(
      `${this.host.issuePath(input)}/comments?per_page=100`,
      {
        method: 'GET'
      }
    )
    const items = Array.isArray(response) ? response : []
    return items.flatMap((item): PullRequestComment[] => {
      const comment = this.host.toComment(item)
      return comment ? [comment] : []
    })
  }

  /**
   * One conversation's history, from the timeline endpoint.
   *
   * A hundred events is one request, which covers a conversation of any ordinary
   * length. The endpoint is `/issues/{number}/timeline` for a pull request too,
   * because a pull request is an issue to this API and a repository's numbers are
   * one space, so the issue reader and the pull request conversation read the same
   * way through the same mapper.
   *
   * The events another part of the reader already draws are dropped here rather
   * than filtered by the renderer: `commented` because the comments arrive from
   * `listIssueComments` with the fields a comment row draws, `reviewed` because the
   * bundle's reviews carry the body and the inline threads the event does not, and
   * `committed` because a commit arrives once per commit (123 of them across a
   * dozen ordinary pull requests) and would drown the story the history tells. An
   * event type this provider does not map is dropped too, so an event GitHub adds
   * later is simply absent rather than rendered as a row saying nothing.
   */

  /**
   * One conversation's history, from the timeline endpoint.
   *
   * A hundred events is one request, which covers a conversation of any ordinary
   * length. The endpoint is `/issues/{number}/timeline` for a pull request too,
   * because a pull request is an issue to this API and a repository's numbers are
   * one space, so the issue reader and the pull request conversation read the same
   * way through the same mapper.
   *
   * The events another part of the reader already draws are dropped here rather
   * than filtered by the renderer: `commented` because the comments arrive from
   * `listIssueComments` with the fields a comment row draws, `reviewed` because the
   * bundle's reviews carry the body and the inline threads the event does not, and
   * `committed` because a commit arrives once per commit (123 of them across a
   * dozen ordinary pull requests) and would drown the story the history tells. An
   * event type this provider does not map is dropped too, so an event GitHub adds
   * later is simply absent rather than rendered as a row saying nothing.
   */
  async listIssueTimeline(input: IssueTarget): Promise<IssueTimelineEvent[]> {
    const response = await this.host.readCollection(
      `${this.host.issuePath(input)}/timeline?per_page=100`
    )
    const items = Array.isArray(response) ? response : []
    const events = items.flatMap((item): IssueTimelineEvent[] => {
      const event = this.host.toTimelineEvent(item)
      return event ? [event] : []
    })
    return this.dropClosedBesideMerge(events)
  }

  /**
   * Drop the `closed` event that a merge carries.
   *
   * A merged pull request reports `merged` and `closed` with the identical
   * `created_at`, and github.com draws one row for the pair. Removing the close it
   * shares with the merge leaves the merge as the single row the site shows. The
   * rule matches on the timestamp rather than on the presence of a merge, so a pull
   * request closed, reopened and later merged still shows the close that happened on
   * its own, and a payload without the shared timestamp shows both rows rather than
   * losing one.
   */

  /**
   * Drop the `closed` event that a merge carries.
   *
   * A merged pull request reports `merged` and `closed` with the identical
   * `created_at`, and github.com draws one row for the pair. Removing the close it
   * shares with the merge leaves the merge as the single row the site shows. The
   * rule matches on the timestamp rather than on the presence of a merge, so a pull
   * request closed, reopened and later merged still shows the close that happened on
   * its own, and a payload without the shared timestamp shows both rows rather than
   * losing one.
   */
  dropClosedBesideMerge(events: IssueTimelineEvent[]): IssueTimelineEvent[] {
    const mergeTimes = new Set(
      events.filter((event) => event.kind === 'merged').map((event) => event.createdAt)
    )
    if (mergeTimes.size === 0) return events
    return events.filter((event) => event.kind !== 'closed' || !mergeTimes.has(event.createdAt))
  }

  async createIssueComment(input: CreateIssueCommentInput): Promise<PullRequestComment> {
    const response = await this.host.request(`${this.host.issuePath(input)}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body: input.body })
    })
    const comment = this.host.toComment(response)
    if (!comment) throw new Error('The comment was posted but could not be read back')
    return comment
  }

  /**
   * Search the repository's issues, for a relationship picker.
   *
   * The same query and the same mapper the listing uses, so a candidate reads
   * exactly like a listed issue, including the node id the relationship writes need.
   * Sorted by most recently updated, because a picker is usually used on something
   * that moved lately.
   */

  /**
   * Search the repository's issues, for a relationship picker.
   *
   * The same query and the same mapper the listing uses, so a candidate reads
   * exactly like a listed issue, including the node id the relationship writes need.
   * Sorted by most recently updated, because a picker is usually used on something
   * that moved lately.
   */
  async searchIssueCandidates(input: SearchIssueCandidatesInput): Promise<IssueSummary[]> {
    const qualifiers = ['is:issue', `repo:${input.owner}/${input.repo}`]
    const text = input.text.trim()
    if (text) qualifiers.push(text)
    qualifiers.push(LIST_SORTS['updated'])
    const data = await this.host.runGraphql(ISSUE_LIST_QUERY, {
      q: qualifiers.join(' '),
      first: ISSUE_CANDIDATE_LIMIT,
      after: null
    })
    const search = this.host.readRecord(data, 'search')
    const nodes: unknown[] = search && Array.isArray(search['nodes']) ? search['nodes'] : []
    return nodes.flatMap((node): IssueSummary[] => {
      const summary = this.host.toGraphqlIssueSummary(node, input.owner, input.repo)
      return summary ? [summary] : []
    })
  }

  /**
   * Make one issue a sub-issue of another.
   *
   * GraphQL rather than REST because that is where the mutation exists, and it takes
   * the two issues by node id. The payload returns the updated issue; the caller
   * re-reads the relationship list instead of trusting a partial answer, since the
   * reader draws the parent and the children together.
   */

  /**
   * Where GitHub files an issue comment.
   *
   * Repository-scoped, with the issue number appearing nowhere in the path: a
   * comment is addressed by its own id, the same as the pull request conversation
   * comments that share this collection.
   */
  issueCommentPath(input: IssueCommentTarget): string {
    return `${this.host.repoPath(input)}/issues/comments/${input.commentId}`
  }

  /**
   * An issue's relationships, as four reads that answer together.
   *
   * GitHub splits them across endpoints that share no shape: the parent is one
   * object that 404s when there is none, and the three lists are collections of
   * full issue objects. They are read together because the reader draws one block,
   * and because a partial answer would be shown as "none yet" for a relationship
   * that merely could not be read.
   */

  async updateIssueComment(input: UpdateIssueCommentInput): Promise<PullRequestComment> {
    const response = await this.host.request(this.issueCommentPath(input), {
      method: 'PATCH',
      body: JSON.stringify({ body: input.body })
    })
    const comment = this.host.toComment(response)
    if (!comment) throw new Error('The comment was saved but could not be read back')
    return comment
  }

  async deleteIssueComment(input: IssueCommentTarget): Promise<void> {
    await this.host.request(this.issueCommentPath(input), { method: 'DELETE' })
  }

  /** Read pages sequentially so long conversations do not fan out requests. */
}
