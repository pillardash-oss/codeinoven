import type {
  IssueReference,
  IssueStateReason,
  IssueSummary,
  IssueTimelineEvent,
  IssueTimelineEventKind,
  IssueTimelineReference,
  PrAuthorAssociation,
  PullRequestComment,
  PullRequestFile,
  PullRequestLabel,
  PullRequestMilestone,
  PullRequestReference,
  PullRequestSummary,
  RepositoryMentionUser
} from '../../../lib/types'
import type { GitHubProvider } from '../github-provider'

/**  mappers */
export class GitHubProviderMappers {
  constructor(private readonly host: GitHubProvider) {}

  toReference(payload: Record<string, unknown> | unknown[]): PullRequestReference {
    const record = Array.isArray(payload) ? {} : (payload as Record<string, unknown>)
    const number = this.readNumber(record, 'number')
    const htmlUrl = this.readString(record, 'html_url')
    const url =
      htmlUrl ??
      (number > 0
        ? `https://github.com/${this.readString(record, 'owner') ?? ''}/${this.readString(record, 'repo') ?? ''}/pull/${number}`
        : '')
    return {
      number,
      url,
      title: this.readString(record, 'title') ?? (number > 0 ? `Pull request #${number}` : '')
    }
  }

  toFiles(payload: unknown): PullRequestFile[] {
    const items = Array.isArray(payload) ? payload : []
    return items.flatMap((item): PullRequestFile[] => {
      if (typeof item !== 'object' || item === null) return []
      const record = item as Record<string, unknown>
      const path = this.readString(record, 'filename')
      if (!path) return []
      return [
        {
          path,
          status: this.readString(record, 'status') ?? 'modified',
          additions: this.readNumber(record, 'additions'),
          deletions: this.readNumber(record, 'deletions'),
          patch: this.readString(record, 'patch')
        }
      ]
    })
  }

  /**
   * Map one GraphQL search node to the renderer-safe summary, or null when it is
   * not a pull request (an issue search returns both kinds of node) or has no
   * usable number.
   */
  toGraphqlSummary(payload: unknown, owner: string, repo: string): PullRequestSummary | null {
    if (typeof payload !== 'object' || payload === null) return null
    const record = payload as Record<string, unknown>
    if (this.readString(record, '__typename') !== 'PullRequest') return null
    const number = this.readNumber(record, 'number')
    if (number <= 0) return null
    const author = this.readRecord(record, 'author')
    const login = author ? (this.readString(author, 'login') ?? 'unknown') : 'unknown'
    const rawState = this.readString(record, 'state')
    const state: PullRequestSummary['state'] =
      rawState === 'MERGED' ? 'merged' : rawState === 'CLOSED' ? 'closed' : 'open'
    const checks = this.host.readChecksRollup(record)
    const mergeStateStatus = this.readString(record, 'mergeStateStatus')
    return {
      number,
      title: this.readString(record, 'title') ?? `Pull request #${number}`,
      url: this.readString(record, 'url') ?? `https://github.com/${owner}/${repo}/pull/${number}`,
      state,
      draft: record['isDraft'] === true,
      authorLogin: login,
      authorAvatarUrl: author ? this.readString(author, 'avatarUrl') : null,
      authorIsBot: login.endsWith('[bot]'),
      headRef: this.readString(record, 'headRefName') ?? '',
      baseRef: this.readString(record, 'baseRefName') ?? '',
      createdAt: this.readString(record, 'createdAt') ?? '',
      updatedAt: this.readString(record, 'updatedAt') ?? '',
      comments: this.readNumber(record, 'totalCommentsCount'),
      labels: this.readLabels(record),
      assignees: this.readGraphqlAssignees(record),
      milestone: this.readGraphqlMilestone(record),
      ...(checks ? { checks } : {}),
      mergeable: this.readMergeable(record),
      mergeableState: mergeStateStatus ? mergeStateStatus.toLowerCase() : null
    }
  }

