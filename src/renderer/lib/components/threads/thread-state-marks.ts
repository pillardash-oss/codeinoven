import {
  AlarmClock,
  CircleCheck,
  CircleX,
  Clock,
  Inbox,
  MessageCircleDashed,
  Pickaxe,
  RefreshCw,
  SquarePen,
  Toolbox
} from '@lucide/svelte'
import type { Component } from 'svelte'
import TriangleQuestionMark from '$lib/components/icons/TriangleQuestionMark.svelte'
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
   * Whether the rail is drawn wider. The two states that want the user get it,
   * so they are findable from across the sidebar without reading a word.
   */
  wide?: boolean
}

/**
 * The mark for each row state. Keys match `ThreadState` in ThreadRow.svelte.
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
    icon: MessageCircleDashed,
    label: 'Side chat unread',
    tone: 'done',
    colour: 'var(--color-thread-unread)',
    dash: 'dashed'
  },
  read: {
    icon: CircleCheck,
    label: 'Read',
    tone: 'done',
    colour: 'var(--color-border-strong)',
    dash: 'solid'
  },
  completed: {
    icon: CircleCheck,
    label: 'Completed',
    tone: 'done',
    colour: 'var(--color-thread-done)',
    dash: 'solid'
  },
  todo: {
    icon: SquarePen,
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
    icon: RefreshCw,
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
    dash: 'solid',
    wide: true
  },
  error: {
    icon: CircleX,
    label: 'Failed',
    tone: 'error',
    colour: 'var(--color-danger)',
    dash: 'solid',
    wide: true
  },
  scheduled: {
    icon: AlarmClock,
    label: 'Starts after another thread',
    tone: 'todo',
    colour: 'var(--color-info)',
    dash: 'dotted'
  },
  queued: {
    icon: Clock,
    label: 'Message queued',
    tone: 'todo',
    colour: 'var(--color-info)',
    dash: 'dotted'
  }
} as const satisfies Record<string, ThreadStateMark>

export type ThreadRowState = keyof typeof THREAD_STATE_MARKS

/**
 * The mark for something waiting on the thread.
 *
 * These are not states: a draft, a queued message and a start-after all describe
 * what is waiting rather than what the thread is doing, so they ride the rail as
 * a mark. `scheduled` and `queued` are related but deliberately distinct: a
 * queued message waits behind this thread's own running turn and wears the
 * clock, while a scheduled one waits for another thread to finish and wears an
 * alarm clock.
 */
export const THREAD_ACTION_MARKS = {
  todo: {
    icon: SquarePen,
    label: 'Draft in the composer',
    tone: 'todo',
    colour: 'var(--color-muted)',
    dash: 'dashed'
  },
  scheduled: {
    icon: AlarmClock,
    label: 'Starts after another thread',
    tone: 'todo',
    colour: 'var(--color-info)',
    dash: 'dotted'
  },
  queued: {
    icon: Clock,
    label: 'Message queued',
    tone: 'todo',
    colour: 'var(--color-info)',
    dash: 'dotted'
  }
} as const satisfies Record<string, ThreadStateMark>

export type ThreadRowAction = keyof typeof THREAD_ACTION_MARKS

/** The mark for one row state. */
export function threadStateMark(state: ThreadRowState): ThreadStateMark {
  return THREAD_STATE_MARKS[state]
}

/** The mark for something waiting on the thread. */
export function threadActionMark(action: ThreadRowAction): ThreadStateMark {
  return THREAD_ACTION_MARKS[action]
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
