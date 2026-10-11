import type { AgentProviderIssue } from './agent-events'

/** Filter for pull request listings. */
export type PrState = 'open' | 'closed' | 'all'

/**
 * Which pull requests a listing shows, beyond the state filter.
 *
 * GitHub's own pull request list narrows by the viewer's relationship to the
 * pull request, which is a question only the search index can answer
 * (`author:@me`, `involves:@me`, …). These are those relationships; `all` adds
 * no qualifier at all.
 */
export type PrListFilter = 'all' | 'authored' | 'assigned' | 'review-requested' | 'involves'

/**
 * How a pull request listing is ordered.
 *
 * One member per `sort:` qualifier GitHub's search accepts, which is the same set
 * github.com's pull request list offers. A bare `sort:updated` already means
 * descending, so the plain members keep the spelling the provider always sent and
 * only the reversed and comment orderings are new.
 */
export type PrListSort =
  'updated' | 'created' | 'comments-desc' | 'updated-asc' | 'created-asc' | 'comments-asc'

/**
 * The listing choices that are not the state filter or the page: what the page
 * was asked as one value, so the store can key a cached page by all of it.
 */
export interface PrListQuery {
  filter: PrListFilter
  sort: PrListSort
}

/**
 * A listing request, as the renderer sends it: the choices plus the page of the
 * page it continues from.
 *
 * The cursor is grouped with the choices rather than sent as its own argument
 * because a cursor only ever means anything alongside the filter and sort that
 * produced it.
 */
export interface PrListRequest extends PrListQuery {
  /** Cursor the previous page reported, or null to ask for the first page. */
  cursor: string | null
}

/** Draft-shaped request to create a pull request on the provider. */
export interface PrDraft {
  owner: string
  repo: string
  title: string
  body?: string
  head: string
  base: string
  draft?: boolean
}

/** PR create request as the renderer sends it; owner/repo resolve from the origin. */
export type PrCreateInput = Omit<PrDraft, 'owner' | 'repo'>

/** GitHub App installation access needed before a repository mutation can run. */
export interface GitHubPermissionRequired {
  status: 'permission_required'
  message: string
  settingsUrl: string
}

/** Typed boundary for GitHub writes, including recoverable installation access. */
export type GitHubMutationResult<T> = { status: 'completed'; value: T } | GitHubPermissionRequired

/** Result of submitting a pull-request review through the GitHub App. */
export type PullRequestReviewResult = GitHubMutationResult<null>

/** Renderer-safe PR reference created or merged by a provider. */
export interface PullRequestReference {
  number: number
  url: string
  title: string
}

/**
 * Pull request as shown in the sidebar list.
 *
 * No avatar field: the renderer CSP blocks remote image hosts, so the UI resolves a
 * picture from `authorLogin` through main, which inlines it as a `data:` URL, and
 * draws a monogram of the login until it arrives (see `PrAvatar.svelte`).
 */
export interface PullRequestSummary {
  number: number
  title: string
  url: string
  state: 'open' | 'closed' | 'merged'
  draft: boolean
  authorLogin: string
  /**
   * The author's picture as the provider declares it. Authoritative over the
   * login-derived guess: a bot account's `[bot]` login resolves to a meaningless
   * identicon on the avatar CDN, while this URL is the app's real picture, the
   * one github.com shows.
   */
  authorAvatarUrl?: string | null
  /** True for app/bot accounts, which GitHub labels with a `Bot` badge. */
  authorIsBot?: boolean
  headRef: string
  baseRef: string
  createdAt: string
  updatedAt: string
  /**
   * How many comments the pull request has received, as github.com counts them:
   * issue comments and review comments together. The listing asks for GitHub's
   * `totalCommentsCount`, which is that same figure, because a review thread is
   * part of the conversation a reader weighs before opening the pull request.
   * The REST payloads GitHub returns elsewhere carry the issue-comment count
   * alone, so a locally-constructed summary can report the smaller number.
   */
  comments: number
  /** Labels in GitHub's own order. Absent when the payload did not carry them. */
  labels?: PullRequestLabel[]
  /**
   * Accounts assigned to the pull request, in the provider's order. Same shape as
   * the mention directory's accounts on purpose: GitHub answers both from the same
   * assignable-accounts collection, so a person is described the same way whether
   * they are being assigned or @-mentioned, and one picker renders both.
   */
  assignees?: RepositoryMentionUser[]
  /**
   * The milestone the pull request belongs to, or null when it has none. Absent
   * for a summary built outside a listing, the same as `labels`.
   */
  milestone?: PullRequestMilestone | null
  /**
   * Rolled-up check state for the head commit, with the counts behind it. Absent
   * for a summary built outside a listing: the detail fetches its own checks.
   */
  checks?: PullRequestChecksRollup
  /**
   * Whether the provider has computed the PR as mergeable (`false` = conflicts).
   * Populated from list payloads where available; absent for locally-constructed
   * summaries (e.g. a just-created PR). Null when not yet computed.
   */
  mergeable?: boolean | null
  /**
   * GitHub's `mergeable_state` from list payloads   `dirty` means the PR has
   * conflicts even when `mergeable` hasn't been computed yet (it is frequently
   * null in list responses). `clean` | `dirty` | `behind` | `unstable` |
   * `draft` | `unknown`.
   */
  mergeableState?: string | null
}