  /**
   * Assigned accounts from the GraphQL listing.
   *
   * The listing's `assignees` connection is typed as users, so the app-account
   * signal is the `[bot]` login suffix here rather than the user `type` REST
   * exposes.
   */

  /**
   * Assigned accounts from the GraphQL listing.
   *
   * The listing's `assignees` connection is typed as users, so the app-account
   * signal is the `[bot]` login suffix here rather than the user `type` REST
   * exposes.
   */
  readGraphqlAssignees(record: Record<string, unknown>): RepositoryMentionUser[] {
    const connection = this.readRecord(record, 'assignees')
    const nodes: unknown[] =
      connection && Array.isArray(connection['nodes']) ? connection['nodes'] : []
    return nodes.flatMap((node): RepositoryMentionUser[] => {
      if (typeof node !== 'object' || node === null) return []
      const entry = node as Record<string, unknown>
      const login = this.readString(entry, 'login')?.trim()
      if (!login) return []
      return [
        {
          login,
          name: this.readString(entry, 'name'),
          avatarUrl: this.readString(entry, 'avatarUrl'),
          bot: login.endsWith('[bot]')
        }
      ]
    })
  }

  /** The milestone a GraphQL listing node reports, or null when it has none. */

  /** The milestone a GraphQL listing node reports, or null when it has none. */
  readGraphqlMilestone(record: Record<string, unknown>): PullRequestMilestone | null {
    const milestone = this.readRecord(record, 'milestone')
    if (!milestone) return null
    const number = this.readNumber(milestone, 'number')
    if (number <= 0) return null
    return {
      number,
      title: this.readString(milestone, 'title') ?? `Milestone ${number}`,
      state: this.readString(milestone, 'state') === 'CLOSED' ? 'closed' : 'open',
      description: this.readString(milestone, 'description'),
      dueOn: this.readString(milestone, 'dueOn')
    }
  }

  /** GitHub's tri-state mergeability as a listing reports it; UNKNOWN stays null. */

  /** GitHub's tri-state mergeability as a listing reports it; UNKNOWN stays null. */
  readMergeable(record: Record<string, unknown>): boolean | null {
    const value = this.readString(record, 'mergeable')
    if (value === 'MERGEABLE') return true
    if (value === 'CONFLICTING') return false
    return null
  }

  /** Labels in GitHub's own order, dropping entries a chip cannot draw. */

  /** Labels in GitHub's own order, dropping entries a chip cannot draw. */
  readLabels(record: Record<string, unknown>): PullRequestLabel[] {
    const labels = this.readRecord(record, 'labels')
    const nodes: unknown[] = labels && Array.isArray(labels['nodes']) ? labels['nodes'] : []
    return nodes.flatMap((node): PullRequestLabel[] => {
      if (typeof node !== 'object' || node === null) return []
      const entry = node as Record<string, unknown>
      const name = this.readString(entry, 'name')
      if (!name) return []
      return [{ name, color: this.readString(entry, 'color') ?? '' }]
    })
  }

  /**
   * Map a label list from either REST shape.
   *
   * The label endpoints answer with label objects while older payloads answer
   * with the bare names, so both are read here and a name that is not a usable
   * chip is dropped rather than drawn as an empty one.
   */

  /**
   * Map a label list from either REST shape.
   *
   * The label endpoints answer with label objects while older payloads answer
   * with the bare names, so both are read here and a name that is not a usable
   * chip is dropped rather than drawn as an empty one.
   */
  toLabels(payload: unknown): PullRequestLabel[] {
    if (!Array.isArray(payload)) return []
    const seen = new Set<string>()
    const labels: PullRequestLabel[] = []
    for (const entry of payload) {
      const label = this.toLabel(entry)
      if (!label) continue
      const key = label.name.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      labels.push(label)
    }
    return labels
  }

  /** One label from either REST shape, or null when it carries no usable name. */

