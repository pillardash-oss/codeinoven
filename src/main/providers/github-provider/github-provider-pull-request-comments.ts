import type {
  PullRequestComment,
  PullRequestFile,
  PullRequestReview,
  PullRequestReviewComment,
  PullRequestReviewThread
} from '../../../lib/types'
import type {
  CreatePrCommentInput,
  CreatePrReviewInput,
  MinimizePrCommentInput,
  PrCommentTarget,
  PullRequestTarget,
  ReplyPrReviewCommentInput,
  ResolvePrReviewThreadInput,
  UpdatePrCommentInput
} from '../../git/git-provider.interface'
import type { GitHubProvider } from '../github-provider'

/**  pull-request-comments */
export class GitHubProviderPullRequestComments {
  constructor(private readonly host: GitHubProvider) {}

  async listPullRequestComments(input: PullRequestTarget): Promise<PullRequestComment[]> {
    // PR conversation comments live on the issues endpoint in the GitHub API.
    const response = await this.host.readCollection(
      `${this.host.repoPath(input)}/issues/${input.pullNumber}/comments?per_page=100`
    )
    const items = Array.isArray(response) ? response : []
    return items.flatMap((item): PullRequestComment[] => {
      const comment = this.host.toComment(item)
      return comment ? [comment] : []
    })
  }

  async createPullRequestComment(input: CreatePrCommentInput): Promise<PullRequestComment> {
    const response = await this.host.request(
      `${this.host.repoPath(input)}/issues/${input.pullNumber}/comments`,
      { method: 'POST', body: JSON.stringify({ body: input.body }) }
    )
    const comment = this.host.toComment(response)
    if (!comment) throw new Error('The comment was posted but could not be read back')
    return comment
  }

  /**
   * Where GitHub files a comment of this kind.
   *
   * Both collections are repository-scoped   the pull number appears in neither
   * path   which is why the target still carries one: it keeps every comment
   * input the same shape as the one that creates them.
   */

  async updatePullRequestComment(input: UpdatePrCommentInput): Promise<PullRequestComment> {
    const response = await this.host.request(
      `${this.host.repoPath(input)}${this.host.commentCollectionPath(input.kind)}/${input.commentId}`,
      { method: 'PATCH', body: JSON.stringify({ body: input.body }) }
    )
    const comment = this.host.toComment(response)
    if (!comment) throw new Error('The comment was saved but could not be read back')
    return comment
  }

  async deletePullRequestComment(input: PrCommentTarget): Promise<void> {
    await this.host.request(
      `${this.host.repoPath(input)}${this.host.commentCollectionPath(input.kind)}/${input.commentId}`,
      { method: 'DELETE' }
    )
  }

  async updatePullRequestReviewComment(
    input: UpdatePrCommentInput
  ): Promise<PullRequestReviewComment> {
    const response = await this.host.request(
      `${this.host.repoPath(input)}${this.host.commentCollectionPath('review')}/${input.commentId}`,
      { method: 'PATCH', body: JSON.stringify({ body: input.body }) }
    )
    const comment = this.toReviewComment(response, {
      owner: input.owner,
      repo: input.repo,
      pullNumber: input.pullNumber
    })
    if (!comment) throw new Error('The comment was saved but could not be read back')
    return comment
  }

  async deletePullRequestReviewComment(input: PrCommentTarget): Promise<void> {
    await this.host.request(
      `${this.host.repoPath(input)}${this.host.commentCollectionPath('review')}/${input.commentId}`,
      { method: 'DELETE' }
    )
  }

  /**
   * Answer an inline comment inside its thread.
   *
   * The reply endpoint hangs off the comment being answered, not the pull
   * request, which is what puts the answer in that comment's thread rather than
   * starting a new one.
   */

