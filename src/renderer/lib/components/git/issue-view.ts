/**
 * Vocabulary shared by the Git panel's issue surface and the issue reader under
 * it: the state pills, the listing choices, and the actions a row offers.
 *
 * Kept out of the components for the same reason `pr-view.ts` is: the list and
 * the reader both draw these, and a label or an ordering that exists in one and
 * not the other is exactly the drift this module prevents.
 */
import { CircleCheck, CircleDot, CircleSlash, CircleX } from '@lucide/svelte'
import type { IssueListFilter, IssueListSort, IssueStateReason, IssueSummary } from '$shared/types'

/**
 * The relationships an issue listing can narrow to, in the order the menu lists
 * them. These are GitHub's own search qualifiers, one per member.
 */
export const ISSUE_LIST_FILTER_OPTIONS: Array<{
  id: IssueListFilter
  label: string
  hint: string
}> = [
  { id: 'all', label: 'All issues', hint: 'Everything in this repository' },
  { id: 'created', label: 'Created by me', hint: 'Issues you opened' },
  { id: 'assigned', label: 'Assigned to me', hint: 'Issues assigned to you' },
  { id: 'mentioned', label: 'Mentioned me', hint: 'Issues you were mentioned in' },
  { id: 'involves', label: 'Involves me', hint: 'You opened, were assigned, or were mentioned' }
]

/**
 * The orderings an issue listing offers, in the order the menu lists them. The
 * labels are the ones github.com's issue list uses for the same `sort:` values.
 */
export const ISSUE_LIST_SORT_OPTIONS: Array<{ id: IssueListSort; label: string }> = [
  { id: 'updated', label: 'Recently updated' },
  { id: 'created', label: 'Newest' },
  { id: 'comments-desc', label: 'Most commented' },
  { id: 'updated-asc', label: 'Least recently updated' },
  { id: 'created-asc', label: 'Oldest' },
  { id: 'comments-asc', label: 'Least commented' }
]

/** Wording for one relationship filter, for a menu row or a control's accessible name. */
export function issueListFilterLabel(filter: IssueListFilter): string {
  return ISSUE_LIST_FILTER_OPTIONS.find((option) => option.id === filter)?.label ?? 'All issues'
}

/** Wording for one ordering, for a menu row or a control's accessible name. */
export function issueListSortLabel(sort: IssueListSort): string {
  return ISSUE_LIST_SORT_OPTIONS.find((option) => option.id === sort)?.label ?? 'Recently updated'
}

/**
 * The icon for an issue's state pill.
 *
 * GitHub's own triage of a closed issue: a check for one resolved on purpose and
 * a slash for one dismissed as not planned, with a plain cross when the payload
 * carried no reason at all.
 */
export function issueStateIcon(
  issue: Pick<IssueSummary, 'state' | 'stateReason'>
): typeof CircleDot {
  if (issue.state === 'open') return CircleDot
  if (issue.stateReason === 'not_planned') return CircleSlash
  if (issue.stateReason === 'reopened') return CircleDot
  return issue.stateReason === 'completed' ? CircleCheck : CircleX
}

/** Badge colour for an issue's state pill. */
export function issueStateToneClass(issue: Pick<IssueSummary, 'state'>): string {
  return issue.state === 'closed' ? 'bg-primary/10 text-primary' : 'bg-success/10 text-success'
}

/**
 * The word GitHub uses for a closure reason, or null when there is none to show.
 *
 * `reopened` is a state GitHub reports rather than a reason a reader can be
 * told, so it stays silent instead of labelling an open issue as "Reopened".
 */
export function issueStateReasonLabel(reason: IssueStateReason | null): string | null {
  if (reason === 'completed') return 'Completed'
  if (reason === 'not_planned') return 'Not planned'
  return null
}

/**
 * One action an issue list row offers, already resolved to the rows it applies to.
 *
 * `targets` carries the scope the action acts on so no caller can dispatch one
 * without saying what it means, mirroring `PrListAction`.
 */
export type IssueListAction =
  | { kind: 'open'; targets: IssueSummary[] }
  | { kind: 'open-in-browser'; targets: IssueSummary[] }
  | { kind: 'copy-links'; targets: IssueSummary[] }
  | { kind: 'close'; targets: IssueSummary[] }
  | { kind: 'reopen'; targets: IssueSummary[] }
  | { kind: 'labels'; targets: IssueSummary[] }
  | { kind: 'assignees'; targets: IssueSummary[] }
  | { kind: 'milestone'; targets: IssueSummary[] }
  /** Hand one issue to an agent as a scoped piece of work. */
  | { kind: 'work-on'; targets: IssueSummary[] }
  /** Open a pull request prefilled to close the issue. */
  | { kind: 'create-pr'; targets: IssueSummary[] }
