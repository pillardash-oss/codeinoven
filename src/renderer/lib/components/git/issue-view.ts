/**
 * Vocabulary shared by the Git panel's issue surface and the issue reader under
 * it: the state pills, the listing choices, and the actions a row offers.
 *
 * Kept out of the components for the same reason `pr-view.ts` is: the list and
 * the reader both draw these, and a label or an ordering that exists in one and
 * not the other is exactly the drift this module prevents.
 */

import CioBan from '$lib/components/icons/cio/CioBan.svelte'
import CioCheckCircle from '$lib/components/icons/cio/CioCheckCircle.svelte'
import CioCrossCircle from '$lib/components/icons/cio/CioCrossCircle.svelte'
import CioDot from '$lib/components/icons/cio/CioDot.svelte'
import type { PrMetadataMode } from './pr-view'
import type {
  IssueListFilter,
  IssueListSort,
  IssueRelationshipItem,
  IssueStateReason,
  IssueSummary,
  IssueTimelineEvent,
  IssueTimelineReference,
  PullRequestLabel
} from '$shared/types'

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
export function issueStateIcon(issue: Pick<IssueSummary, 'state' | 'stateReason'>): typeof CioDot {
  if (issue.state === 'open') return CioDot
  if (issue.stateReason === 'not_planned') return CioBan
  if (issue.stateReason === 'reopened') return CioDot
  return issue.stateReason === 'completed' ? CioCheckCircle : CioCrossCircle
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
  if (reason === 'duplicate') return 'Duplicate'
  return null
}

/**
 * A timeline row as the sentence it reads as.
 *
 * The row is one line: whoever did it, then what they did. Some of those actions
 * carry something a reader wants to click or recognise, so they are handed back
 * as parts rather than as one string: a label keeps its own chip and colour, a
 * cross-reference stays a link instead of becoming text that merely looks like
 * one, and a commit stays a handle the reader can open rather than a hash that
 * only looks like one. `lead` is the wording that precedes the part, `trail`
 * whatever follows it.
 */
export interface IssueTimelineLine {
  lead: string
  /** The label a labeling event carried, drawn as its own chip. */
  label?: PullRequestLabel | null
  /** The issue or pull request a cross-reference named, drawn as a link. */
  reference?: IssueTimelineReference | null
  /**
   * The commit a reference event named, as the full hash.
   *
   * Kept apart from `lead` so the row can draw it as a control: the commit lives in
   * this repository, so the reader opens it where the repository is read, in the
   * Git panel, rather than leaving the app for github.com.
   */
  commitId?: string | null
  /** Wording that follows the inline part, empty when nothing follows. */
  trail?: string
}

/**
 * The sentence one timeline event reads as.
 *
 * The wording follows github.com row for row, so a reader who knows the issue on
 * the site reads the same story here. Every kind is answered even when the event
 * carried less than the row would like: a milestone event whose payload omitted
 * the title still says a milestone changed, because an event that happened is
 * never worth hiding behind an empty row.
 */