  /** One label from either REST shape, or null when it carries no usable name. */
  toLabel(entry: unknown): PullRequestLabel | null {
    if (typeof entry === 'string') {
      const name = entry.trim()
      return name ? { name, color: '', description: null } : null
    }
    if (typeof entry !== 'object' || entry === null) return null
    const record = entry as Record<string, unknown>
    const name = this.readString(record, 'name')?.trim()
    if (!name) return null
    return {
      name,
      color: this.readString(record, 'color') ?? '',
      description: this.readString(record, 'description')
    }
  }

  /** Map one milestone payload, or null when it is not a usable milestone. */

  /** Map one milestone payload, or null when it is not a usable milestone. */
  toMilestone(payload: unknown): PullRequestMilestone | null {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
    const record = payload as Record<string, unknown>
    const number = this.readNumber(record, 'number')
    if (number <= 0) return null
    return {
      number,
      title: this.readString(record, 'title') ?? `Milestone ${number}`,
      state: this.readString(record, 'state') === 'closed' ? 'closed' : 'open',
      description: this.readString(record, 'description'),
      dueOn: this.readString(record, 'due_on')
    }
  }

  /** Assigned accounts from an issue payload, deduplicated by login. */

  /** Assigned accounts from an issue payload, deduplicated by login. */
  toAssignees(record: Record<string, unknown>): RepositoryMentionUser[] {
    const raw: unknown[] = Array.isArray(record['assignees'])
      ? (record['assignees'] as unknown[])
      : []
    const seen = new Set<string>()
    return raw.flatMap((entry): RepositoryMentionUser[] => {
      if (typeof entry !== 'object' || entry === null) return []
      const user = entry as Record<string, unknown>
      const login = this.readString(user, 'login')?.trim()
      if (!login) return []
      const key = login.toLowerCase()
      if (seen.has(key)) return []
      seen.add(key)
      const name = this.readString(user, 'name')?.trim()
      return [
        {
          login,
          name: name ? name : null,
          avatarUrl: this.readString(user, 'avatar_url'),
          bot: this.readString(user, 'type') === 'Bot' || login.endsWith('[bot]')
        }
      ]
    })
  }

  /**
   * Roll up the head commit's checks, or undefined when the commit carries no
   * status rollup at all.
   *
   * Undefined rather than a `none` state on purpose: the list draws no check
   * signal for a repository that never ran anything, while `none` means the
   * rollup exists and is empty.
   */

  /** Map a GitHub pull payload to the renderer-safe summary, or null if unusable. */
  toSummary(payload: unknown, owner: string, repo: string): PullRequestSummary | null {
    if (typeof payload !== 'object' || payload === null) return null
    const record = payload as Record<string, unknown>
    const number = this.readNumber(record, 'number')
    if (number <= 0) return null
    const head = this.readRecord(record, 'head')
    const base = this.readRecord(record, 'base')
    const user = this.readRecord(record, 'user')
    const rawState = this.readString(record, 'state') ?? 'open'
    const merged = record['merged'] === true || this.readString(record, 'merged_at') !== null
    const mergeableRaw = record['mergeable']
    const mergeableStateRaw = this.readString(record, 'mergeable_state')
    const state = merged ? 'merged' : rawState === 'closed' ? 'closed' : 'open'
    return {
      number,
      title: this.readString(record, 'title') ?? `Pull request #${number}`,
      url:
        this.readString(record, 'html_url') ?? `https://github.com/${owner}/${repo}/pull/${number}`,
      state,
      draft: record['draft'] === true,
      ...this.toAuthor(user),
      headRef: head ? (this.readString(head, 'ref') ?? '') : '',
      baseRef: base ? (this.readString(base, 'ref') ?? '') : '',
      headRepository: this.readString(this.readRecord(head ?? {}, 'repo') ?? {}, 'full_name'),
      baseRepository: this.readString(this.readRecord(base ?? {}, 'repo') ?? {}, 'full_name'),
      createdAt: this.readString(record, 'created_at') ?? '',
      updatedAt: this.readString(record, 'updated_at') ?? '',
      comments: this.readNumber(record, 'comments'),
      labels: this.toLabels(record['labels']),
      assignees: this.toAssignees(record),
      milestone: this.toMilestone(record['milestone']),
      mergeable: typeof mergeableRaw === 'boolean' ? mergeableRaw : null,
      mergeableState: mergeableStateRaw || null
    }
  }

