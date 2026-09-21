import { Check, CircleDot, CircleSlash, X } from '@lucide/svelte'
import type { PrCommentKind, PullRequestBundle, PullRequestCheck } from '$shared/types'
import { githubDisplayLogin } from '$lib/format/github-login'

export type ConversationEntryKind = 'description' | 'comment' | 'review' | 'inline'

/**
 * One row of the conversation, with everything its actions need already
 * resolved from whichever provider shape it came from.
 */
export interface ConversationEntry {
  key: string
  author: string
  /** The author's picture as the provider declared it, preferred over the login. */
  avatarUrl: string | null
  /** True for app accounts, which GitHub labels with a `Bot` badge. */
  isBot: boolean
  at: string
  /** Last edit time, or null when the entry has never been edited. */
  updatedAt: string | null
  body: string
  kind: ConversationEntryKind
  meta?: string
  /**
   * The unified diff hunk GitHub showed when an inline comment was written, or
   * null for every other entry. It is the code the comment is talking about,
   * and unlike the live file it still shows that code after the line has gone
   * outdated, which is exactly when a reader needs it.
   */
  diffHunk: string | null
  /** Permalink GitHub itself uses for this exact entry. */
  url: string
  /**
   * Provider id of the comment, or null for the description.
   *
   * The description is not a comment: it is a field on the pull request, so it
   * is edited through the pull request update instead of a comment endpoint, and
   * GitHub offers no delete or hide for it at all. Null is what a row reads to
   * know which of the two it is, rather than a flag that could disagree.
   */
  commentId: number | null
  /** Which collection `commentId` lives in. Meaningless when it is null. */
  commentKind: PrCommentKind
  /** GraphQL id, the only handle GitHub's minimise mutation accepts. */
  nodeId: string | null
}

/**
 * Conversation as one chronological stream: the PR description, issue
 * comments, submitted reviews, and inline code comments, the same context
 * GitHub shows, so a merge decision never needs the browser.
 *
 * Each entry also carries everything the per-comment actions need: the
 * provider's own permalink, the id and collection a mutation addresses, the
 * GraphQL node id hiding needs, and the author's declared picture. Assembling
 * that here means the menu and the row read one shape instead of each of them
 * reaching back into the bundle and guessing which provider field applies.
 */
export function buildConversation(bundle: PullRequestBundle | undefined): ConversationEntry[] {
  if (!bundle) return []
  const entries: ConversationEntry[] = []
  if (bundle.detail.body.trim()) {
    entries.push({
      key: 'body',
      author: bundle.detail.authorLogin,
      avatarUrl: bundle.detail.authorAvatarUrl ?? null,
      isBot: bundle.detail.authorIsBot === true,
      at: bundle.detail.createdAt,
      updatedAt: null,
      body: bundle.detail.body,
      kind: 'description',
      url: bundle.detail.url,
      diffHunk: null,
      commentId: null,
      commentKind: 'issue',
      nodeId: null
    })
  }
  for (const comment of bundle.comments) {
    entries.push({
      key: `c${comment.id}`,
      author: comment.authorLogin,
      avatarUrl: comment.authorAvatarUrl,
      isBot: comment.authorIsBot,
      at: comment.createdAt,
      updatedAt: comment.updatedAt,
      body: comment.body,
      kind: 'comment',
      url: comment.url,
      diffHunk: null,
      commentId: comment.id,
      commentKind: 'issue',
      nodeId: comment.nodeId
    })
  }
  for (const review of bundle.reviews) {
    entries.push({
      key: `r${review.id}`,
      author: review.authorLogin,
      avatarUrl: review.authorAvatarUrl,
      isBot: review.authorIsBot,
      at: review.submittedAt,
      updatedAt: null,
      body: review.body,
      kind: 'review',
      meta: review.state.replace(/_/gu, ' ').toLowerCase(),
      url: review.url,
      diffHunk: null,
      commentId: null,
      commentKind: 'issue',
      nodeId: review.nodeId
    })
  }
  for (const comment of bundle.reviewComments) {
    entries.push({
      key: `rc${comment.id}`,
      author: comment.authorLogin,
      avatarUrl: comment.authorAvatarUrl,
      isBot: comment.authorIsBot,
      at: comment.createdAt,
      updatedAt: comment.updatedAt,
      body: comment.body,
      kind: 'inline',
      meta: comment.line === null ? comment.path : `${comment.path}:${comment.line}`,
      url: comment.url,
      diffHunk: comment.diffHunk,
      commentId: comment.id,
      commentKind: 'review',
      nodeId: comment.nodeId
    })
  }
  return entries
    .filter((entry) => entry.body.trim() || entry.kind === 'review')
    .sort((a, b) => Date.parse(a.at || '0') - Date.parse(b.at || '0'))
}

