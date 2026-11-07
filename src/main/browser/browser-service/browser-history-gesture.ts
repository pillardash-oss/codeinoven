/**
 * The one rule that decides whether a gesture walks a page's history.
 *
 * Every surface that can ask for browser history ends up here: a page-side
 * observer reports what it saw, and `classifyHistoryGesture` alone says whether
 * that was a swipe. Keeping the rule out of the page is the point. A page can
 * only describe the delta stream it received, and a Logitech tilt wheel with
 * smooth scrolling produces a stream identical to a fine trackpad scroll, so a
 * page that decided for itself walked history on every tilt. What separates the
 * two devices is not the shape of the stream but inertia, which macOS reports
 * only for a scroll whose fingers have lifted. This module states that, and the
 * page is reduced to reporting facts.
 */

export type HistoryDirection = 'back' | 'forward'

/** Everything the page saw in one gesture, with no verdict of its own. */
export interface HistoryGestureFacts {
  /** The page's running number for this gesture, so repeats are recognisable. */
  gesture: number
  /** When the gesture's first event arrived, on the machine's clock. */
  startedAt: number
  /** Total horizontal travel, negative towards previous entries. */
  horizontal: number
  /** Total vertical travel, always positive. */
  vertical: number
  /** The OS reported inertial momentum during this gesture. */
  momentum: boolean
  /** Steps that arrived detent-sized, or as an exact repeat after a detent gap. */
  wheelDetents: number
  /** Wheel events the gesture contained. */
  events: number
  /** The page could pan on its own where the gesture started. */
  pageOwns: boolean
}

/** Horizontal travel that makes a gesture a swipe rather than a wobble. */
const SWIPE_TRAVEL_PX = 140
/** A swipe is horizontal; a page panning vertically is never taken for one. */
const HORIZONTAL_RATIO = 2
/** Frames a real swipe spends covering the distance a wheel covers in a few. */
const MIN_SWIPE_EVENTS = 4
/** Detents that make a gesture a wheel, not a swipe. */
const WHEEL_DETENTS = 2

/**
 * The verdict, or null when the gesture belongs to the page.
 *
 * `platform` is the reported platform of this process. macOS reports a momentum
 * phase and is decided by it alone; Windows and Linux report none at all, so
 * there a tick-based wheel is recognised by its detents instead.
 */
export function classifyHistoryGesture(
  facts: HistoryGestureFacts,
  platform: NodeJS.Platform
): HistoryDirection | null {
  if (facts.pageOwns) return null
  const horizontal = Math.abs(facts.horizontal)
  if (!Number.isFinite(horizontal) || horizontal < SWIPE_TRAVEL_PX) return null
  if (horizontal < facts.vertical * HORIZONTAL_RATIO) return null
  if (platform === 'darwin') {
    // Inertia is the one thing a wheel cannot produce.
    if (!facts.momentum) return null
  } else {
    if (facts.wheelDetents >= WHEEL_DETENTS) return null
    if (facts.events < MIN_SWIPE_EVENTS) return null
  }
  return facts.horizontal < 0 ? 'back' : 'forward'
}

/** A report from a page, accepted only when every fact is of the right type. */
export function readHistoryGestureFacts(value: unknown): HistoryGestureFacts | null {
  if (!value || typeof value !== 'object') return null
  const report = value as Partial<Record<keyof HistoryGestureFacts, unknown>>
  const gesture = report.gesture
  const startedAt = report.startedAt
  const horizontal = report.horizontal
  const vertical = report.vertical
  const wheelDetents = report.wheelDetents
  const events = report.events
  if (typeof gesture !== 'number' || !Number.isFinite(gesture)) return null
  if (typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return null
  if (typeof horizontal !== 'number' || !Number.isFinite(horizontal)) return null
  if (typeof vertical !== 'number' || !Number.isFinite(vertical)) return null
  if (typeof wheelDetents !== 'number' || !Number.isFinite(wheelDetents)) return null
  if (typeof events !== 'number' || !Number.isFinite(events)) return null
  if (typeof report.momentum !== 'boolean') return null
  if (typeof report.pageOwns !== 'boolean') return null
  return {
    gesture,
    startedAt,
    horizontal,
    vertical,
    momentum: report.momentum,
    wheelDetents,
    events,
    pageOwns: report.pageOwns
  }
}
