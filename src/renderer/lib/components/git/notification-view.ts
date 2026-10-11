/**
 * Vocabulary shared by the Git panel's notification list and the reader under
 * it: the reason labels, the subject glyphs, the section headings, and the state
 * pills.
 *
 * Kept out of the components for the same reason `issue-view.ts` and `pr-view.ts`
 * are: the list and the reader both draw these, and a label that exists in one
 * and not the other is exactly the drift this module prevents.
 */
import {
  Bell,
  CircleDot,
  GitCommitHorizontal,
  GitPullRequest,
  MessageSquare,
  Tag
} from '@lucide/svelte'

/**
 * GitHub's `reason` codes as words, matching github.com's own labels.
 *
 * The listing menu's filters are a separate vocabulary: those are search-like
 * group names, while a reason is what GitHub says about one thread.
 */
const REASON_LABELS: Record<string, string> = {
  assign: 'Assigned',
  author: 'Author',
  ci_activity: 'CI activity',
  comment: 'Comment',
  invitation: 'Invitation',
  manual: 'Subscribed',
  mention: 'Mention',
  review_requested: 'Review requested',
  security_alert: 'Security alert',
  state_change: 'State change',
  subscribed: 'Watching',
  team_mention: 'Team mention',
  approval_requested: 'Approval requested'
}

/** A thread's reason, as a word. Unknown codes fall back to their own spelling. */
export function reasonLabel(reason: string): string {
  return REASON_LABELS[reason] ?? reason.replace(/_/gu, ' ')
}

/**
 * The glyph a notification's subject kind draws with, so a row reads at a glance
 * what it addresses instead of what it says.
 */
export function subjectIcon(type: string): typeof CircleDot {
  if (type === 'PullRequest') return GitPullRequest
  if (type === 'Issue') return CircleDot
  if (type === 'Discussion') return MessageSquare
  if (type === 'Commit') return GitCommitHorizontal
  if (type === 'Release') return Tag
  return Bell
}

/** A subject kind as a word, for the reader's header. */
export function subjectKindLabel(type: string): string {
  if (type === 'PullRequest') return 'Pull request'
  if (type === 'Issue') return 'Issue'
  if (type === 'Discussion') return 'Discussion'
  if (type === 'Commit') return 'Commit'
  if (type === 'Release') return 'Release'
  return type
}

/**
 * A subject's state as a word and the tone it is drawn in.
 *
 * `draft` and `merged` are pull request states GitHub reports instead of open or
 * closed, and they are the two a reader most needs told apart, so they are named
 * rather than folded into "open" and "closed".
 */
export function subjectStateLabel(state: string): string {
  if (state === 'draft') return 'Draft'
  if (state === 'merged') return 'Merged'
  if (state === 'closed') return 'Closed'
  return 'Open'
}

/** The pill class for a subject's state, in the same tones the other readers use. */
export function subjectStateToneClass(state: string | null): string {
  if (state === 'merged') return 'bg-accent/15 text-accent'
  if (state === 'closed') return 'bg-danger/15 text-danger'
  if (state === 'draft') return 'bg-elevated text-muted'
  return 'bg-success/15 text-success'
}

/** The date sections, in the order the list stacks them: newest bucket first. */
export const NOTIFICATION_DATE_ORDER = [
  'Today',
  'Yesterday',
  'This week',
  'This month',
  'Earlier'
] as const

/** The section a thread falls in under date grouping. */
export function notificationDateGroup(updatedAt: string): string {
  const timestamp = Date.parse(updatedAt)
  if (!Number.isFinite(timestamp)) return 'Earlier'
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const day = 86_400_000
  if (timestamp >= startOfToday) return 'Today'
  if (timestamp >= startOfToday - day) return 'Yesterday'
  if (timestamp >= startOfToday - 7 * day) return 'This week'
  if (timestamp >= startOfToday - 30 * day) return 'This month'
  return 'Earlier'
}