/** Human label for a conversation entry's badge. */
export function conversationKindLabel(kind: ConversationEntryKind, meta?: string): string {
  if (kind === 'description') return 'description'
  if (kind === 'inline') return 'inline review'
  if (kind === 'review') return meta ?? 'review'
  return 'comment'
}

/** Badge colour, approvals and change requests read at a glance. */
export function conversationKindClass(kind: ConversationEntryKind, meta?: string): string {
  if (kind === 'review' && meta === 'approved') return 'bg-success/10 text-success'
  if (kind === 'review' && meta === 'changes requested') return 'bg-warning/10 text-warning'
  if (kind === 'description') return 'bg-primary/10 text-primary'
  return 'bg-elevated text-dimmed'
}

/** Matching left edge on the card so the stream scans vertically. */
export function conversationAccentClass(kind: ConversationEntryKind, meta?: string): string {
  if (kind === 'review' && meta === 'approved') return 'border-l-2 border-l-success'
  if (kind === 'review' && meta === 'changes requested') return 'border-l-2 border-l-warning'
  if (kind === 'description') return 'border-l-2 border-l-primary'
  return ''
}

/**
 * Whether the viewer may rewrite this entry.
 *
 * GitHub gives a comment body to its author and the description to the pull
 * request's author, and nothing else. A submitted review is never editable, so
 * it stays excluded however the logins compare.
 */
export function canEditConversationEntry(
  entry: ConversationEntry,
  viewerLogin: string | null,
  pullAuthorLogin: string
): boolean {
  if (entry.kind === 'review') return false
  return entry.commentId === null ? viewerLogin === pullAuthorLogin : viewerLogin === entry.author
}

/** GitHub allows deleting a comment you wrote, and never a description. */
export function canDeleteConversationEntry(
  entry: ConversationEntry,
  viewerLogin: string | null
): boolean {
  return entry.commentId !== null && viewerLogin === entry.author
}

/** Hiding needs a node id, which a description does not expose here. */
export function canHideConversationEntry(entry: ConversationEntry): boolean {
  return entry.nodeId !== null
}

/** The quote-reply block GitHub builds from a comment's body. */
export function conversationQuoteBlock(entry: ConversationEntry): string {
  const quoted = entry.body
    .trim()
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
  // The attribution is a mention, so it takes the display login: an app account's
  // raw `name[bot]` would put GitHub's suffix where the handle belongs, and square
  // brackets are markdown link syntax.
  return `> **@${githubDisplayLogin(entry.author)}** wrote:\n>\n${quoted}\n\n`
}

export function checkIcon(check: PullRequestCheck): typeof Check {
  if (check.status !== 'completed') return CircleDot
  if (check.conclusion === 'success') return Check
  if (check.conclusion === 'skipped' || check.conclusion === 'neutral') return CircleSlash
  return X
}

export function checkClass(check: PullRequestCheck): string {
  if (check.status !== 'completed') return 'text-warning'
  if (check.conclusion === 'success') return 'text-success'
  if (check.conclusion === 'skipped' || check.conclusion === 'neutral') return 'text-dimmed'
  return 'text-danger'
}

/**
 * A check that finished without succeeding, which is the only kind a re-run can
 * help. Shares its branch shape with `checkClass`, which paints the same set
 * red, but answers a different question: "can a re-run fix this?"
 */
export function checkFailed(check: PullRequestCheck): boolean {
  if (check.status !== 'completed') return false
  return (
    check.conclusion !== 'success' &&
    check.conclusion !== 'skipped' &&
    check.conclusion !== 'neutral'
  )
}

/** Stable key for one check row, shared by the list key and the log cache. */
export function checkKey(check: PullRequestCheck): string {
  return check.name + (check.url ?? '')
}

/** Human wording for a check's progress, so `in_progress` is not shown raw. */
export function checkStateLabel(check: PullRequestCheck): string {
  if (check.status !== 'completed') return check.status.replace('_', ' ')
  return check.conclusion ?? 'done'
}

/** Colorize a unified patch the way the rest of the app renders diffs. */
export function patchLineClass(line: string): string {
  if (line.startsWith('@@')) return 'text-primary'
  if (line.startsWith('+')) return 'bg-success/10 text-success'
  if (line.startsWith('-')) return 'bg-danger/10 text-danger'
  return 'text-muted'
}

/** Name the two failures a reader can actually act on, then quote the rest. */
export function checkLogMessage(reason: unknown): string {
  const text = reason instanceof Error ? reason.message : ''
  if (/HTTP 404/u.test(text)) return 'This job has not published a log yet.'
  if (/HTTP (401|403)/u.test(text)) return 'Your GitHub access cannot read this job log.'
  return text || 'The log could not be loaded.'
}