  /**
   * Map one GraphQL search node to the renderer-safe issue summary, or null when
   * it is not an issue or has no usable number.
   *
   * The `Issue` typename check is what keeps a pull request out of an issue
   * listing even if the search qualifiers ever let one through; the row must never
   * draw something the reader cannot open.
   */

  /**
   * Map one GraphQL search node to the renderer-safe issue summary, or null when
   * it is not an issue or has no usable number.
   *
   * The `Issue` typename check is what keeps a pull request out of an issue
   * listing even if the search qualifiers ever let one through; the row must never
   * draw something the reader cannot open.
   */
  toGraphqlIssueSummary(payload: unknown, owner: string, repo: string): IssueSummary | null {
    if (typeof payload !== 'object' || payload === null) return null
    const record = payload as Record<string, unknown>
    if (this.readString(record, '__typename') !== 'Issue') return null
    const number = this.readNumber(record, 'number')
    if (number <= 0) return null
    const author = this.readRecord(record, 'author')
    const login = author ? (this.readString(author, 'login') ?? 'unknown') : 'unknown'
    const comments = this.readRecord(record, 'comments')
    return {
      number,
      title: this.readString(record, 'title') ?? `Issue #${number}`,
      url: this.readString(record, 'url') ?? `https://github.com/${owner}/${repo}/issues/${number}`,
      state: this.readString(record, 'state') === 'CLOSED' ? 'closed' : 'open',
      stateReason: this.toStateReason(this.readString(record, 'stateReason')),
      authorLogin: login,
      authorAvatarUrl: author ? this.readString(author, 'avatarUrl') : null,
      authorIsBot: login.endsWith('[bot]'),
      createdAt: this.readString(record, 'createdAt') ?? '',
      updatedAt: this.readString(record, 'updatedAt') ?? '',
      comments: comments ? this.readNumber(comments, 'totalCount') : 0,
      labels: this.readLabels(record),
      assignees: this.readGraphqlAssignees(record),
      milestone: this.readGraphqlMilestone(record),
      nodeId: this.readString(record, 'id')
    }
  }

  /** Map a GitHub issue payload to the renderer-safe summary, or null if unusable. */

  /** Map a GitHub issue payload to the renderer-safe summary, or null if unusable. */
  toIssueSummary(payload: unknown, owner: string, repo: string): IssueSummary | null {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
    const record = payload as Record<string, unknown>
    const number = this.readNumber(record, 'number')
    if (number <= 0) return null
    return {
      number,
      title: this.readString(record, 'title') ?? `Issue #${number}`,
      url:
        this.readString(record, 'html_url') ??
        `https://github.com/${owner}/${repo}/issues/${number}`,
      state: this.readString(record, 'state') === 'closed' ? 'closed' : 'open',
      stateReason: this.toStateReason(this.readString(record, 'state_reason')),
      ...this.toAuthor(this.readRecord(record, 'user')),
      createdAt: this.readString(record, 'created_at') ?? '',
      updatedAt: this.readString(record, 'updated_at') ?? '',
      comments: this.readNumber(record, 'comments'),
      labels: this.toLabels(record['labels']),
      assignees: this.toAssignees(record),
      milestone: this.toMilestone(record['milestone']),
      nodeId: this.readString(record, 'node_id')
    }
  }

  /**
   * GitHub's closure reason, spelled once for both transports.
   *
   * The search vocabulary uppercases the enum (`NOT_PLANNED`) while the REST field
   * lowercases it (`not_planned`), so the two are folded together here and an
   * undocumented value is dropped rather than passed through as a word the row
   * cannot place.
   */

