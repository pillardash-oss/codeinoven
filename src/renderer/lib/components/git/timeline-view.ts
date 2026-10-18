import CioBan from '@pillardash-oss/cio-icon/CioBan.svelte'
import CioCommit from '@pillardash-oss/cio-icon/CioCommit.svelte'
import CioCopy from '@pillardash-oss/cio-icon/CioCopy.svelte'
import CioEye from '@pillardash-oss/cio-icon/CioEye.svelte'
import CioLock from '@pillardash-oss/cio-icon/CioLock.svelte'
import CioLockOpen from '@pillardash-oss/cio-icon/CioLockOpen.svelte'
import CioMerge from '@pillardash-oss/cio-icon/CioMerge.svelte'
import CioMilestone from '@pillardash-oss/cio-icon/CioMilestone.svelte'
import CioPencil from '@pillardash-oss/cio-icon/CioPencil.svelte'
import CioPersonPlus from '@pillardash-oss/cio-icon/CioPersonPlus.svelte'
import CioPin from '@pillardash-oss/cio-icon/CioPin.svelte'
import CioPinOff from '@pillardash-oss/cio-icon/CioPinOff.svelte'
import CioPullRequestDraft from '@pillardash-oss/cio-icon/CioPullRequestDraft.svelte'
import CioScissors from '@pillardash-oss/cio-icon/CioScissors.svelte'
import CioSwap from '@pillardash-oss/cio-icon/CioSwap.svelte'
import CioTabGit from '@pillardash-oss/cio-icon/CioTabGit.svelte'
import CioTabSettings from '@pillardash-oss/cio-icon/CioTabSettings.svelte'
import CioTag from '@pillardash-oss/cio-icon/CioTag.svelte'
import CioUndo from '@pillardash-oss/cio-icon/CioUndo.svelte'
import CioUserCheck from '@pillardash-oss/cio-icon/CioUserCheck.svelte'
import CioUserMinus from '@pillardash-oss/cio-icon/CioUserMinus.svelte'
import type { IssueTimelineEvent } from '$shared/types'

/**
 * The pictogram a timeline row draws on the rail.
 *
 * One icon per event kind, so an event reads before its sentence is read: the
 * rail becomes a column of shapes a reader can scan for the thing they came for,
 * a merge, a close, a commit. A kind with no case answers with a dot rather than
 * drawing nothing, because a row without a mark would look like a row the rail
 * skipped.
 *
 * The icon is decoration: the sentence beside it already says what happened, so
 * the row hides it from assistive technology instead of announcing the kind twice.
 */
export function timelineEventIcon(event: Pick<IssueTimelineEvent, 'kind'>): typeof CioTag {
  switch (event.kind) {
    case 'labeled':
    case 'unlabeled':
      return CioTag
    case 'assigned':
      return CioPersonPlus
    case 'unassigned':
      return CioUserMinus
    case 'closed':
      return CioBan
    case 'reopened':
      return CioUndo
    case 'renamed':
      return CioPencil
    case 'milestoned':
    case 'demilestoned':
      return CioMilestone
    case 'locked':
      return CioLock
    case 'unlocked':
      return CioLockOpen
    case 'pinned':
      return CioPin
    case 'unpinned':
      return CioPinOff
    case 'referenced':
      return CioCommit
    case 'cross-referenced':
      return CioSwap
    case 'marked_as_duplicate':
      return CioCopy
    case 'connected':
      return CioTabGit
    case 'fields':
      return CioTabSettings
    case 'merged':
      return CioMerge
    case 'review_requested':
    case 'review_request_removed':
      return CioUserCheck
    case 'ready_for_review':
      return CioEye
    case 'converted_to_draft':
      return CioPullRequestDraft
    case 'head_ref_deleted':
      return CioScissors
    default:
      return CioTag
  }
}

/**
 * The colour the rail's pictogram for one event is drawn in.
 *
 * Mostly the dimmest text token, because most of what happens to a conversation
 * is bookkeeping and a rail that shouted every label change would be noise. The
 * tones are spent where the event is a change in the conversation's standing: a
 * close, a merge, a commit that landed, a link to a branch.
 */
export function timelineEventToneClass(event: Pick<IssueTimelineEvent, 'kind'>): string {
  switch (event.kind) {
    case 'closed':
      return 'text-primary'
    case 'reopened':
    case 'referenced':
    case 'merged':
      return 'text-success'
    case 'connected':
    case 'ready_for_review':
      return 'text-info'
    case 'locked':
      return 'text-warning'
    default:
      return 'text-muted'
  }
}

/**
 * How much of a long history stays in view around the collapsed middle.
 *
 * The head keeps the start of the story, the tail keeps what just happened, so the
 * two things a reader opens a long conversation for, how it began and where it
 * stands, are both on screen with the bulk in between behind one button. The
 * minimum is what makes that worth doing: below it the middle is short enough that
 * hiding it would cost a click and save no reading.
 */
export const TIMELINE_COLLAPSE = { head: 4, tail: 10, minimum: 24 } as const

/** A long history as the three runs a reader draws: the start, the middle, the end. */
export interface TimelineCollapsePlan<T> {
  head: T[]
  /** The run the divider stands in for, empty when there is nothing worth hiding. */
  hidden: T[]
  tail: T[]
}

/**
 * Split a history into the part that stays, the middle that collapses, and the
 * end that stays.
 *
 * A short history is handed back whole in `head`, so a caller renders one run and
 * no divider. It takes rows rather than a count because the two readers carry
 * different row shapes and neither should have to index into its own list twice.
 */
export function timelineCollapsePlan<T>(rows: readonly T[]): TimelineCollapsePlan<T> {
  const { head, tail, minimum } = TIMELINE_COLLAPSE
  if (rows.length <= minimum) return { head: [...rows], hidden: [], tail: [] }
  return {
    head: rows.slice(0, head),
    hidden: rows.slice(head, rows.length - tail),
    tail: rows.slice(rows.length - tail)
  }
}