/** One page of pull requests, with a cursor the UI can advance. */
export interface PullRequestPage {
  items: PullRequestSummary[]
  /** The 1-based page this listing answers. */
  page: number
  /** Whether another page exists after this one. */
  hasMore: boolean
  /**
   * Where the next page starts, for providers that page by cursor. Null when
   * this is the last page, and absent when the provider pages by number.
   */
  nextCursor?: string | null
  /** Actionable repository-access failure returned without rejecting IPC. */
  accessError?: string
  /**
   * A transient transport failure (offline, timeout) returned instead of a
   * rejected IPC call.
   *
   * Kept apart from `accessError`, which is a permissions fact about the
   * repository: a transient failure carries no rows of its own, so the listing
   * holds on to the rows it already had and shows this line beside them rather
   * than replacing them, and it offers no repository-access action.
   */
  transientError?: string
}

/**
 * GitHub compare result for two refs, used to gate pull request creation.
 * A PR only makes sense when the head actually has commits the base lacks.
 */
export interface PullRequestCompare {
  /** Whether the comparison reflects GitHub or commits that only exist locally. */
  source: 'remote' | 'local'
  status: 'ahead' | 'behind' | 'diverged' | 'identical'
  /** Commits the head has that the base does not. */
  aheadBy: number
  /** Commits the base has that the head does not. */
  behindBy: number
  totalCommits: number
  /** Changed files between the two refs. */
  filesChanged: number
  /** Whether creating a pull request makes sense at all (head is ahead/diverged). */
  hasChanges: boolean
  /**
   * An already-open pull request for the exact head→base pair, when one exists.
   * GitHub rejects a second open PR for the same pair with a 422, so the form
   * can warn and offer to open the existing PR instead of hitting that error.
   */
  existing?: PullRequestSummary | null
}

/** Full pull request view, loaded when one is opened in the sidebar. */
export interface PullRequestDetail extends PullRequestSummary {
  body: string
  /**
   * GraphQL global id of the pull request itself.
   *
   * The description is a field on the pull request rather than a comment, so the
   * only handle GitHub accepts for reacting to it is the pull request's own node
   * id. Null when the payload did not carry one, and the description then offers
   * no reaction control rather than one that cannot land.
   */
  nodeId: string | null
  /**
   * What the pull request's author is to the repository. The description is a
   * comment like any other in the conversation, so it carries the same role
   * badge its author's comments do.
   */
  authorAssociation: PrAuthorAssociation | null
  /** Null when the provider has not finished computing mergeability yet. */
  mergeable: boolean | null
  merged: boolean
  additions: number
  deletions: number
  changedFiles: number
  commitCount: number
}

/** One commit belonging to a pull request. */
export interface PullRequestCommit {
  sha: string
  /** Seven-character short sha, precomputed for display. */
  shortSha: string
  message: string
  authorName: string
  date: string
}

/**
 * Which provider collection a comment lives in. GitHub keeps conversation
 * comments and inline diff comments on two separate endpoints with unrelated
 * ids, so every comment mutation has to say which one it means.
 */
export type PrCommentKind = 'issue' | 'review'

/**
 * Which side of a diff a line number belongs to.
 *
 * GitHub numbers a comment by the file it is anchored in: a comment on an added
 * or context line carries a line of the file after the change (`right`), while a
 * comment on a removed line carries one of the file before it (`left`). The two
 * numberings overlap, so without this a deletion comment is read against the
 * wrong line.
 */
export type PrCommentSide = 'left' | 'right'

/**
 * What an account is to the repository a comment was written in.
 *
 * GitHub reports this beside every comment as `author_association`, and the
 * conversation row labels the commenter with it, the same way github.com does.
 * These are GitHub's own eight values: `MANNEQUIN` is the placeholder it keeps
 * for an account that no longer exists, and `NONE` is an account with no
 * relationship to the repository, which is why neither of them earns a label.
 */
export type PrAuthorAssociation =
  | 'OWNER'
  | 'MEMBER'
  | 'COLLABORATOR'
  | 'CONTRIBUTOR'
  | 'FIRST_TIMER'
  | 'FIRST_TIME_CONTRIBUTOR'
  | 'MANNEQUIN'
  | 'NONE'

/**
 * An account whose picture the UI wants.
 *
 * The declared URL is authoritative and the login is the fallback. That order
 * matters for app accounts: asking the avatar CDN for `pullfrog[bot]` by login
 * alone answers with GitHub's meaningless generated identicon, while the URL the
 * provider returned for the same comment is the picture the app itself published,
 * the one github.com shows next to that comment.
 */
export interface GitHubAvatarRequest {
  login: string
  avatarUrl?: string | null
}

/**
 * Why a comment was hidden. GitHub's own minimisation classifiers, in its own
 * order: `minimizeComment` rejects anything outside this set.
 */
export type PrMinimizeReason = 'ABUSE' | 'OFF_TOPIC' | 'OUTDATED' | 'RESOLVED' | 'SPAM'

/**
 * One emoji a comment can be reacted with, as GitHub's GraphQL enum spells it.
 *
 * These eight are the whole set GitHub accepts: its picker draws exactly them,
 * and `addReaction` rejects anything else. The REST endpoints spell the same
 * values differently (`+1`, `-1`, `laugh`, `hooray`), so the GraphQL spelling is
 * the one the app keeps and the one every surface passes around.
 */
export type PrReactionContent =
  'THUMBS_UP' | 'THUMBS_DOWN' | 'LAUGH' | 'HOORAY' | 'CONFUSED' | 'HEART' | 'ROCKET' | 'EYES'

/** One account that reacted to a comment. */
export interface PrReactionActor {
  login: string
  /** The actor's picture as the provider declared it, when it published one. */
  avatarUrl: string | null
}

