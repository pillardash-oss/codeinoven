import type {
  PrDraft,
  PullRequestCommit,
  PullRequestCompare,
  PullRequestDetail,
  PullRequestPage,
  PullRequestReference,
  PullRequestSummary
} from '../../../lib/types'
import type { SearchPullRequestsInput } from '../../git/git-provider.interface'
import type {
  ListPullRequestPageInput,
  ListPullRequestsInput,
  MergePullRequestInput,
  PullRequestTarget
} from '../../git/git-provider.interface'
import {
  LIST_SORTS,
  PR_SEARCH_LIMIT,
  PULL_REQUEST_LIST_QUERY,
  ProviderGraphqlError,
  ProviderHttpError
} from '../github-provider'
import type { GitHubProvider } from '../github-provider'

/**  pull-requests */
export class GitHubProviderPullRequests {
  constructor(private readonly host: GitHubProvider) {}

  async createPullRequest(draft: PrDraft): Promise<PullRequestReference> {
    const body = {
      title: draft.title,
      head: draft.head,
      base: draft.base,
      ...(draft.body !== undefined ? { body: draft.body } : {}),
      ...(draft.draft !== undefined ? { draft: draft.draft } : {})
    }
    const response = await this.host.request(
      `/repos/${encodeURIComponent(draft.owner)}/${encodeURIComponent(draft.repo)}/pulls`,
      { method: 'POST', body: JSON.stringify(body) }
    )
    return this.host.toReference(response)
  }

  async mergePullRequest(input: MergePullRequestInput): Promise<PullRequestReference> {
    const body: Record<string, unknown> = { merge_method: input.method }
    // Rebase preserves the original commits, so GitHub ignores custom messages
    // there. For merge-commit and squash the title/message become the commit.
    if (input.method !== 'rebase') {
      if (input.commitTitle) body['commit_title'] = input.commitTitle
      if (input.commitMessage) body['commit_message'] = input.commitMessage
    }
    const response = await this.host.request(
      `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/pulls/${input.pullNumber}/merge`,
      { method: 'PUT', body: JSON.stringify(body) }
    )
    const record = Array.isArray(response) ? {} : response
    return {
      number: input.pullNumber,
      url: `https://github.com/${input.owner}/${input.repo}/pull/${input.pullNumber}`,
      title: this.host.readString(record, 'title') ?? `Pull request #${input.pullNumber}`
    }
  }

  /**
   * Promote a draft pull request to ready-for-review.
   *
   * GitHub exposes this lifecycle transition through GraphQL rather than the
   * REST update endpoint. Resolve the PR's global node ID first, then return the
   * same renderer-safe reference shape as every other PR mutation.
   */

  /**
   * Promote a draft pull request to ready-for-review.
   *
   * GitHub exposes this lifecycle transition through GraphQL rather than the
   * REST update endpoint. Resolve the PR's global node ID first, then return the
   * same renderer-safe reference shape as every other PR mutation.
   */
  async markPullRequestReadyForReview(input: PullRequestTarget): Promise<PullRequestReference> {
    const detail = await this.host.request(this.host.pullPath(input), { method: 'GET' })
    const detailRecord = Array.isArray(detail) ? {} : detail
    if (detailRecord['draft'] !== true) return this.host.toReference(detailRecord)
    const pullRequestId = this.host.readString(detailRecord, 'node_id')
    if (!pullRequestId) {
      throw new Error(`Pull request #${input.pullNumber} has no provider node ID`)
    }

    const response = await this.host.runGraphql(
      'mutation MarkPullRequestReadyForReview($pullRequestId: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) { pullRequest { number title url } } }',
      { pullRequestId }
    )
    const mutation = this.host.readRecord(response, 'markPullRequestReadyForReview')
    const pullRequest = mutation ? this.host.readRecord(mutation, 'pullRequest') : null
    if (!pullRequest) {
      throw new Error(`Pull request #${input.pullNumber} was not marked ready for review`)
    }
    return {
      number: this.host.readNumber(pullRequest, 'number') || input.pullNumber,
      title:
        this.host.readString(pullRequest, 'title') ??
        this.host.readString(detailRecord, 'title') ??
        `Pull request #${input.pullNumber}`,
      url:
        this.host.readString(pullRequest, 'url') ??
        this.host.readString(detailRecord, 'html_url') ??
        `https://github.com/${input.owner}/${input.repo}/pull/${input.pullNumber}`
    }
  }

