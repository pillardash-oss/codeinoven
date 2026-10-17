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
  /**
   * How the rail moves, for the states a reader can stand to watch.
   *
   * `fill` is live work: the rail lights from the bottom of its own box to the
   * top, gives the light back, and starts again, for as long as the state holds.
   * Only work that is running right now carries it. Every other state is
   * something to notice once and act on, so a still rail is the honest drawing of
   * it, and the row keeps the calm of a list that is not perpetually moving.
   *
   * The rail never changes height while it animates: the box is fixed and only
   * the light moves inside it, so the row and every row under it stay exactly
   * where they are, and the dashes keep their shape instead of stretching as the
   * light climbs them.
   */
  railMotion?: 'fill'

  /**
   * Whether the row draws this state's glyph above its rail.
   *
   * A filling rail already says the state by moving, so a glyph on top of it
   * would spend a whole row of height naming what the reader is watching happen.
   * The working mark drops it: the rail runs the height the glyph used to hold,
   * and the state's name moves onto the rail itself, which keeps its label and
   * its tooltip.
   *
   * A mark that keeps its glyph keeps it because the glyph says something neither
   * the colour nor the motion can. The running-elsewhere mark is the one that
   * does: its window says the run belongs to another instance, which is exactly
   * what a rail painted the same blue would hide.
   *
   * A secondary status always keeps the slot regardless (`THREAD_SECONDARY_MARKS`):
   * what is waiting on the thread is not what the rail is showing, so the glyph
   * above and the rail beneath can speak at the same time.
   */
  glyph?: boolean
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
    // Dashed and moving, the same dashes a draft thread's spine already wears: a
    // running thread's rail is a short column of them, never more than four, and
    // the light climbs it one whole dash at a time. `liveRailPaint` draws the grid
    // and the row steps the light up it.
    dash: 'dashed',
    railMotion: 'fill',
    glyph: false
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
  dash: 'dashed',
  // The work is live, so the rail fills here too; the window glyph stays,
  // because where the run lives is the whole reason this mark exists.
  railMotion: 'fill'
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
 * Whether a mark's rail lights from the bottom of its box to the top, one whole
 * dash at a time, over and over, for as long as the state holds.
 *
 * The row asks the mark rather than the thread's status string, so the motion a
 * reader sees and the vocabulary the rest of the app reads from cannot drift
 * apart: any surface drawing this mark draws a live rail with it.
 */
export function markRailFills(mark: ThreadStateMark): boolean {
  return mark.railMotion === 'fill'
}

/**
 * Whether the row draws the mark's glyph above the rail.
 *
 * Only live work hides its own glyph: a filling rail repeats the state every
 * cycle, so a glyph above it would cost a row of height to say the same thing
 * twice. `hasSecondary` wins over that, because a secondary status occupies the
 * glyph slot with something the rail cannot say (a queued message, a start after
 * another thread, a draft), and that is worth the height whatever the rail does.
 */
export function markDrawsGlyph(mark: ThreadStateMark, hasSecondary: boolean): boolean {
  return hasSecondary || mark.glyph !== false
}

/**
 * One dash of a rail, and the period it repeats over.
 *
 * A still rail wears fixed lengths, so every dashed rail in the list has the same
 * grain as every other one: a draft thread's spine and a retrying thread's are
 * drawn from the same two numbers.
 */
interface RailStripe {
  /** How much of each period a dashed rail paints. */
  dash: string
  /** One dash and the gap after it. */
  period: string
}

const RAIL_STRIPES: Record<'dashed' | 'dotted', RailStripe> = {
  dashed: { dash: '0.25rem', period: '0.4375rem' },
  dotted: { dash: '0.125rem', period: '0.25rem' }
}