/**
 * One emoji's reactions on one comment.
 *
 * `count` is authoritative and `actors` is capped by the read, so a reader that
 * shows a name list must read `count` for the total rather than the array's
 * length. A group with no reactors is never carried at all: GitHub answers all
 * eight groups for every subject, and seven of them saying nothing is noise the
 * conversation would otherwise have to filter on every render.
 */
export interface PrReactionGroup {
  content: PrReactionContent
  /** True when the signed-in account is one of the reactors. */
  viewerHasReacted: boolean
  /** How many accounts reacted with this emoji. */
  count: number
  /** The reactors the read returned, newest first, capped by the provider. */
  actors: PrReactionActor[]
}

/**
 * Every reaction on a conversation, keyed by the GraphQL node id of the subject
 * it belongs to.
 *
 * Keyed rather than attached to each subject because GitHub answers reactions per
 * subject, not per comment list: one batched read covers a pull request's
 * description, comments, reviews and inline comments alike, and an issue with its
 * comments, and the renderer looks a row up by the node id it already carries.
 */
export type PrReactionMap = Record<string, PrReactionGroup[]>

/** One reaction to add or take back, addressed to the comment it belongs to. */
export interface SetPrReactionInput {
  /** GraphQL global id of the comment, review or pull request being reacted to. */
  nodeId: string
  content: PrReactionContent
  /** True to add the signed-in account's reaction, false to take it back. */
  add: boolean
}

/** One issue comment on a pull request. */
export interface PullRequestComment {
  id: number
  authorLogin: string
  /** Provider-declared picture, preferred over the login-derived guess. */
  authorAvatarUrl: string | null
  /** True for app/bot accounts, so the row can draw GitHub's `Bot` badge. */
  authorIsBot: boolean
  /** What the commenter is to the repository, for the row's role badge. */
  authorAssociation: PrAuthorAssociation | null
  body: string
  createdAt: string
  /** Last edit time, null when the comment has never been edited. */
  updatedAt: string | null
  /** GraphQL global id, the only handle `minimizeComment` accepts. */
  nodeId: string | null
  url: string
}

/**
 * An account that can be @-mentioned in a pull request conversation. Built from
 * the repository's assignable users, the widest list GitHub exposes to a read
 * token; app accounts arrive as `login[bot]`.
 */
export interface RepositoryMentionUser {
  login: string
  /** Display name, when the account publishes one. */
  name: string | null
  avatarUrl: string | null
  /** True for app/bot accounts, which GitHub renders as an app mention. */
  bot: boolean
}

/** Review verdict submitted from the sidebar. */
export type PrReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'

/** One changed file in a pull request or commit, with its unified patch. */
export interface PullRequestFile {
  path: string
  /** Provider status: added, modified, removed, renamed… */
  status: string
  additions: number
  deletions: number
  /** Unified diff hunk text; null for binary files or oversized patches. */
  patch: string | null
}

/** A submitted review (approval, change request, or review comment). */
export interface PullRequestReview {
  id: number
  authorLogin: string
  authorAvatarUrl: string | null
  authorIsBot: boolean
  /** What the reviewer is to the repository, for the row's role badge. */
  authorAssociation: PrAuthorAssociation | null
  /** APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED… */
  state: string
  body: string
  submittedAt: string
  /** Permalink to the review inside the pull request conversation. */
  url: string
  /**
   * GraphQL global id. Present so the reader can address the review, but note
   * that GitHub exposes no edit or delete for a submitted review's body, so the
   * actions menu deliberately offers only the copy and quote actions for one.
   */
  nodeId: string | null
}

/** An inline code comment attached to a line of the diff. */
export interface PullRequestReviewComment {
  id: number
  authorLogin: string
  authorAvatarUrl: string | null
  authorIsBot: boolean
  /** What the commenter is to the repository, for the row's role badge. */
  authorAssociation: PrAuthorAssociation | null
  body: string
  path: string
  /** Line in the file the comment anchors to; null once outdated. */
  line: number | null
  /** Which file `line` numbers, or null when the provider did not say. */
  side: PrCommentSide | null
  /**
   * The review this comment was submitted with, or null when the provider did
   * not attribute it. GitHub submits a review's inline comments and its summary
   * together, so this is what keeps a review's threads next to its verdict
   * instead of floating loose in the chronological stream.
   */
  reviewId: number | null
  /**
   * The comment this one answers, or null for the comment that opened the
   * thread. GitHub nests a reply under its parent, so this is what decides
   * whether a comment starts a thread or continues one.
   */
  inReplyToId: number | null
  /**
   * The diff GitHub showed when the comment was written, as a unified hunk
   * header plus its lines. It is the code the reader has to see to judge the
   * comment, and it survives the line going outdated, which the live file
   * would not.
   */
  diffHunk: string | null
  createdAt: string
  updatedAt: string | null
  nodeId: string | null
  /** Permalink to the inline comment inside the pull request conversation. */
  url: string
}

/**
 * One review thread's GitHub-side state.
 *
 * GitHub hangs resolution on the thread rather than on any of its comments, and
 * exposes it only through GraphQL, so the REST comment list cannot say whether a
 * thread is settled. This carries that state beside the comments the reader
 * renders, which is what lets a thread be resolved without leaving the app.
 */
export interface PullRequestReviewThread {
  /** GraphQL global id, the only handle resolve and unresolve accept. */
  nodeId: string
  isResolved: boolean
  /** True once the line the thread was written about has left the diff. */
  isOutdated: boolean
  /** Ids of the comments in the thread, which is how a built thread finds it. */
  commentIds: number[]
}