  /**
   * Compare two refs so the create-PR form can tell the user whether there is
   * anything to compare (GitHub's own "There isn't anything to compare" state).
   * A PR only makes sense when the head has commits the base lacks.
   */

  /**
   * Compare two refs so the create-PR form can tell the user whether there is
   * anything to compare (GitHub's own "There isn't anything to compare" state).
   * A PR only makes sense when the head has commits the base lacks.
   */
  async comparePullRequests(input: {
    owner: string
    repo: string
    base: string
    head: string
  }): Promise<PullRequestCompare> {
    const response = await this.host.request(
      `${this.host.repoPath(input)}/compare/${encodeURIComponent(input.base)}...${encodeURIComponent(input.head)}`,
      { method: 'GET' }
    )
    const record = Array.isArray(response) ? {} : response
    const rawStatus = this.host.readString(record, 'status')
    const status: PullRequestCompare['status'] =
      rawStatus === 'ahead' || rawStatus === 'behind' || rawStatus === 'diverged'
        ? rawStatus
        : 'identical'
    const totalCommits = this.host.readNumber(record, 'total_commits')
    const rawFiles = record['files']
    const filesChanged = Array.isArray(rawFiles) ? rawFiles.length : 0
    return {
      source: 'remote',
      status,
      aheadBy: this.host.readNumber(record, 'ahead_by'),
      behindBy: this.host.readNumber(record, 'behind_by'),
      totalCommits,
      filesChanged,
      hasChanges: (status === 'ahead' || status === 'diverged') && totalCommits > 0
    }
  }

  /** Reopen a closed pull request, the same way GitHub does. */

  /** Reopen a closed pull request, the same way GitHub does. */
  async reopenPullRequest(input: PullRequestTarget): Promise<PullRequestReference> {
    const response = await this.host.request(`${this.host.pullPath(input)}`, {
      method: 'PATCH',
      body: JSON.stringify({ state: 'open' })
    })
    return this.host.toReference(response)
  }

  /** Close an open pull request without merging, the same way GitHub does. */

  /** Close an open pull request without merging, the same way GitHub does. */
  async closePullRequest(input: PullRequestTarget): Promise<PullRequestReference> {
    const response = await this.host.request(`${this.host.pullPath(input)}`, {
      method: 'PATCH',
      body: JSON.stringify({ state: 'closed' })
    })
    return this.host.toReference(response)
  }

  /**
   * What a branch is as far as deleting it goes.
   *
   * The branch endpoint reports protection beside the commit it points at, and a
   * branch GitHub cannot find comes back 404. The three answers are kept apart
   * rather than collapsed into "may delete": a missing branch reading as
   * deletable is exactly the race that offers an action which cannot land.
   */

