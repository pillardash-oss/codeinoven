import { Check, CircleDot, CircleSlash, X } from '@lucide/svelte'
import type { PullRequestBundle, PullRequestCheck } from '$shared/types'

export type ConversationEntryKind = 'description' | 'comment' | 'review' | 'inline'

export interface ConversationEntry {
  key: string
  author: string
  at: string
  body: string
  kind: ConversationEntryKind
  meta?: string
}

/**
 * Conversation as one chronological stream: the PR description, issue
 * comments, submitted reviews, and inline code comments, the same context
 * GitHub shows, so a merge decision never needs the browser.
 */
export function buildConversation(bundle: PullRequestBundle | undefined): ConversationEntry[] {
  if (!bundle) return []
  const entries: ConversationEntry[] = []
  if (bundle.detail.body.trim()) {
    entries.push({
      key: 'body',
      author: bundle.detail.authorLogin,
      at: bundle.detail.createdAt,
      body: bundle.detail.body,
      kind: 'description'
    })
  }
  for (const comment of bundle.comments) {
    entries.push({
      key: `c${comment.id}`,
      author: comment.authorLogin,
      at: comment.createdAt,
      body: comment.body,
      kind: 'comment'
    })
  }
  for (const review of bundle.reviews) {
    entries.push({
      key: `r${review.id}`,
      author: review.authorLogin,
      at: review.submittedAt,
      body: review.body,
      kind: 'review',
      meta: review.state.replace(/_/gu, ' ').toLowerCase()
    })
  }
  for (const comment of bundle.reviewComments) {
    entries.push({
      key: `rc${comment.id}`,
      author: comment.authorLogin,
      at: comment.createdAt,
      body: comment.body,
      kind: 'inline',
      meta: comment.line === null ? comment.path : `${comment.path}:${comment.line}`
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