/** One CI check or commit status on the PR head. */
export interface PullRequestCheck {
  name: string
  status: 'queued' | 'in_progress' | 'completed' | 'unknown'
  conclusion:
    | 'success'
    | 'failure'
    | 'neutral'
    | 'cancelled'
    | 'timed_out'
    | 'action_required'
    | 'skipped'
    | null
  /** Provider page for the run, when one exists. */
  url: string | null
  /** GitHub Actions workflow-run id, when this check belongs to an Actions run. */
  workflowRunId: number | null
  /**
   * GitHub Actions job id for this exact check, when its provider URL names one.
   * A run has many jobs (one per matrix leg), so this is what lets the panel read
   * the log of the check that was clicked rather than the run's first job.
   */
  jobId: number | null
}

/** Rolled-up CI state for a pull request head. */
export interface PullRequestChecks {
  state: 'success' | 'failure' | 'pending' | 'none'
  checks: PullRequestCheck[]
}

/**
 * A pull request's checks as a listing reports them: the rollup state and the
 * counts behind its `passed/total` label, without every individual check.
 *
 * `state` is `PullRequestChecks['state']` on purpose. The list draws the same pill
 * the detail header draws, so a new state has to be added in one place or neither
 * surface compiles.
 */
export interface PullRequestChecksRollup {
  state: PullRequestChecks['state']
  /** Checks that already concluded successfully. */
  passed: number
  /** Every check the provider reports for the head commit. */
  total: number
}

/** One label on a pull request, as GitHub declares it. */
export interface PullRequestLabel {
  name: string
  /** Six hex digits without `#`, which is exactly what a chip's colour needs. */
  color: string
  /**
   * The label's own description from the repository catalog. Only the catalog
   * read fills this in: a label carried on a pull request payload has no room for
   * it, and a chip never draws it.
   */
  description?: string | null
}

/**
 * One milestone a repository exposes, for a picker and for what a pull request
 * reports it is attached to.
 *
 * A milestone is an issue field on GitHub, not a pull request field, so both the
 * catalog and the assignment travel through the issues endpoints.
 */
export interface PullRequestMilestone {
  number: number
  title: string
  /** `open` for a milestone still accepting work, `closed` once it is finished. */
  state: 'open' | 'closed'
  /** The milestone's own description, when it publishes one. */
  description: string | null
  /** Due date as the provider declares it, or null when none is set. */
  dueOn: string | null
}

/**
 * Everything the PR detail view renders, fetched in one round trip.
 *
 * The sidebar shows this as a single unit, so bundling avoids six sequential
 * spinners and lets the renderer cache one object per pull request.
 */
export interface PullRequestBundle {
  detail: PullRequestDetail
  commits: PullRequestCommit[]
  comments: PullRequestComment[]
  reviews: PullRequestReview[]
  reviewComments: PullRequestReviewComment[]
  /** Resolution state per inline thread, which only GraphQL reports. */
  reviewThreads: PullRequestReviewThread[]
  /**
   * Reactions on the conversation, keyed by the node id of the comment they are
   * on. One batched GraphQL read fills it for the description, the comments, the
   * reviews and the inline comments together.
   */
  reactions: PrReactionMap
  files: PullRequestFile[]
  checks: PullRequestChecks
  /** Epoch ms this bundle was fetched, for cache staleness display. */
  fetchedAt: number
}

/**
 * How an issue listing narrows, beyond its state.
 *
 * GitHub's own issue list narrows by the viewer's relationship to the issue, a
 * question only its search index can answer (`author:@me`, `assignee:@me`,
 * `mentions:@me`, `involves:@me`). These are those relationships; `all` adds no
 * qualifier at all. Deliberately its own union rather than a reuse of
 * `PrListFilter`: an issue has no reviewer to be requested from, so a filter the
 * provider cannot answer must never be offerable.
 */
export type IssueListFilter = 'all' | 'created' | 'assigned' | 'mentioned' | 'involves'

/**
 * How an issue listing is ordered.
 *
 * The same `sort:` qualifiers a pull request listing accepts, because GitHub's
 * search index orders both kinds of node the same way. Reused rather than
 * restated so an ordering added for pull requests cannot silently go missing for
 * issues.
 */
export type IssueListSort = PrListSort

/**
 * The listing choices that are not the state filter or the page: what the page
 * was asked as one value, so the store can key a cached page by all of it.
 */
export interface IssueListQuery {
  filter: IssueListFilter
  sort: IssueListSort
}

/**
 * A listing request, as the renderer sends it: the choices plus where to continue
 * from. The cursor is grouped with the choices because it only ever means
 * anything alongside the filter and sort that produced it.
 */
export interface IssueListRequest extends IssueListQuery {
  /** Cursor the previous page reported, or null to ask for the first page. */
  cursor: string | null
}

/**
 * A repository label as an issue carries it.
 *
 * Labels are repository-level metadata on GitHub, so an issue and a pull request
 * carry the very same shape, and the same picker edits both.
 */
export type IssueLabel = PullRequestLabel

/** A repository milestone, which GitHub itself models as an issue field. */
export type IssueMilestone = PullRequestMilestone

/**
 * One comment on an issue.
 *
 * GitHub files issue comments and pull request conversation comments in one
 * collection with one payload shape, which is exactly why this is the comment
 * type the pull request conversation already renders.
 */
export type IssueComment = PullRequestComment

/** Renderer-safe issue reference returned by a create or state change. */
export type IssueReference = PullRequestReference

/**
 * Why an issue was closed, as GitHub's `state_reason` reports it.
 *
 * `completed` is a resolved issue, `not_planned` is one dismissed on purpose,
 * `duplicate` is one superseded by another, and `reopened` is what GitHub keeps
 * while an issue carries no closure reason because it was brought back. Null when
 * the payload carries none.
 */
