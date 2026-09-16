/**
 * Vocabulary shared by the two surfaces that read the same pull request: the Git
 * panel's action row and the detail reader underneath it. The panel draws the
 * state pills, the check pill and the view switcher in its own rows now, so
 * neither the badge classes nor the view list can live inside the reader.
 */
import { Bot, FileDiff, GitCommitHorizontal, MessagesSquare, ShieldCheck } from '@lucide/svelte'
import type { PullRequestBundle } from '$shared/types'

/** The views the pull request detail reader switches between. */
export type PrDetailTabId = 'conversation' | 'commits' | 'files' | 'checks' | 'agent'

/**
 * The reader's views, in the order both surfaces list them. The panel's switcher
 * and the reader's rail both draw from this, so a view cannot exist in one and be
 * missing from the other.
 */
export const PR_DETAIL_VIEWS: Array<{
  id: PrDetailTabId
  label: string
  icon: typeof Bot
}> = [
  { id: 'conversation', label: 'Conversation', icon: MessagesSquare },
  { id: 'commits', label: 'Commits', icon: GitCommitHorizontal },
  { id: 'files', label: 'Files', icon: FileDiff },
  { id: 'checks', label: 'Checks', icon: ShieldCheck },
  { id: 'agent', label: 'Agent', icon: Bot }
]

/**
 * How many entries a view holds, for the switcher's counts. The conversation
 * count mirrors the reader's own stream: a description, a comment or an inline
 * note counts once it has something to read, and a review always counts, since a
 * bare approval is still part of the conversation.
 */
export function prViewCount(
  view: PrDetailTabId,
  bundle: PullRequestBundle | null | undefined,
  hasAgentReport: boolean
): number {
  if (!bundle) return 0
  if (view === 'commits') return bundle.commits.length
  if (view === 'files') return bundle.files.length
  if (view === 'checks') return bundle.checks.checks.length
  if (view === 'agent') return hasAgentReport ? 1 : 0
  return (
    (bundle.detail.body.trim() ? 1 : 0) +
    bundle.comments.filter((comment) => comment.body.trim()).length +
    bundle.reviews.length +
    bundle.reviewComments.filter((comment) => comment.body.trim()).length
  )
}

/** Badge colour for a pull request's state pill. */
export function prStateBadgeClass(state: string): string {
  if (state === 'merged') return 'bg-primary/10 text-primary'
  if (state === 'closed') return 'bg-danger/10 text-danger'
  return 'bg-success/10 text-success'
}

/** Badge colour for the rolled-up check state pill. */
export function prChecksBadgeClass(state: string): string {
  if (state === 'failure') return 'bg-danger/10 text-danger hover:bg-danger/20'
  if (state === 'pending') return 'bg-warning/10 text-warning hover:bg-warning/20'
  return 'bg-success/10 text-success hover:bg-success/20'
}

/** Wording for the rolled-up check state, sentence-cased for a label or title. */
export function prChecksStateLabel(state: string): string {
  if (state === 'failure') return 'Checks failing'
  if (state === 'pending') return 'Checks running'
  return 'Checks passing'
}