  /**
   * GitHub's closure reason, spelled once for both transports.
   *
   * The search vocabulary uppercases the enum (`NOT_PLANNED`) while the REST field
   * lowercases it (`not_planned`), so the two are folded together here and an
   * undocumented value is dropped rather than passed through as a word the row
   * cannot place.
   */
  toStateReason(raw: string | null): IssueStateReason | null {
    switch ((raw ?? '').toUpperCase()) {
      case 'COMPLETED':
        return 'completed'
      case 'NOT_PLANNED':
        return 'not_planned'
      case 'DUPLICATE':
        return 'duplicate'
      case 'REOPENED':
        return 'reopened'
      default:
        return null
    }
  }

  /**
   * One timeline event, or null when it is not one the reader renders.
   *
   * The endpoint is GitHub's own event log, which includes notification plumbing
   * github.com itself hides (`subscribed`, `mentioned`) alongside the comment
   * events the conversation already covers. Those are filtered here rather than in
   * the renderer, so the renderer's history is exactly the issue's own story. An
   * event type with no case below is likewise dropped: showing a row that cannot
   * say what happened would be worse than the omission.
   */

  /**
   * One timeline event, or null when it is not one the reader renders.
   *
   * The endpoint is GitHub's own event log, which includes notification plumbing
   * github.com itself hides (`subscribed`, `mentioned`) alongside the comment
   * events the conversation already covers. Those are filtered here rather than in
   * the renderer, so the renderer's history is exactly the issue's own story. An
   * event type with no case below is likewise dropped: showing a row that cannot
   * say what happened would be worse than the omission.
   */
  toTimelineEvent(payload: unknown): IssueTimelineEvent | null {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
    const record = payload as Record<string, unknown>
    const kind = this.toTimelineKind(this.readString(record, 'event'))
    if (!kind) return null
    const id = this.readNumber(record, 'id')
    const actor = this.toAuthor(this.readRecord(record, 'actor'))
    const event: IssueTimelineEvent = {
      id: id > 0 ? String(id) : `${kind}:${this.readString(record, 'created_at') ?? ''}`,
      kind,
      actorLogin: actor.authorLogin,
      actorAvatarUrl: actor.authorAvatarUrl,
      actorIsBot: actor.authorIsBot,
      createdAt: this.readString(record, 'created_at') ?? ''
    }
    switch (kind) {
      case 'labeled':
      case 'unlabeled':
        return { ...event, label: this.readTimelineLabel(record) }
      case 'assigned':
      case 'unassigned':
        return {
          ...event,
          assigneeLogin: this.readString(this.readRecord(record, 'assignee') ?? {}, 'login')
        }
      case 'closed':
        return {
          ...event,
          closeReason: this.toStateReason(this.readString(record, 'state_reason'))
        }
      case 'renamed': {
        const rename = this.readRecord(record, 'rename')
        return {
          ...event,
          rename: rename
            ? {
                from: this.readString(rename, 'from') ?? '',
                to: this.readString(rename, 'to') ?? ''
              }
            : null
        }
      }
      case 'milestoned':
      case 'demilestoned':
        return {
          ...event,
          milestoneTitle: this.readString(this.readRecord(record, 'milestone') ?? {}, 'title')
        }
      case 'locked':
        return { ...event, lockReason: this.readString(record, 'lock_reason') }
      case 'head_ref_force_pushed':
      case 'base_ref_force_pushed':
      case 'referenced':
      case 'merged':
        return { ...event, commitId: this.readString(record, 'commit_id') }
      case 'cross-referenced':
        return { ...event, reference: this.toTimelineReference(record) }
      case 'review_requested':
      case 'review_request_removed':
        return {
          ...event,
          reviewerLogin: this.readString(
            this.readRecord(record, 'requested_reviewer') ?? {},
            'login'
          ),
          reviewerTeamName: this.readString(this.readRecord(record, 'requested_team') ?? {}, 'name')
        }
      default:
        return event
    }
  }

  /**
   * The label a labeling event carried, or null when the payload omitted it.
   *
   * The event carries the label's own colour, so the chip the reader draws is the
   * same colour github.com draws without a catalog read.
   */