export type IssueStateReason = 'completed' | 'not_planned' | 'duplicate' | 'reopened'

/**
 * One issue as shown in the sidebar list.
 *
 * No avatar field: the renderer CSP blocks remote image hosts, so the UI resolves
 * a picture from `authorLogin` through main and draws a monogram until it
 * arrives, exactly as the pull request list does.
 */
export interface IssueSummary {
  number: number
  title: string
  url: string
  state: 'open' | 'closed'
  /** Why the issue was closed, or null while it is open or carries no reason. */
  stateReason: IssueStateReason | null
  authorLogin: string
  authorAvatarUrl: string | null
  /** True for app/bot accounts, which GitHub labels with a `Bot` badge. */
  authorIsBot: boolean
  createdAt: string
  updatedAt: string
  /** How many comments the issue has received, as github.com counts them. */
  comments: number
  /** Labels in GitHub's own order. Absent when the payload did not carry them. */
  labels?: IssueLabel[]
  /**
   * Accounts assigned to the issue, in the provider's order. The same shape as a
   * pull request's assignees on purpose: GitHub answers both from the repository's
   * assignable-accounts collection, so one picker renders either.
   */
  assignees?: RepositoryMentionUser[]
  /** The milestone the issue belongs to, or null when it has none. */
  milestone?: IssueMilestone | null
  /**
   * GraphQL global id, when the payload carried one.
   *
   * A listing row never needs it, but a relationship write does: sub-issue and
   * dependency mutations address issues by node id and by nothing else, so a
   * candidate the picker offers has to arrive with one.
   */
  nodeId?: string | null
}

/** One page of issues, with a cursor the UI can advance. */
export interface IssuePage {
  items: IssueSummary[]
  /** The 1-based page this listing answers. */
  page: number
  /** Whether another page exists after this one. */
  hasMore: boolean
  /** Where the next page starts, for providers that page by cursor. */
  nextCursor?: string | null
  /** Actionable repository-access failure returned without rejecting IPC. */
  accessError?: string
  /**
   * A transient transport failure (offline, timeout) returned instead of a
   * rejected IPC call, so the listing holds on to the rows it already had rather
   * than blanking them.
   */
  transientError?: string
}

/**
 * One issue a relationship points at.
 *
 * Leaner than a listing row on purpose: a relationship is drawn as a link with its
 * state and the repository it lives in. GitHub serves these endpoints with the
 * item's own repository attached, and a dependency is allowed to live in a
 * different repository from the issue it relates to, so the repository travels
 * with the item rather than being assumed from the issue being read.
 */
export interface IssueRelationshipItem {
  number: number
  title: string
  url: string
  state: 'open' | 'closed'
  stateReason: IssueStateReason | null
  /** `owner/repo` the item lives in, which is not always this issue's own. */
  repository: string
  /**
   * GraphQL global id, or null when the payload omitted it.
   *
   * Read because a relationship is removable: undoing a link addresses both issues by
   * node id, and an item without one cannot be offered a remove control that works.
   */
  nodeId: string | null
}

/**
 * An issue's relationships, as its own sidebar shows them.
 *
 * Four separate answers held together because the reader draws them as one block:
 * the parent it belongs to, the sub-issues under it, and the issues that block it
 * or that it blocks. Any of them may be empty, which is the common case.
 */
export interface IssueRelationships {
  /** The parent this issue is a sub-issue of, or null when it has none. */
  parent: IssueRelationshipItem | null
  /** Issues filed under this one, in GitHub's own order. */
  subIssues: IssueRelationshipItem[]
  /** Issues that block this one. */
  blockedBy: IssueRelationshipItem[]
  /** Issues this one blocks. */
  blocking: IssueRelationshipItem[]
}

/** Full issue view, loaded when one is opened in the sidebar. */
export interface IssueDetail extends IssueSummary {
  body: string
  /**
   * GraphQL global id of the issue, when the payload carried one. Null for a
   * payload that omitted it, and the description then offers no reaction control
   * rather than one that cannot land.
   */
  nodeId: string | null
  /**
   * What the issue's author is to the repository. The description is a comment
   * like any other in the conversation, so it carries the same role badge its
   * author's comments do.
   */
  authorAssociation: PrAuthorAssociation | null
  /** When the issue was closed, or null while it is open. */
  closedAt: string | null
}

/**
 * One thing that happened to a conversation, as GitHub's timeline reports it.
 *
 * A conversation is only the comments on it; the timeline is everything else, the
 * labels added and taken back, the assignments, the closes and reopens, the
 * renames, and the issues, pull requests and commits that referenced it. Read
 * together they are the history, which is why the reader interleaves them.
 *
 * One shape serves an issue and a pull request. GitHub's timeline endpoint is the
 * same one for both, because a pull request is an issue to the API, and the kinds
 * a pull request adds (`merged`, the review requests, the draft transitions) are
 * simply kinds an issue never reports.
 */
export interface IssueTimelineEvent {
  /** GitHub's own event id, which is what the row is keyed by. */
  id: string
  kind: IssueTimelineEventKind
  /** Who performed it. GitHub reports an account per event, never an absence. */
  actorLogin: string
  actorAvatarUrl: string | null
  /** True for app accounts, so the row can draw GitHub's `Bot` badge. */
  actorIsBot: boolean
  createdAt: string
  /** The label a labeling event carried. Null on every other kind. */
  label?: PullRequestLabel | null
  /** The account an assignment event named, assigned or unassigned alike. */
  assigneeLogin?: string | null
  /** Why a close happened, as the event's own `state_reason` reports it. */
  closeReason?: IssueStateReason | null
  /** The titles a rename moved between. */
  rename?: { from: string; to: string } | null
  /** The milestone a milestone event named, absent when the payload omitted it. */
  milestoneTitle?: string | null
  /** The commit a reference event named, or the merge commit a merge named. */
  commitId?: string | null
  /** What a cross-reference pointed at, in this repository or another. */
  reference?: IssueTimelineReference | null
  /**
   * The account a review request named.
   *
   * Null when the request named a team instead, and null on every other kind, so
   * a row that has no name to show says what happened without inventing one.
   */
  reviewerLogin?: string | null
  /** The team a review request named, when it named one rather than an account. */
  reviewerTeamName?: string | null
  /** GitHub's word for why a conversation was locked, when it carried one. */
  lockReason?: string | null
}

