/**
 * Vocabulary shared by the two surfaces that read the same pull request: the Git
 * panel's action row and the detail reader underneath it. The panel draws the
 * state pills, the check pill and the view switcher in its own rows now, so
 * neither the badge classes nor the view list can live inside the reader.
 */
import {
  Bot,
  CircleCheck,
  CircleX,
  FileDiff,
  GitCommitHorizontal,
  Loader2,
  MessagesSquare,
  ShieldCheck
} from '@lucide/svelte'
import type {
  PrListFilter,
  PrListSort,
  PrMergeMethod,
  PullRequestBundle,
  PullRequestChecks,
  PullRequestSummary
} from '$shared/types'
import { buildConversation, conversationEntryCount } from './git-pull-request-detail-format'

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
 * count comes from the same builder the reader renders, so a review's inline
 * threads count the way the stream shows them rather than drifting from it.
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
  return conversationEntryCount(buildConversation(bundle))
}

/**
 * Which piece of pull request metadata a picker edits.
 *
 * The members are also the action kinds the list emits, so a row menu cannot offer
 * a picker that has no implementation and the picker cannot address metadata the row
 * menu never names.
 */
export type PrMetadataMode = 'labels' | 'assignees' | 'milestone'

/**
 * One action a pull request list row offers, already resolved to the rows it applies
 * to.
 *
 * The scope travels inside the action rather than alongside it so no caller can
 * dispatch one without saying what it acts on: a batch close of a selection and a
 * batch close of one row are the same call with a different list, which is what
 * keeps the two surfaces that draw the list from disagreeing about the difference.
 */
export type PrListAction =
  | { kind: 'open'; targets: PullRequestSummary[] }
  | { kind: 'open-in-browser'; targets: PullRequestSummary[] }
  | { kind: 'copy-links'; targets: PullRequestSummary[] }
  | { kind: 'copy-branches'; targets: PullRequestSummary[] }
  | { kind: 'close'; targets: PullRequestSummary[] }
  | { kind: 'reopen'; targets: PullRequestSummary[] }
  | { kind: 'explain'; targets: PullRequestSummary[] }
  | { kind: 'quick-chat'; targets: PullRequestSummary[] }
  /** Hand one pull request to an agent to triage and report on. */
  | { kind: 'assign-agent'; targets: PullRequestSummary[] }
  /** Jump back into the thread an agent assignment is running in. */
  | { kind: 'open-agent-thread'; targets: PullRequestSummary[]; threadId: string }
  | { kind: 'merge'; targets: PullRequestSummary[]; method: PrMergeMethod }
  | { kind: 'mark-ready'; targets: PullRequestSummary[] }
  | { kind: 'labels'; targets: PullRequestSummary[] }
  | { kind: 'assignees'; targets: PullRequestSummary[] }
  | { kind: 'milestone'; targets: PullRequestSummary[] }

/** Badge colour for a pull request's state pill. */
export function prStateBadgeClass(state: string): string {
  if (state === 'merged') return 'bg-primary/10 text-primary'
  if (state === 'closed') return 'bg-danger/10 text-danger'
  return 'bg-success/10 text-success'
}

/**
 * Colours per rolled-up check state, split so a pill that is not a control can
 * take the tone alone.
 *
 * Two fields rather than one string because the hover response belongs to the
 * interactive use only: the detail header's pill is its own control and answers
 * the pointer, while the list's pill sits inside a row that highlights as a
 * whole, where a second colour change under the cursor reads as two hover states
 * for one row.
 */
const PR_CHECKS_TONES: Record<string, { tone: string; hover: string }> = {
  failure: { tone: 'bg-danger/10 text-danger', hover: 'hover:bg-danger/20' },
  pending: { tone: 'bg-warning/10 text-warning', hover: 'hover:bg-warning/20' }
}

/** Passing, and the state this app does not recognise, share the calm colour. */
const PR_CHECKS_TONE_FALLBACK = { tone: 'bg-success/10 text-success', hover: 'hover:bg-success/20' }

/** Colour for a check pill that only reports, so it never answers a hover. */
export function prChecksToneClass(state: string): string {
  return (PR_CHECKS_TONES[state] ?? PR_CHECKS_TONE_FALLBACK).tone
}

/** Colour for the rolled-up check state pill, hover included for a control. */
export function prChecksBadgeClass(state: string): string {
  const tone = PR_CHECKS_TONES[state] ?? PR_CHECKS_TONE_FALLBACK
  return `${tone.tone} ${tone.hover}`
}