  /**
   * The label a labeling event carried, or null when the payload omitted it.
   *
   * The event carries the label's own colour, so the chip the reader draws is the
   * same colour github.com draws without a catalog read.
   */
  readTimelineLabel(record: Record<string, unknown>): PullRequestLabel | null {
    const label = this.readRecord(record, 'label')
    if (!label) return null
    const name = this.readString(label, 'name')
    if (!name) return null
    return { name, color: this.readString(label, 'color') ?? '' }
  }

  /**
   * What a cross-reference pointed at.
   *
   * GitHub nests the subject under `source.issue` for both kinds of link, with
   * `pull_request` present only when the subject is a pull request. The repository
   * is read from the subject itself, so a link that came from another repository
   * is labelled with the repository it lives in rather than with the issue's own.
   */

  /**
   * What a cross-reference pointed at.
   *
   * GitHub nests the subject under `source.issue` for both kinds of link, with
   * `pull_request` present only when the subject is a pull request. The repository
   * is read from the subject itself, so a link that came from another repository
   * is labelled with the repository it lives in rather than with the issue's own.
   */
  toTimelineReference(record: Record<string, unknown>): IssueTimelineReference | null {
    const source = this.readRecord(record, 'source')
    const issue = source ? this.readRecord(source, 'issue') : null
    if (!issue) return null
    const number = this.readNumber(issue, 'number')
    const url = this.readString(issue, 'html_url')
    if (number <= 0 || !url) return null
    return {
      url,
      number,
      title: this.readString(issue, 'title') ?? `#${number}`,
      repository: this.readString(this.readRecord(issue, 'repository') ?? {}, 'full_name') ?? '',
      isPullRequest: this.readRecord(issue, 'pull_request') !== null
    }
  }

  /**
   * The event kind the reader knows, or null for one it does not render.
   *
   * `issue_field_added` is GitHub's own opaque report of a change to an issue's
   * custom fields: the payload names neither the field nor its value, so it is
   * mapped to a field event that says a field changed without pretending to know
   * which one.
   *
   * Comments and reviews arrive from their richer collection endpoints. Commits
   * are added by the PR conversation builder so their author, message and date
   * remain available without duplicating timeline records.
   */

  /**
   * The event kind the reader knows, or null for one it does not render.
   *
   * `issue_field_added` is GitHub's own opaque report of a change to an issue's
   * custom fields: the payload names neither the field nor its value, so it is
   * mapped to a field event that says a field changed without pretending to know
   * which one.
   *
   * Comments and reviews arrive from their richer collection endpoints. Commits
   * are added by the PR conversation builder so their author, message and date
   * remain available without duplicating timeline records.
   */
  toTimelineKind(raw: string | null): IssueTimelineEventKind | null {
    switch (raw) {
      case 'labeled':
      case 'unlabeled':
      case 'assigned':
      case 'unassigned':
      case 'closed':
      case 'reopened':
      case 'renamed':
      case 'milestoned':
      case 'demilestoned':
      case 'locked':
      case 'unlocked':
      case 'pinned':
      case 'unpinned':
      case 'referenced':
      case 'cross-referenced':
      case 'marked_as_duplicate':
      case 'connected':
      case 'merged':
      case 'review_requested':
      case 'review_request_removed':
      case 'ready_for_review':
      case 'head_ref_deleted':
      case 'head_ref_force_pushed':
      case 'base_ref_changed':
      case 'base_ref_force_pushed':
      case 'head_ref_restored':
      case 'review_dismissed':
        return raw
      case 'issue_field_added':
        return 'fields'
      // github.com draws the draft transition, and the event arrives under both
      // spellings depending on which endpoint reported it, so both land on one kind
      // rather than the row going missing for whichever spelling this build met.
      case 'convert_to_draft':
      case 'converted_to_draft':
        return 'converted_to_draft'
      default:
        return null
    }
  }

  /** Address one issue's REST resource. */