/**
 * The subject a cross-reference event names.
 *
 * Carries the full repository rather than assuming the issue's own, because a
 * reference from another repository is the common case: GitHub's timeline reports
 * a link from anywhere, and an app that dropped the owner would mislabel it.
 */
export interface IssueTimelineReference {
  url: string
  number: number
  title: string
  /** `owner/repo` the reference lives in, to tell a cross-repository link apart. */
  repository: string
  /** True when the reference is a pull request rather than an issue. */
  isPullRequest: boolean
}

/**
 * What a timeline event is, for the reader that turns it into a sentence.
 *
 * A curated set rather than GitHub's whole vocabulary: these are the events
 * github.com itself renders, each one a state change a reader can be told about.
 * The events it hides (`subscribed`, `mentioned`) are left out so the history
 * reads as the conversation's own story instead of as a notification log, and so
 * are the ones another part of the reader already draws (`commented` on the
 * comments, `reviewed` on the reviews, `committed` on the Commits tab).
 */
export type IssueTimelineEventKind =
  | 'labeled'
  | 'unlabeled'
  | 'assigned'
  | 'unassigned'
  | 'closed'
  | 'reopened'
  | 'renamed'
  | 'milestoned'
  | 'demilestoned'
  | 'locked'
  | 'unlocked'
  | 'pinned'
  | 'unpinned'
  | 'referenced'
  | 'cross-referenced'
  | 'marked_as_duplicate'
  | 'connected'
  /** A change to the issue's own custom fields, which GitHub reports opaquely. */
  | 'fields'
  /** A pull request's merge, which carries the merge commit. */
  | 'merged'
  | 'review_requested'
  | 'review_request_removed'
  | 'ready_for_review'
  | 'converted_to_draft'
  | 'head_ref_deleted'

/** Everything the issue detail view renders, fetched in one round trip. */
export interface IssueBundle {
  detail: IssueDetail
  comments: IssueComment[]
  /**
   * Reactions on the issue and its comments, keyed by the node id of the subject
   * they are on. Empty when the read could not be made: the conversation is worth
   * showing even when its reactions are not.
   */
  reactions: PrReactionMap
  /** Epoch ms this bundle was fetched, for cache staleness display. */
  fetchedAt: number
}

/**
 * What an add or remove on the relationship block is about.
 *
 * The four are the same set the picker offers, and each names the relationship rather
 * than the direction, because the direction is derivable: the issue the reader has
 * open holds one side and the item holds the other, and which one differs per mode.
 * Keeping the mode in the protocol means the caller does not have to re-decide it from
 * the group it was rendered in.
 */
export type IssueRelationshipMode = 'sub-issue' | 'parent' | 'blocked-by' | 'blocking'

/** A new issue as the renderer asks for one; owner/repo resolve from the origin. */
export interface NewIssueInput {
  title: string
  body?: string
  labels?: string[]
  assignees?: string[]
}

/** The fields a caller may rewrite on an existing issue. */
export interface IssueUpdateInput {
  title?: string
  body?: string
}

/**
 * What an agent assignment was asked to work on.
 *
 * The kind is what the reader uses to decide which controls a report card offers:
 * a comment assignment can point back at its comment, and a check assignment
 * points at the check instead.
 */
export type PrAgentAssignmentKind = 'triage' | 'comment' | 'check'

/**
 * One agent assignment's report, read back from `.cio/git/pr/<number>/`.
 *
 * An assignment is one thread with one report file, so a pull request can hold
 * several at once: a triage, then one for each comment or failed check handed to
 * an agent. Each keeps its own `review-<id>.md`, which is what stops a second
 * assignment from overwriting the first.
 */
export interface PrAgentReport {
  /** Identity of the assignment, and the `<id>` in `review-<id>.md`. */
  id: string
  kind: PrAgentAssignmentKind
  /** What the assignment addressed, e.g. `Triage` or `Comment by @dependabot`. */
  title: string
  /** Absolute path to the report file. */
  path: string
  content: string
  /** Epoch ms of the last write, or null when no report exists yet. */
  updatedAt: number | null
  /** Epoch ms the assignment was made, so the list can order and label it. */
  createdAt: number | null
  /** Thread the assignment was handed to, so the UI can jump back into it. */
  threadId: string | null
  /**
   * The provider page the assignment was opened from: the comment for a comment
   * assignment, the check for a check assignment, and null for a triage.
   */
  url: string | null
}

/**
 * What the list needs to draw one row's assignment chip.
 *
 * Deliberately a count and the newest assignment rather than the reports
 * themselves: a page of rows wants to know whether an agent is on a pull request
 * and how to get back to it, not the text of every report ever written.
 */
export interface PrAgentAssignmentSummary {
  /** How many assignments the pull request holds. */
  count: number
  /** Newest assignment's thread, for a jump back into it. */
  threadId: string | null
  /** Newest assignment's title. */
  title: string
  /** Epoch ms the newest assignment was made. */
  createdAt: number | null
}

