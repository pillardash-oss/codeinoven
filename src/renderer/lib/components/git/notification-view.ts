/**
 * Vocabulary shared by the Git panel's notification list and the reader under
 * it: the reason labels, the subject glyphs, the section headings, and the state
 * pills.
 *
 * Kept out of the components for the same reason `issue-view.ts` and `pr-view.ts`
 * are: the list and the reader both draw these, and a label that exists in one
 * and not the other is exactly the drift this module prevents.
 */

import CioCommit from '@pillardash-oss/cio-icon/CioCommit.svelte'
import CioDot from '@pillardash-oss/cio-icon/CioDot.svelte'
import CioMessage from '@pillardash-oss/cio-icon/CioMessage.svelte'
import CioNotifications from '@pillardash-oss/cio-icon/CioNotifications.svelte'
import CioPullRequest from '@pillardash-oss/cio-icon/CioPullRequest.svelte'
import CioTag from '@pillardash-oss/cio-icon/CioTag.svelte'
import type { GitHubNotification, IssueSummary, PullRequestSummary } from '$shared/types'

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
export function subjectIcon(type: string): typeof CioDot {
  if (type === 'PullRequest') return CioPullRequest
  if (type === 'Issue') return CioDot
  if (type === 'Discussion') return CioMessage
  if (type === 'Commit') return CioCommit
  if (type === 'Release') return CioTag
  return CioNotifications
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

/**
 * The thread a notification points at, when the panel already reads that kind.
 *
 * A notification names its subject and nothing else: the repository it lives in,
 * the kind, and a github.com URL whose last segment is the thread's number. Those
 * three are what the panel's own pull request and issue readers address a thread
 * by, so a notification that carries them opens the reader that already exists
 * rather than a surface built for notifications alone.
 */
export interface NotificationTarget {
  kind: 'pull-request' | 'issue'
  owner: string
  repo: string
  number: number
}

/**
 * What a notification points at, or null for a kind the panel has no reader for.
 *
 * Commits, releases, discussions and the alert kinds are all null: the panel's
 * commit reader reads a commit of the repository it is standing in, and GitHub
 * serves no REST thread for the rest, so those stay the notification's own facts
 * with the thread one click away.
 */
export function notificationTargetFor(item: GitHubNotification): NotificationTarget | null {
  if (item.subjectType !== 'PullRequest' && item.subjectType !== 'Issue') return null
  const [owner, repo] = item.repositoryFullName.split('/')
  if (!owner || !repo) return null
  const number = threadNumber(item.url)
  if (number === null) return null
  return {
    kind: item.subjectType === 'PullRequest' ? 'pull-request' : 'issue',
    owner,
    repo,
    number
  }
}

/** The thread's number, taken from the tail of its github.com URL. */
function threadNumber(url: string | null): number | null {
  if (!url) return null
  const match = /\/(?:pull|issues)\/(\d+)(?:$|[/?#])/u.exec(url)
  if (!match?.[1]) return null
  const value = Number(match[1])
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

/** The thread's github.com address, for a notification whose payload carried none. */
function threadUrl(target: NotificationTarget): string {
  const segment = target.kind === 'pull-request' ? 'pull' : 'issues'
  return `https://github.com/${target.owner}/${target.repo}/${segment}/${String(target.number)}`
}

/**
 * A pull request summary built from the notification alone.
 *
 * The notification says which thread it is and nothing about its state, so
 * everything the reader draws from the summary until its bundle lands is the
 * neutral value, and the detail overrides each of them as soon as GitHub answers.
 */
export function notificationPullRequestSummary(
  item: GitHubNotification,
  target: NotificationTarget
): PullRequestSummary {
  return {
    number: target.number,
    title: item.title,
    url: item.url ?? threadUrl(target),
    state: 'open',
    draft: false,
    authorLogin: item.actorLogin ?? '',
    headRef: '',
    baseRef: '',
    createdAt: item.updatedAt,
    updatedAt: item.updatedAt,
    comments: 0
  }
}

/** An issue summary built from the notification alone, on the same terms. */
export function notificationIssueSummary(
  item: GitHubNotification,
  target: NotificationTarget
): IssueSummary {
  return {
    number: target.number,
    title: item.title,
    url: item.url ?? threadUrl(target),
    state: 'open',
    stateReason: null,
    authorLogin: item.actorLogin ?? '',
    authorAvatarUrl: null,
    authorIsBot: false,
    createdAt: item.updatedAt,
    updatedAt: item.updatedAt,
    comments: 0
  }
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
