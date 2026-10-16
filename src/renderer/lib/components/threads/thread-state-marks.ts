import CioCheckCircle from '$lib/components/icons/cio/CioCheckCircle.svelte'
import CioClock from '$lib/components/icons/cio/CioClock.svelte'
import CioCrossCircle from '$lib/components/icons/cio/CioCrossCircle.svelte'
import CioPencil from '$lib/components/icons/cio/CioPencil.svelte'
import CioRefresh from '$lib/components/icons/cio/CioRefresh.svelte'
import CioTemporaryChat from '$lib/components/icons/cio/CioTemporaryChat.svelte'
import CioWindow from '$lib/components/icons/cio/CioWindow.svelte'
import { AlarmClock, Inbox, Pickaxe, Toolbox } from '@lucide/svelte'
import type { Component } from 'svelte'
import TriangleQuestionMark from '$lib/components/icons/cio/TriangleQuestionMark.svelte'
import type { ThreadStatusTone } from '$shared/thread-status-policy'

/**
 * The state vocabulary of a thread row, in one place.
 *
 * A thread row speaks with marks, never with colour alone. Each state has a
 * glyph that names it, and the glyph sits above a rail down the row's left edge.
 * Both wear the state's own colour, so the mark itself is the colour: a reader
 * learns "the pen means a draft is waiting" once and reads it everywhere.
 *
 * Everything here is defined once because the same mark appears on more than one
 * surface: the row, the sidebar's status group headers, the project filter menu.
 * A second copy is how the specification ends up drawn as a document in one
 * place and a toolbox in another, which is exactly the drift this file prevents.
 *
 * `tone` ties a mark to the canonical status tones in
 * `$shared/thread-status-policy`; `colour` is the CSS variable both the glyph
 * and the rail paint with.
 */

/** A mark the row draws: its glyph, what it is called, and how the rail reads. */
export interface ThreadStateMark {
  /** Canonical Lucide (or in-house) glyph, drawn above the rail. */
  icon: Component
  /** Canonical human name, used for `title` and `aria-label`. */
  label: string
  /** The status tone this mark reads as. */
  tone: ThreadStatusTone
  /**
   * CSS custom property for the glyph and the rail.
   *
   * Held here rather than derived from `tone`, because several states share a
   * tone while needing their own colour: unread and done are both settled, but
   * unread is the green the whole app already uses for it.
   */
  colour: string
  /** How the rail is drawn. Shape is the second carrier beside the colour. */
  dash: 'solid' | 'dashed' | 'dotted'
  /**
   * Whether a rail is drawn under the glyph at all.
   *
   * A settled thread draws none: with nothing left to do, the row should attract
   * no attention, so it shows its glyph alone, vertically centred. Every other
   * state keeps its rail, because every other state is asking for something.
   */
  rail?: boolean
}

/**
 * The mark for each primary state: the thread's own state, which the rail carries.
 * Keys match `ThreadState` in ThreadRow.svelte.
 *
 * Nothing here describes something waiting on the thread. A draft, a queued
 * message and a start-after are secondary statuses (`THREAD_SECONDARY_MARKS`),
 * because they ride above the thread's own state rather than replacing it.
 *
 * Read and completed share a glyph on purpose: both are settled, and the row
 * does not need to spend a mark distinguishing them.
 */
export const THREAD_STATE_MARKS = {
  unread: {
    icon: Inbox,
    label: 'Unread',
    tone: 'done',
    colour: 'var(--color-thread-unread)',
    dash: 'solid'
  },
  'temporary-unread': {
    icon: CioTemporaryChat,
    label: 'Side chat unread',
    tone: 'done',
    colour: 'var(--color-thread-unread)',
    dash: 'dashed'
  },
  read: {
    icon: CioCheckCircle,
    label: 'Read',
    tone: 'done',
    colour: 'var(--color-thread-done)',
    dash: 'solid',
    rail: false
  },
  completed: {
    icon: CioCheckCircle,
    label: 'Completed',
    tone: 'done',
    colour: 'var(--color-thread-done)',
    dash: 'solid',
    rail: false
  },
  todo: {
    icon: CioPencil,
    label: 'Draft',
    tone: 'todo',
    colour: 'var(--color-muted)',
    dash: 'dashed'
  },
  working: {
    icon: Pickaxe,
    label: 'Working',
    tone: 'working',
    colour: 'var(--color-thread-working)',
    dash: 'solid'
  },
  'working-paused': {
    icon: CioRefresh,
    label: 'Retrying',
    tone: 'working-paused',
    colour: 'var(--color-warning)',
    dash: 'dashed'
  },
  spec: {
    icon: Toolbox,
    label: 'Spec ready',
    tone: 'spec',
    colour: 'var(--color-thread-spec)',
    dash: 'solid'
  },
  approval: {
    icon: TriangleQuestionMark,
    label: 'Needs attention',
    tone: 'attention',
    colour: 'var(--color-warning)',
    dash: 'solid'
  },
  error: {
    icon: CioCrossCircle,
    label: 'Failed',
    tone: 'error',
    colour: 'var(--color-danger)',
    dash: 'solid'
  }
} as const satisfies Record<string, ThreadStateMark>