  /**
   * Answer an inline comment inside its thread.
   *
   * The reply endpoint hangs off the comment being answered, not the pull
   * request, which is what puts the answer in that comment's thread rather than
   * starting a new one.
   */
  async replyToPullRequestReviewComment(
    input: ReplyPrReviewCommentInput
  ): Promise<PullRequestReviewComment> {
    const response = await this.host.request(
      `${this.host.pullPath(input)}/comments/${String(input.commentId)}/replies`,
      { method: 'POST', body: JSON.stringify({ body: input.body }) }
    )
    const comment = this.toReviewComment(response, input)
    if (!comment) throw new Error('The reply was posted but could not be read back')
    return comment
  }

  /**
   * Hide a comment behind GitHub's "minimised" treatment.
   *
   * GitHub exposes no REST endpoint for this, only the GraphQL mutation, and the
   * mutation addresses the comment by its global node id rather than its number.
   */

  /**
   * Hide a comment behind GitHub's "minimised" treatment.
   *
   * GitHub exposes no REST endpoint for this, only the GraphQL mutation, and the
   * mutation addresses the comment by its global node id rather than its number.
   */
  async minimizePullRequestComment(input: MinimizePrCommentInput): Promise<void> {
    const data = await this.host.runGraphql(
      'mutation MinimizeComment($subjectId: ID!, $classifier: ReportedContentClassifiers!) { minimizeComment(input: { subjectId: $subjectId, classifier: $classifier }) { minimizedComment { isMinimized } } }',
      { subjectId: input.nodeId, classifier: input.reason }
    )
    const mutation = this.host.readRecord(data, 'minimizeComment')
    const comment = mutation ? this.host.readRecord(mutation, 'minimizedComment') : null
    if (!comment || comment['isMinimized'] !== true) {
      throw new Error('The provider did not hide the comment')
    }
  }

  async createPullRequestReview(input: CreatePrReviewInput): Promise<void> {
    await this.host.request(`${this.host.pullPath(input)}/reviews`, {
      method: 'POST',
      body: JSON.stringify({
        event: input.event,
        ...(input.body ? { body: input.body } : {})
      })
    })
  }

  async listPullRequestFiles(input: PullRequestTarget): Promise<PullRequestFile[]> {
    const response = await this.host.readCollection(
      `${this.host.pullPath(input)}/files?per_page=100`
    )
    return this.host.toFiles(response)
  }

  async listPullRequestReviews(input: PullRequestTarget): Promise<PullRequestReview[]> {
    const response = await this.host.readCollection(
      `${this.host.pullPath(input)}/reviews?per_page=100`
    )
    const items = Array.isArray(response) ? response : []
    return items.flatMap((item): PullRequestReview[] => {
      if (typeof item !== 'object' || item === null) return []
      const record = item as Record<string, unknown>
      const id = this.host.readNumber(record, 'id')
      const state = this.host.readString(record, 'state') ?? ''
      // A "PENDING" review has not been submitted and is invisible to others.
      if (id <= 0 || state === 'PENDING') return []
      return [
        {
          id,
          ...this.host.toAuthor(this.host.readRecord(record, 'user')),
          authorAssociation: this.host.toAuthorAssociation(record),
          state,
          body: this.host.readString(record, 'body') ?? '',
          submittedAt: this.host.readString(record, 'submitted_at') ?? '',
          url: `${this.host.pullPermalink(input)}#pullrequestreview-${String(id)}`,
          nodeId: this.host.readString(record, 'node_id')
        }
      ]
    })
  }

  async listPullRequestReviewComments(
    input: PullRequestTarget
  ): Promise<PullRequestReviewComment[]> {
    const response = await this.host.readCollection(
      `${this.host.pullPath(input)}/comments?per_page=100`
    )
    const items = Array.isArray(response) ? response : []
    return items.flatMap((item): PullRequestReviewComment[] => {
      const comment = this.toReviewComment(item, input)
      return comment ? [comment] : []
    })
  }

  /**
   * Resolution state for each inline thread.
   *
   * The comments themselves are REST, but GitHub keeps whether a thread is
   * settled on the GraphQL thread node, so this reads through the pull
   * request's `reviewThreads` connection instead. A failure here must not cost
   * the reader the comments they can still see, which is why the caller treats
   * it as optional.
   */