  /** Map a GitHub issue payload to the reference a create or state change returns. */
  toIssueReference(
    payload: unknown,
    input: { owner: string; repo: string }
  ): IssueReference | null {
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
    const record = payload as Record<string, unknown>
    const number = this.readNumber(record, 'number')
    if (number <= 0) return null
    return {
      number,
      url:
        this.readString(record, 'html_url') ??
        `https://github.com/${input.owner}/${input.repo}/issues/${number}`,
      title: this.readString(record, 'title') ?? `Issue #${number}`
    }
  }

  toComment(payload: unknown): PullRequestComment | null {
    if (typeof payload !== 'object' || payload === null) return null
    const record = payload as Record<string, unknown>
    const id = this.readNumber(record, 'id')
    if (id <= 0) return null
    return {
      id,
      ...this.toAuthor(this.readRecord(record, 'user')),
      authorAssociation: this.toAuthorAssociation(record),
      body: this.readString(record, 'body') ?? '',
      createdAt: this.readString(record, 'created_at') ?? '',
      updatedAt: this.readString(record, 'updated_at'),
      nodeId: this.readString(record, 'node_id'),
      url: this.readString(record, 'html_url') ?? ''
    }
  }

  /**
   * What the commenter is to the repository.
   *
   * GitHub reports this on every REST comment payload as `author_association`,
   * and the conversation labels the commenter with it. A value GitHub has not
   * documented is dropped rather than passed through: the row draws the word,
   * and a word the reader cannot place is worse than no label at all.
   */

  /**
   * What the commenter is to the repository.
   *
   * GitHub reports this on every REST comment payload as `author_association`,
   * and the conversation labels the commenter with it. A value GitHub has not
   * documented is dropped rather than passed through: the row draws the word,
   * and a word the reader cannot place is worse than no label at all.
   */
  toAuthorAssociation(record: Record<string, unknown>): PrAuthorAssociation | null {
    const raw = this.readString(record, 'author_association')
    switch (raw) {
      case 'OWNER':
      case 'MEMBER':
      case 'COLLABORATOR':
      case 'CONTRIBUTOR':
      case 'FIRST_TIMER':
      case 'FIRST_TIME_CONTRIBUTOR':
      case 'MANNEQUIN':
      case 'NONE':
        return raw
      default:
        return null
    }
  }

  /**
   * The author fields every conversation row renders.
   *
   * The declared `avatar_url` is what makes an app account's picture correct.
   * Asking the avatar CDN for a login alone answers with GitHub's meaningless
   * generated identicon for a `[bot]` account, while this URL is the picture the
   * app itself published   the one github.com shows next to the same comment.
   */

  /**
   * The author fields every conversation row renders.
   *
   * The declared `avatar_url` is what makes an app account's picture correct.
   * Asking the avatar CDN for a login alone answers with GitHub's meaningless
   * generated identicon for a `[bot]` account, while this URL is the picture the
   * app itself published   the one github.com shows next to the same comment.
   */
  toAuthor(user: Record<string, unknown> | null): {
    authorLogin: string
    authorAvatarUrl: string | null
    authorIsBot: boolean
  } {
    if (!user) return { authorLogin: 'unknown', authorAvatarUrl: null, authorIsBot: false }
    const login = this.readString(user, 'login') ?? 'unknown'
    return {
      authorLogin: login,
      authorAvatarUrl: this.readString(user, 'avatar_url'),
      // `type` is the authoritative signal; the `[bot]` suffix is a fallback for
      // payloads that omit the user object's type.
      authorIsBot: this.readString(user, 'type') === 'Bot' || login.endsWith('[bot]')
    }
  }

  readRecord(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
    const value = record[key]
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  }

  readString(record: Record<string, unknown>, key: string): string | null {
    const value = record[key]
    return typeof value === 'string' ? value : null
  }

  readNumber(record: Record<string, unknown>, key: string): number {
    const value = record[key]
    return typeof value === 'number' && Number.isSafeInteger(value) ? value : 0
  }
}