/**
 * The secondary statuses: what is waiting on the thread rather than what the
 * thread itself is doing.
 *
 * A row carries one primary status, drawn on the rail, and at most one secondary
 * status, drawn as the glyph above it. The secondary slot is the flexible one and
 * the last action wins: typing takes it, sending hands it to the queue, and
 * typing the next message takes it back.
 *
 * A draft, a queued message and a start-after are all "something is waiting",
 * which is why none of them is a primary state. The thread's own state survives
 * underneath: a thread that is working while a message waits keeps the working
 * rail and wears the clock above it.
 *
 * `queued` and `scheduled` are related but deliberately distinct: a queued message
 * waits behind this thread's own running turn and wears the clock, while a
 * scheduled one waits for another thread to finish and wears an alarm clock.
 */
export const THREAD_SECONDARY_MARKS = {
  draft: {
    icon: CioPencil,
    label: 'Draft in the composer',
    tone: 'todo',
    colour: 'var(--color-muted)',
    dash: 'dashed'
  },
  queued: {
    icon: CioClock,
    label: 'Message queued',
    tone: 'todo',
    colour: 'var(--color-info)',
    dash: 'dotted'
  },
  scheduled: {
    icon: AlarmClock,
    label: 'Starts after another thread',
    tone: 'todo',
    colour: 'var(--color-info)',
    dash: 'dotted'
  }
} as const satisfies Record<string, ThreadStateMark>

export type ThreadRowSecondary = keyof typeof THREAD_SECONDARY_MARKS

/** The mark for something waiting on the thread. */
export function threadSecondaryMark(secondary: ThreadRowSecondary): ThreadStateMark {
  return THREAD_SECONDARY_MARKS[secondary]
}

/**
 * The mark for a run another instance owns.
 *
 * The thread is working right now, but this window receives none of that work,
 * so the working mark's pickaxe promises the reader something false: a turn
 * running in front of them, with live output and a stop control. A window that
 * is only a window into another instance's run has neither, so the row says so
 * with the window glyph instead.
 *
 * It wears `--color-thread-working`, which is the working state's own blue and
 * the blue every other surface already paints this state with: the header chip,
 * the task list's "Live elsewhere", the trace footer. The state is work, and it
 * is work this window can watch rather than drive, so the hue is shared and the
 * glyph alone carries the difference. That keeps the spine and the row's badge
 * derived from the same vocabulary instead of drifting apart.
 */
export const THREAD_FOREIGN_MARK: ThreadStateMark = {
  icon: CioWindow,
  label: 'Running in another instance',
  tone: 'working',
  colour: 'var(--color-thread-working)',
  dash: 'solid'
}

export type ThreadRowState = keyof typeof THREAD_STATE_MARKS

/** The mark for one primary state. */
export function threadStateMark(state: ThreadRowState): ThreadStateMark {
  return THREAD_STATE_MARKS[state]
}

/**
 * Whether a mark draws a rail under its glyph.
 *
 * Read and completed are the settled pair: they answered the user already, so
 * their row keeps quiet and shows only the glyph. Everything else is waiting,
 * running, or failed, and keeps the rail to say so.
 */
export function markDrawsRail(mark: ThreadStateMark): boolean {
  return mark.rail !== false
}

/**
 * The mark for a status group header in the sidebar, which groups threads by the
 * same states the rows report. Shares its glyphs, colours and tones with the
 * rows, so a group header and the rows under it always agree.
 */
export const THREAD_GROUP_MARK: Record<string, ThreadStateMark> = {
  Attention: THREAD_STATE_MARKS.approval,
  Unread: THREAD_STATE_MARKS.unread,
  Errors: THREAD_STATE_MARKS.error,
  Spec: THREAD_STATE_MARKS.spec,
  Working: THREAD_STATE_MARKS.working,
  Done: THREAD_STATE_MARKS.completed
}