  /** Update an open pull request's title and/or description, mirroring GitHub's edit. */
  async updatePullRequest(
    input: PullRequestTarget & {
      title?: string
      body?: string
    }
  ): Promise<PullRequestReference> {
    const patch: Record<string, unknown> = {}
    if (input.title !== undefined) patch['title'] = input.title
    if (input.body !== undefined) patch['body'] = input.body
    const response = await this.host.request(`${this.host.pullPath(input)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch)
    })
    return this.host.toReference(response)
  }

  async listPullRequests(input: ListPullRequestsInput): Promise<PullRequestReference[]> {
    const query = input.state ? `?state=${encodeURIComponent(input.state)}` : ''
    const response = await this.host.request(
      `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/pulls${query}`,
      { method: 'GET' }
    )
    const items = Array.isArray(response) ? response : []
    return items.flatMap((item): PullRequestReference[] => {
      if (typeof item !== 'object' || item === null) return []
      const record = item as Record<string, unknown>
      const number = typeof record['number'] === 'number' ? record['number'] : 0
      if (number <= 0) return []
      return [
        {
          number,
          url: `https://github.com/${input.owner}/${input.repo}/pull/${number}`,
          title: typeof record['title'] === 'string' ? record['title'] : `Pull request #${number}`
        }
      ]
    })
  }

  async listPullRequestPage(input: ListPullRequestPageInput): Promise<PullRequestPage> {
    const state = input.state ?? 'open'
    const qualifiers = ['is:pr', `repo:${input.owner}/${input.repo}`]
    if (state === 'open') qualifiers.push('is:open')
    else if (state === 'closed') qualifiers.push('is:closed')
    if (input.filter === 'authored') qualifiers.push('author:@me')
    else if (input.filter === 'assigned') qualifiers.push('assignee:@me')
    else if (input.filter === 'review-requested') qualifiers.push('review-requested:@me')
    else if (input.filter === 'involves') qualifiers.push('involves:@me')
    qualifiers.push(LIST_SORTS[input.sort])

    // Ask for exactly the page size. An over-fetch of one extra would move
    // `endCursor` past the first row of the next page, because the cursor is the
    // last node the search returned.
    const perPage = Math.min(Math.max(input.perPage, 1), 50)
    try {
      const data = await this.host.runGraphql(PULL_REQUEST_LIST_QUERY, {
        q: qualifiers.join(' '),
        first: perPage,
        after: input.cursor
      })
      const search = this.host.readRecord(data, 'search')
      const nodes: unknown[] = search && Array.isArray(search['nodes']) ? search['nodes'] : []
      const items = nodes.flatMap((node) => {
        const summary = this.host.toGraphqlSummary(node, input.owner, input.repo)
        return summary ? [summary] : []
      })
      if (items.length > 0) {
        const stacks = await this.readPullRequestStacks(input).catch(
          () => new Map<number, PullRequestSummary[]>()
        )
        for (const item of items) item.stackCount = stacks.get(item.number)?.length ?? 0
      }
      const pageInfo = search ? this.host.readRecord(search, 'pageInfo') : null
      const hasMore = pageInfo?.['hasNextPage'] === true
      return {
        items,
        page: input.page,
        hasMore,
        // Only a finished page reports no cursor. GitHub returns the last node's
        // cursor on the final page too, where following it returns an empty set,
        // and a caller that walks from page one has no other way to tell that the
        // page it is about to ask for does not exist.
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

  /**
   * Search the repository's pull requests for the panel's find.
   *
   * Shares `PULL_REQUEST_LIST_QUERY` and its mapper with the listing, so a result is
   * a row the PR list itself would have drawn and opening it needs no second read.
   * Stack counts are left unset on purpose: a find is a jump to one pull request, and
   * the reader reads the stack when it opens.
   */

  /**
   * Search the repository's pull requests for the panel's find.
   *
   * Shares `PULL_REQUEST_LIST_QUERY` and its mapper with the listing, so a result is
   * a row the PR list itself would have drawn and opening it needs no second read.
   * Stack counts are left unset on purpose: a find is a jump to one pull request, and
   * the reader reads the stack when it opens.
   */
  async searchPullRequests(input: SearchPullRequestsInput): Promise<PullRequestSummary[]> {
    const qualifiers = ['is:pr', `repo:${input.owner}/${input.repo}`]
    if (input.state === 'open') qualifiers.push('is:open')
    else if (input.state === 'closed') qualifiers.push('is:closed')
    const text = input.text.trim()
    if (text) qualifiers.push(text)
    qualifiers.push(LIST_SORTS['updated'])
    try {
      const data = await this.host.runGraphql(PULL_REQUEST_LIST_QUERY, {
        q: qualifiers.join(' '),
        first: PR_SEARCH_LIMIT,
        after: null
      })
      const search = this.host.readRecord(data, 'search')
      const nodes: unknown[] = search && Array.isArray(search['nodes']) ? search['nodes'] : []
      return nodes.flatMap((node) => {
        const summary = this.host.toGraphqlSummary(node, input.owner, input.repo)
        return summary ? [summary] : []
      })
    } catch (failure) {
      // Same translation as the listing: the handler tells a repository this App
      // cannot see apart from a transient outage by HTTP status.
      if (failure instanceof ProviderGraphqlError) {
        if (failure.type === 'FORBIDDEN') throw new ProviderHttpError(403, failure.message)
        if (failure.type === 'NOT_FOUND') throw new ProviderHttpError(404, failure.message)
      }
      throw failure
    }
  }

  async getPullRequest(input: PullRequestTarget): Promise<PullRequestDetail> {
    const response = await this.host.request(`${this.host.pullPath(input)}`, { method: 'GET' })
    const record = Array.isArray(response) ? {} : response
    const summary = this.host.toSummary(record, input.owner, input.repo)
    if (!summary) throw new Error(`Pull request #${input.pullNumber} could not be read`)
    const mergeableRaw = record['mergeable']
    return {
      ...summary,
      authorAssociation: this.host.toAuthorAssociation(record),
      body: this.host.readString(record, 'body') ?? '',
      nodeId: this.host.readString(record, 'node_id'),
      mergeable: typeof mergeableRaw === 'boolean' ? mergeableRaw : null,
      merged: record['merged'] === true,
      additions: this.host.readNumber(record, 'additions'),
      deletions: this.host.readNumber(record, 'deletions'),
      changedFiles: this.host.readNumber(record, 'changed_files'),
      commitCount: this.host.readNumber(record, 'commits')
    }
  }

  async listPullRequestStack(input: PullRequestTarget): Promise<PullRequestSummary[]> {
    return (await this.readPullRequestStacks(input)).get(input.pullNumber) ?? []
  }

  async readPullRequestStacks(input: {
    owner: string
    repo: string
  }): Promise<Map<number, PullRequestSummary[]>> {
    const items = await this.host.readCollection(
      `${this.host.repoPath(input)}/pulls?state=open&per_page=100`
    )
    const prs = items.flatMap((item) => {
      const summary = this.host.toSummary(item, input.owner, input.repo)
      return summary ? [summary] : []
    })
    const headKey = (pr: PullRequestSummary): string | null =>
      pr.headRepository && pr.headRef ? `${pr.headRepository.toLowerCase()}:${pr.headRef}` : null
    const baseKey = (pr: PullRequestSummary): string | null =>
      pr.baseRepository && pr.baseRef ? `${pr.baseRepository.toLowerCase()}:${pr.baseRef}` : null
    const byHead = new Map<string, PullRequestSummary[]>()
    const byBase = new Map<string, PullRequestSummary[]>()
    for (const pr of prs) {
      const head = headKey(pr)
      const base = baseKey(pr)
      if (head) {
        const rows = byHead.get(head)
        if (rows) rows.push(pr)
        else byHead.set(head, [pr])
      }
      if (base) {
        const rows = byBase.get(base)
        if (rows) rows.push(pr)
        else byBase.set(base, [pr])
      }
    }
    const stacks = new Map<number, PullRequestSummary[]>()
    const visited = new Set<number>()
    for (const current of prs) {
      if (visited.has(current.number)) continue
      const depths = new Map<number, number>([[current.number, 0]])
      const queue = [current]
      const expandedParents = new Set<string>()
      const expandedChildren = new Set<string>()
      for (let index = 0; index < queue.length; index += 1) {
        const pr = queue[index]
        const depth = depths.get(pr.number) ?? 0
        const base = baseKey(pr) ?? ''
        const head = headKey(pr) ?? ''
        const parents = expandedParents.has(base) ? [] : (byHead.get(base) ?? [])
        const children = expandedChildren.has(head) ? [] : (byBase.get(head) ?? [])
        expandedParents.add(base)
        expandedChildren.add(head)
        for (const [neighbors, offset] of [
          [parents, -1],
          [children, 1]
        ] as const) {
          for (const next of neighbors) {
            if (depths.has(next.number)) continue
            depths.set(next.number, depth + offset)
            queue.push(next)
          }
        }
      }
      for (const pr of queue) visited.add(pr.number)
      if (queue.length < 2) continue
      queue.sort(
        (a, b) => (depths.get(a.number) ?? 0) - (depths.get(b.number) ?? 0) || a.number - b.number
      )
      for (const pr of queue) stacks.set(pr.number, queue)
    }
    return stacks
  }

  async listPullRequestCommits(input: PullRequestTarget): Promise<PullRequestCommit[]> {
    const response = await this.host.readCollection(
      `${this.host.pullPath(input)}/commits?per_page=100`
    )
    const items = Array.isArray(response) ? response : []
    return items.flatMap((item): PullRequestCommit[] => {
      if (typeof item !== 'object' || item === null) return []
      const record = item as Record<string, unknown>
      const sha = this.host.readString(record, 'sha')
      if (!sha) return []
      const commit = this.host.readRecord(record, 'commit')
      const author = commit ? this.host.readRecord(commit, 'author') : null
      return [
        {
          sha,
          shortSha: sha.slice(0, 7),
          message:
            (commit ? (this.host.readString(commit, 'message') ?? '') : '').split('\n')[0] ?? '',
          authorName: author ? (this.host.readString(author, 'name') ?? 'unknown') : 'unknown',
          date: author ? (this.host.readString(author, 'date') ?? '') : ''
        }
      ]
    })
  }
}