/**
 * How a live rail is drawn: the same dash a still dashed rail wears (4px on, 3px
 * off), laid down as as many dashes as the rail's height has room for, and never
 * more than four however tall the row gets.
 *
 * The count follows the room, because the rail is as tall as its row and a row's
 * height is not ours to fix here: a rail that fits three dashes has no room for a
 * fourth, and squeezing one in is what leaves half dashes behind. The row measures
 * the rail and asks for the count, so every dash is a whole dash and the light that
 * climbs them lights one at a time.
 */
export const LIVE_RAIL = { dash: 4, gap: 3, maxDashes: 4 } as const

/**
 * How long one dash of a live rail stays lit before the next one lights, in
 * milliseconds.
 *
 * A cycle is this times the dash count, so the rhythm a reader follows is the same
 * on a short rail as on a tall one: one dash every beat, and the top dash handing
 * straight over to the bottom one.
 */
export const LIVE_RAIL_DASH_MS = 450

/**
 * How many dashes a live rail of this height has room for, at least one and never
 * more than `LIVE_RAIL.maxDashes`.
 *
 * A rail that has not been measured yet reports no height; that answers with the
 * most dashes, which is the shape a working row usually takes, so the first frame
 * is drawn where the row is going to land.
 */
export function liveRailDashCount(railHeight: number): number {
  if (!Number.isFinite(railHeight) || railHeight <= 0) return LIVE_RAIL.maxDashes
  const pitch = LIVE_RAIL.dash + LIVE_RAIL.gap
  return Math.min(
    LIVE_RAIL.maxDashes,
    Math.max(1, Math.floor((railHeight + LIVE_RAIL.gap) / pitch))
  )
}

/**
 * How much of a live rail's colour the resting track keeps, as a percentage.
 *
 * The track is what keeps a running thread's mark column whole: the spine holds
 * its full height and its shape between one lit dash and the next, instead of
 * leaving a gap where the light has not reached. Faint enough to sit behind the
 * light rather than compete with it, and mixed over transparency so it reads on
 * either theme.
 */
export const RAIL_TRACK_INK = 30

/** The rail's colour, mixed down to `ink` percent when a caller wants a track. */
function railInk(colour: string, ink: number | null): string {
  return ink === null ? colour : `color-mix(in srgb, ${colour} ${ink}%, transparent)`
}

/**
 * Paints one still rail: a mark's colour in the shape its dash names.
 *
 * `ink` mixes the colour down, which is how the track under a live rail is drawn.
 * Passing nothing paints the mark at full strength, which is what every still rail
 * wears.
 */
export function railPaint(mark: ThreadStateMark, ink: number | null = null): string {
  const colour = railInk(mark.colour, ink)
  const stripe = mark.dash === 'solid' ? null : RAIL_STRIPES[mark.dash]
  if (stripe === null) return colour
  return `repeating-linear-gradient(to bottom, ${colour} 0 ${stripe.dash}, transparent ${stripe.dash} ${stripe.period})`
}

/**
 * Paints one live rail: `count` dashes down the rail's box, in the mark's colour,
 * anchored at the bottom so the dash the light starts on is a whole dash.
 *
 * The dashes divide the box rather than being fixed lengths, which is the other
 * half of keeping them whole: the last dash ends exactly at the top of the rail
 * instead of stopping part way and leaving a stub. `count` comes from
 * `liveRailDashCount`, so the grid and the steps the light climbs it in always
 * agree.
 *
 * `ink` mixes the colour down for the track underneath, exactly as `railPaint`
 * does, so the dash that lights and the dash it lights on are the same dash.
 */
export function liveRailPaint(
  mark: ThreadStateMark,
  count: number,
  ink: number | null = null
): string {
  const colour = railInk(mark.colour, ink)
  const cell = 100 / count
  const dash = (cell * LIVE_RAIL.dash) / (LIVE_RAIL.dash + LIVE_RAIL.gap)
  return `repeating-linear-gradient(to top, ${colour} 0 ${dash}%, transparent ${dash}% ${cell}%)`
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