/** Wording for the rolled-up check state, sentence-cased for a label or title. */
export function prChecksStateLabel(state: string): string {
  if (state === 'failure') return 'Checks failing'
  if (state === 'pending') return 'Checks running'
  if (state === 'success') return 'Checks passing'
  // Reachable only through a caller that skipped its `!== 'none'` guard, but the
  // fallback must still describe `none` rather than claim a pass it never saw.
  return 'No checks'
}

/**
 * The glyph for a rolled-up check state.
 *
 * The counts alone do not say whether `3/3` is good news: a failed run reports
 * `3/3` too. Colour was carrying that distinction, which is invisible to anyone
 * who cannot separate the red and green tones, so the shape carries it as well:
 * a tick for every check passed, a cross for a failure, and a spinner for work
 * still running.
 *
 * Chosen here rather than in each caller because the listing row and the detail
 * header draw the same pill, and a state that renders as a tick in one surface
 * must not render as a cross in the other.
 */
export function prChecksStateIcon(state: PullRequestChecks['state']): typeof ShieldCheck {
  if (state === 'success') return CircleCheck
  if (state === 'failure') return CircleX
  if (state === 'pending') return Loader2
  return ShieldCheck
}

/** Whether that glyph only reads as "running" while it turns. */
export function prChecksStateSpinning(state: PullRequestChecks['state']): boolean {
  return state === 'pending'
}

/**
 * The relationships a listing can narrow to, in the order the menu lists them.
 *
 * Kept here rather than in the menu component because the panel and the full
 * screen reader both draw this control, and a filter that exists in one of them
 * and not the other is exactly the drift this module exists to prevent.
 */
export const PR_LIST_FILTER_OPTIONS: Array<{
  id: PrListFilter
  label: string
  hint: string
}> = [
  { id: 'all', label: 'All pull requests', hint: 'Everything in this repository' },
  { id: 'authored', label: 'Authored by me', hint: 'Pull requests you opened' },
  { id: 'assigned', label: 'Assigned to me', hint: 'Pull requests assigned to you' },
  {
    id: 'review-requested',
    label: 'Review requested',
    hint: 'Waiting on a review from you'
  },
  { id: 'involves', label: 'Involves me', hint: 'You opened, were assigned, or were mentioned' }
]

/**
 * The orderings a listing offers, in the order the menu lists them.
 *
 * The same set github.com's pull request list offers, and the labels are the ones
 * its Sort menu uses for them. Each id maps to one `sort:` qualifier in the
 * provider; the comment orderings earn their place here because "which pull
 * request is worth opening" is a question about discussion, not recency.
 */
export const PR_LIST_SORT_OPTIONS: Array<{ id: PrListSort; label: string }> = [
  { id: 'updated', label: 'Recently updated' },
  { id: 'created', label: 'Newest' },
  { id: 'comments-desc', label: 'Most commented' },
  { id: 'updated-asc', label: 'Least recently updated' },
  { id: 'created-asc', label: 'Oldest' },
  { id: 'comments-asc', label: 'Least commented' }
]

/** Wording for one relationship filter, for a menu row or a sentence. */
export function prListFilterLabel(filter: PrListFilter): string {
  return PR_LIST_FILTER_OPTIONS.find((option) => option.id === filter)?.label ?? 'All pull requests'
}

/** Wording for one ordering, for a menu row or a control's accessible name. */
export function prListSortLabel(sort: PrListSort): string {
  return PR_LIST_SORT_OPTIONS.find((option) => option.id === sort)?.label ?? 'Recently updated'
}

/**
 * Inline style for one label chip.
 *
 * A label's colour is provider data, not a theme token: GitHub hands out six hex
 * digits per label and the chip has to paint exactly that, which no class can do.
 * The text colour flips on the colour's own luminance, because the palette holds
 * near-white labels and near-black ones, and neither white nor black text is
 * readable on all of them.
 */
export function prLabelStyle(color: string): string {
  const hex = color.trim().replace(/^#/u, '')
  // Anything that is not the provider's own shape falls back to chrome instead
  // of being interpolated into a style attribute.
  if (!/^[0-9a-f]{6}$/iu.test(hex)) {
    return 'background-color: var(--color-elevated); color: var(--color-muted)'
  }
  const red = Number.parseInt(hex.slice(0, 2), 16)
  const green = Number.parseInt(hex.slice(2, 4), 16)
  const blue = Number.parseInt(hex.slice(4, 6), 16)
  // Rec. 601 luma: the cheap perceptual weight, which is all a chip needs.
  const luma = (0.299 * red + 0.587 * green + 0.114 * blue) / 255
  return `background-color: #${hex}; color: ${luma > 0.6 ? '#1f2328' : '#ffffff'}`
}
