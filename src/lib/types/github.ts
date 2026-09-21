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

/** One issue comment on a pull request. */
export interface PullRequestComment {
  id: number
  authorLogin: string
  /** Provider-declared picture, preferred over the login-derived guess. */
  authorAvatarUrl: string | null
  /** True for app/bot accounts, so the row can draw GitHub's `Bot` badge. */
  authorIsBot: boolean
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
  files: PullRequestFile[]
  checks: PullRequestChecks
  /** Epoch ms this bundle was fetched, for cache staleness display. */
  fetchedAt: number
}

/** An agent's review report read back from `.cio/git/pr/<number>/review.md`. */
export interface PrAgentReport {
  /** Absolute path to the report file. */
  path: string
  content: string
  /** Epoch ms of the last write, or null when no report exists yet. */
  updatedAt: number | null
  /** Thread the review was handed to, so the UI can jump back into it. */
  threadId: string | null
}

/** An agent-composed PR title/description produced by a disposable virtual task. */
export interface PrComposeReport {
  title: string
  description: string
  /** Disposable task that produced the report; it is not a persisted Thread id. */
  taskId: string
}

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