/** What an agent assignment is asked to do when it is created. */
export interface PrAgentAssignmentInput {
  kind: PrAgentAssignmentKind
  /** What the assignment addresses, shown in the report list. */
  title: string
  /** Provider page the assignment was opened from, when there is one. */
  url?: string
}

/**
 * A created assignment's files, so the caller can name the report path in the
 * brief it hands the agent. The path is composed in the main process: the
 * renderer never builds a filesystem path of its own.
 */
export interface PrAgentAssignmentWorkspace {
  /** Identity of the assignment, and the `<id>` in `review-<id>.md`. */
  id: string
  /** The pull request's report directory. */
  directory: string
  /** Absolute path of the report the agent should write. */
  reportPath: string
}

/** An agent-composed PR title/description produced by a disposable virtual task. */
export interface PrComposeReport {
  title: string
  description: string
  /** Disposable task that produced the report; it is not a persisted Thread id. */
  taskId: string
}

/**
 * What one disposable PR-compose task produced.
 *
 * A compose failure is an expected outcome, not an exception. The agent runs on
 * a harness the user picked, and that harness can be missing, unauthenticated,
 * rate-limited, or unable to start at all. Returning the failure as a value
 * keeps it inside the app's provider-issue vocabulary, so the sheet can render
 * the same title and actions every other harness failure gets instead of a
 * thrown string that names nothing the user can do.
 */
export type PrComposeOutcome =
  { status: 'completed'; report: PrComposeReport } | { status: 'failed'; issue: AgentProviderIssue }

/** Branch selection and optional existing copy for one isolated PR composition. */
export interface PrComposeInput {
  base: string
  head: string
  /** Remote uses cached origin refs only; local also includes unpushed commits and worktree changes. */
  source: 'remote' | 'local'
  includeWorkingTree: boolean
  currentTitle?: string
  currentDescription?: string
}

/** Repository identity resolved from a remote URL (e.g. `owner/repo`). */
export interface GitRepositoryIdentity {
  owner: string
  repo: string
}

/** Result of a provider credential status query   presence only, never plaintext. */
export interface GitCredentialStatus {
  configured: boolean
  secureStorageAvailable: boolean
}

/** Device-code request payload returned by the GitHub device flow. */
export interface GitHubDeviceCode {
  deviceCode: string
  userCode: string
  verificationUri: string
  expiresIn: number
  interval: number
}

/** Result of one poll of the GitHub device flow token endpoint. */
export type GitHubPollResult =
  | { status: 'pending' }
  | { status: 'authorized' }
  | { status: 'expired' }
  | { status: 'error'; message: string }

/** Presence-only status of the GitHub OAuth connection. Never carries plaintext. */
export interface GitHubAuthStatus {
  connected: boolean
  /** Whether the app has a GitHub App client ID configured to sign in with. */
  configured: boolean
  /** Public profile of the signed-in user, when connected. */
  user?: GitHubUser | null
}

/** Public GitHub user profile, safe to surface in the UI. */
export interface GitHubUser {
  login: string
  name: string | null
  /**
   * Avatar as a `data:` URL   the renderer's CSP blocks remote image hosts, so
   * the main process downloads and inlines it. Null when the download failed;
   * the UI falls back to the GitHub mark.
   */
  avatarUrl: string | null
}

/** One recent GitHub Actions workflow run shown in deployment monitoring. */
export interface GitHubWorkflowRun {
  id: number
  name: string
  displayTitle: string
  runNumber: number
  event: string
  status: 'queued' | 'in_progress' | 'completed' | 'unknown'
  conclusion: string | null
  branch: string
  headSha: string
  url: string
  actorLogin: string
  createdAt: string
  updatedAt: string
}

/** Latest status recorded for one GitHub deployment. */
export interface GitHubDeploymentStatus {
  state: string
  description: string
  environmentUrl: string | null
  logUrl: string | null
  createdAt: string
}

/** One recent GitHub deployment and its latest status. */
export interface GitHubDeployment {
  id: number
  environment: string
  description: string
  ref: string
  sha: string
  createdAt: string
  updatedAt: string
  latestStatus: GitHubDeploymentStatus | null
}

/** Read-only GitHub Actions and Deployments snapshot for a repository. */
export interface GitHubDeploymentOverview {
  workflowRuns: GitHubWorkflowRun[]
  deployments: GitHubDeployment[]
  fetchedAt: number
}

/**
 * `deployment:overview` IPC result. `hasDeployments` is derived from the
 * snapshot and drives whether the Deployments tab is shown at all.
 */
export interface GitHubDeploymentOverviewResult extends GitHubDeploymentOverview {
  hasDeployments: boolean
  /** Actionable repository-access failure returned without rejecting IPC. */
  accessError?: string
}

/** One step inside a workflow run job   the granular "why did it fail" data. */
export interface GitHubDeploymentJobStep {
  number: number
  name: string
  status: 'queued' | 'in_progress' | 'completed' | 'unknown'
  conclusion: string | null
}

/** One workflow run job, with its step-level breakdown. */
export interface GitHubDeploymentJob {
  id: number
  name: string
  status: string
  conclusion: string | null
  startedAt: string
  completedAt: string | null
  url: string
  steps: GitHubDeploymentJobStep[]
}

/** Everything the in-app deployment detail view needs. */
export interface GitHubDeploymentDetail {
  deployment: GitHubDeployment
  statuses: GitHubDeploymentStatus[]
  workflowRun: GitHubWorkflowRun | null
  jobs: GitHubDeploymentJob[]
  fetchedAt: number
}