export function issueTimelineLine(event: IssueTimelineEvent): IssueTimelineLine {
  switch (event.kind) {
    case 'labeled':
      return { lead: 'added the', label: event.label ?? null, trail: 'label' }
    case 'unlabeled':
      return { lead: 'removed the', label: event.label ?? null, trail: 'label' }
    case 'assigned':
      return { lead: `assigned ${event.assigneeLogin ?? 'someone'}` }
    case 'unassigned':
      return { lead: `unassigned ${event.assigneeLogin ?? 'someone'}` }
    case 'review_requested':
      return {
        lead:
          event.reviewerLogin !== null && event.reviewerLogin !== undefined
            ? `requested a review from ${event.reviewerLogin}`
            : event.reviewerTeamName
              ? `requested a review from the ${event.reviewerTeamName} team`
              : 'requested a review'
      }
    case 'review_request_removed':
      return {
        lead:
          event.reviewerLogin !== null && event.reviewerLogin !== undefined
            ? `removed the review request for ${event.reviewerLogin}`
            : event.reviewerTeamName
              ? `removed the review request for the ${event.reviewerTeamName} team`
              : 'removed a review request'
      }
    case 'ready_for_review':
      return { lead: 'marked this pull request as ready for review' }
    case 'converted_to_draft':
      return { lead: 'converted this pull request to draft' }
    case 'closed': {
      const reason = issueStateReasonLabel(event.closeReason ?? null)
      return { lead: reason ? `closed this as ${reason.toLowerCase()}` : 'closed this' }
    }
    case 'reopened':
      return { lead: 'reopened this' }
    case 'renamed':
      return event.rename
        ? { lead: `changed the title from "${event.rename.from}" to "${event.rename.to}"` }
        : { lead: 'changed the title' }
    case 'milestoned':
      return {
        lead: event.milestoneTitle
          ? `added this to the ${event.milestoneTitle} milestone`
          : 'added this to a milestone'
      }
    case 'demilestoned':
      return {
        lead: event.milestoneTitle
          ? `removed this from the ${event.milestoneTitle} milestone`
          : 'removed this from a milestone'
      }
    case 'locked':
      return {
        lead: event.lockReason
          ? `locked this conversation as ${event.lockReason.replace(/[-_]/gu, ' ')}`
          : 'locked this conversation'
      }
    case 'unlocked':
      return { lead: 'unlocked this conversation' }
    case 'pinned':
      return { lead: 'pinned this issue' }
    case 'unpinned':
      return { lead: 'unpinned this issue' }
    case 'referenced':
      // The hash is a part rather than part of the sentence: the reader opens the
      // commit in the Git panel, and wording that swallowed the hash would leave
      // nothing to click.
      return event.commitId
        ? { lead: 'referenced this in commit', commitId: event.commitId }
        : { lead: 'referenced this' }
    case 'cross-referenced':
      return { lead: 'mentioned this in', reference: event.reference ?? null }
    case 'merged':
      // A merge whose payload carried no commit still says it happened, rather
      // than dangling the word "commit" in front of nothing.
      return event.commitId
        ? { lead: 'merged commit', commitId: event.commitId }
        : { lead: 'merged this' }
    case 'head_ref_deleted':
      return { lead: 'deleted the head branch' }
    case 'marked_as_duplicate':
      return { lead: 'marked this as a duplicate' }
    case 'connected':
      return { lead: 'linked this to a branch or pull request' }
    case 'fields':
      return { lead: "updated the issue's fields" }
  }
}

/**
 * The reference as one label: `owner/repo#number`, or `#number` when it lives in
 * the repository the reader is already in.
 */
export function issueReferenceLabel(reference: IssueTimelineReference, repository: string): string {
  return reference.repository && reference.repository !== repository
    ? `${reference.repository}#${reference.number}`
    : `#${reference.number}`
}

/**
 * A related issue as the row shape the reader opens.
 *
 * The relationship endpoints answer with a leaner object than a listing row, so the
 * fields they do not carry (the author, the timestamps, the comment count) start
 * empty. That is safe because the reader draws the row it opened and replaces it the
 * moment the bundle lands; the alternative, inventing values, would show a comment
 * count and an author that no payload ever said.
 */
export function issueRelationshipSummary(item: IssueRelationshipItem): IssueSummary {
  return {
    number: item.number,
    title: item.title,
    url: item.url,
    state: item.state,
    stateReason: item.stateReason,
    authorLogin: '',
    authorAvatarUrl: null,
    authorIsBot: false,
    createdAt: '',
    updatedAt: '',
    comments: 0
  }
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

/**
 * A dialog a list row asks the issue reader to raise as it opens.
 *
 * A row offers the same actions the reader does, and the confirmation and the
 * picker are the reader's own. A row that wants one hands the request over with
 * the issue instead of a second copy of the dialog living in the list. Actions
 * that need no dialog are not here: the row performs those itself, through the
 * shared `git-issue-actions` module.
 */
export type IssueReaderAction = { kind: 'close' } | { kind: 'metadata'; mode: PrMetadataMode }

/** The reader request a list action stands for, or null for one the list handles itself. */
export function issueReaderActionFor(action: IssueListAction): IssueReaderAction | null {
  switch (action.kind) {
    case 'close':
      return { kind: 'close' }
    case 'labels':
      return { kind: 'metadata', mode: 'labels' }
    case 'assignees':
      return { kind: 'metadata', mode: 'assignees' }
    case 'milestone':
      return { kind: 'metadata', mode: 'milestone' }
    default:
      return null
  }
}