  /**
   * Resolution state for each inline thread.
   *
   * The comments themselves are REST, but GitHub keeps whether a thread is
   * settled on the GraphQL thread node, so this reads through the pull
   * request's `reviewThreads` connection instead. A failure here must not cost
   * the reader the comments they can still see, which is why the caller treats
   * it as optional.
   */
  async listPullRequestReviewThreads(input: PullRequestTarget): Promise<PullRequestReviewThread[]> {
    const data = await this.host.runGraphql(
      'query ReviewThreads($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewThreads(first: 100) { nodes { id isResolved isOutdated comments(first: 100) { nodes { databaseId } } } } } } }',
      { owner: input.owner, name: input.repo, number: input.pullNumber }
    )
    const repository = this.host.readRecord(data, 'repository')
    const pullRequest = repository ? this.host.readRecord(repository, 'pullRequest') : null
    const connection = pullRequest ? this.host.readRecord(pullRequest, 'reviewThreads') : null
    const nodes = connection ? connection['nodes'] : null
    if (!Array.isArray(nodes)) return []
    return nodes.flatMap((node): PullRequestReviewThread[] => {
      if (typeof node !== 'object' || node === null) return []
      const record = node as Record<string, unknown>
      const nodeId = this.host.readString(record, 'id')
      if (!nodeId) return []
      return [
        {
          nodeId,
          isResolved: record['isResolved'] === true,
          isOutdated: record['isOutdated'] === true,
          commentIds: this.host.readDatabaseIds(record)
        }
      ]
    })
  }

  /** Settle or reopen one thread through the mutation GraphQL keeps it behind. */

  /** Settle or reopen one thread through the mutation GraphQL keeps it behind. */
  async setPullRequestReviewThreadResolved(input: ResolvePrReviewThreadInput): Promise<void> {
    await this.host.runGraphql(
      input.resolved
        ? 'mutation ResolveReviewThread($threadId: ID!) { resolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } } }'
        : 'mutation UnresolveReviewThread($threadId: ID!) { unresolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } } }',
      { threadId: input.nodeId }
    )
  }

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

  /** Map an inline diff comment. GitHub's site links these with `#discussion_r<id>`. */
  toReviewComment(payload: unknown, input: PullRequestTarget): PullRequestReviewComment | null {
    if (typeof payload !== 'object' || payload === null) return null
    const record = payload as Record<string, unknown>
    const id = this.host.readNumber(record, 'id')
    if (id <= 0) return null
    const line = this.host.readNumber(record, 'line')
    const reviewId = this.host.readNumber(record, 'pull_request_review_id')
    const inReplyToId = this.host.readNumber(record, 'in_reply_to_id')
    const side = this.host.readString(record, 'side')
    return {
      id,
      ...this.host.toAuthor(this.host.readRecord(record, 'user')),
      authorAssociation: this.host.toAuthorAssociation(record),
      body: this.host.readString(record, 'body') ?? '',
      path: this.host.readString(record, 'path') ?? '',
      line: line > 0 ? line : null,
      // GitHub spells these `LEFT`/`RIGHT`; the app names the file they number.
      side: side === 'LEFT' ? 'left' : side === 'RIGHT' ? 'right' : null,
      reviewId: reviewId > 0 ? reviewId : null,
      inReplyToId: inReplyToId > 0 ? inReplyToId : null,
      diffHunk: this.host.readString(record, 'diff_hunk'),
      createdAt: this.host.readString(record, 'created_at') ?? '',
      updatedAt: this.host.readString(record, 'updated_at'),
      nodeId: this.host.readString(record, 'node_id'),
      url: `${this.host.pullPermalink(input)}#discussion_r${String(id)}`
    }
  }

  /**
   * CI state for the PR head.
   *
   * GitHub exposes two independent systems   modern check runs and classic commit
   * statuses   and a repository can use either, so both are merged here.
   */
}