/**
 * Raw log text for one workflow run job, capped at roughly 200 KB. An oversized log
 * keeps its head and its tail with an omission line between them, because the step
 * that failed is at the end.
 */
export interface GitHubDeploymentJobLog {
  jobId: number
  log: string
  truncated: boolean
}

/** Everything the in-app workflow-run detail view needs. */
export interface GitHubWorkflowRunDetail {
  run: GitHubWorkflowRun
  jobs: GitHubDeploymentJob[]
  fetchedAt: number
}

/**
 * Which jobs a workflow re-run replays. GitHub offers exactly these two: every
 * job in the run, or only the ones that failed.
 */
export type WorkflowRerunMode = 'all' | 'failed'

/** A workflow re-run answers with an empty body, so the result carries no value. */
export type WorkflowRerunResult = GitHubMutationResult<null>

/**
 * A workflow-run cancel answers with an empty body, so the result carries no
 * value. GitHub has no per-job cancel endpoint: a job is skipped by cancelling
 * the run that owns it.
 */
export type WorkflowCancelResult = GitHubMutationResult<null>

/**
 * Which of GitHub's notification views a listing reads.
 *
 * `inbox` is served live by the REST API. `saved` and `done` have no REST
 * endpoint: GitHub exposes no way to list archived ("done") threads, and its
 * "Saved" view is not reachable from the public API at all, so those two views
 * are owned by the app, which persists a snapshot of each thread the user saves
 * or marks done. The real action still goes to GitHub (a done marks the thread
 * read and removes it from the inbox), so the two stay in step.
 */
export type GitHubNotificationTab = 'inbox' | 'saved' | 'done'

/**
 * The filters GitHub's own notification list offers.
 *
 * GitHub's REST listing accepts only `all` and `participating` as query
 * parameters; every other filter narrows on the `reason` field of each returned
 * thread. That is exactly how github.com maps its filters onto reasons, so the
 * membership sets below are read straight off the reason table in the docs.
 */
export type GitHubNotificationFilter =
  | 'default'
  | 'all'
  | 'assigned'
  | 'participating'
  | 'mentioned'
  | 'team-mentioned'
  | 'review-requested'
  | 'security'
  | 'ci'

/** The order a notification listing is drawn in. */
export type GitHubNotificationSort = 'newest' | 'oldest'

/** How a notification listing is grouped into sections. */
export type GitHubNotificationGroup = 'date' | 'repository'

/** One GitHub notification thread, flattened for the panel. */
export interface GitHubNotification {
  /** Thread id, as a decimal string. */
  id: string
  /** Whether the thread is still unread on GitHub. */
  unread: boolean
  /** GitHub's `reason` string (`assign`, `mention`, `review_requested`, …). */
  reason: string
  /** When the thread last changed, ISO 8601. */
  updatedAt: string
  /** Subject kind, e.g. `PullRequest`, `Issue`, `Discussion`, `Commit`, `Release`. */
  subjectType: string
  /** Subject title as GitHub reports it. */
  title: string
  /** Browsable github.com URL for the subject, when one can be derived. */
  url: string | null
  repositoryName: string
  repositoryFullName: string
  repositoryUrl: string
  repositoryPrivate: boolean
  actorLogin: string | null
  /** True when the user saved this thread in the app. */
  saved: boolean
  /** True when the user marked this thread done in the app. */
  done: boolean
}

/** Per-view counts drawn on the panel's tabs. */
export interface GitHubNotificationTabCounts {
  /**
   * Unread threads in the listing GitHub just returned. GitHub exposes no
   * total-count endpoint for notifications, so this is the count of what was
   * fetched, never an invented total.
   */
  inbox: number
  /** Saved threads the app holds. */
  saved: number
  /** Done threads the app holds. */
  done: number
}

/** One page of a notification listing, as the renderer receives it. */
export interface GitHubNotificationPage {
  items: GitHubNotification[]
  /** Whether another page of the same query exists. */
  hasMore: boolean
  counts: GitHubNotificationTabCounts
}

/**
 * A notification listing, or the account-token state that prevents one.
 *
 * GitHub serves the notifications API only to a classic personal access token:
 * its REST description marks every notification endpoint `enabledForGitHubApps:
 * false`, and the reference says outright that these endpoints "do not work with
 * GitHub App user access tokens". The app signs in with a GitHub App, so no
 * GitHub sign-in can ever read this listing; it runs instead on a token the user
 * connects for it and the vault holds. When no such token is on file, or GitHub
 * refuses the one that is, that is reported as data the panel can act on rather
 * than as a bare error it can only repeat.
 */
export type GitHubNotificationPageResult = GitHubNotificationPage | GitHubNotificationTokenRequired

/** The listing could not run because no usable notification token is on file. */
export interface GitHubNotificationTokenRequired {
  status: 'token_required'
  /** One sentence naming what is missing, in the panel's own words. */
  message: string
  /** Where the user creates the classic token that carries the scope. */
  createTokenUrl: string
}

/** The vaulted notification token, as the panel shows it. */
export interface GitHubNotificationTokenStatus {
  connected: boolean
  /** The account the token belongs to, when one is connected. */
  login: string | null
  /** The scopes GitHub reports for the token, or null when it reports none. */
  scopes: string[] | null
  /** Whether those scopes are allowed to read the notifications API. */
  canReadNotifications: boolean
  /** Where the user creates a token this view can use. */
  createTokenUrl: string
}

/** A notification listing request. */
export interface GitHubNotificationPageInput {
  tab: GitHubNotificationTab
  filter: GitHubNotificationFilter
  /** 1-based page number. */
  page: number
  /** Items per page; the provider caps this. */
  perPage: number
}
