import { APP_SLUG } from '$shared/brand'

const STORAGE_KEY = `${APP_SLUG}.prReaderRailWidth.v1`
/**
 * Rail width in px. Measured against the rail's own rows rather than guessed: the
 * composer's three review buttons need 272px, the conflict row 304px and the head
 * row 251px, while the widest meta row (a 21 character branch, the author, the age,
 * the change counts) needs 444px and 507px once a conflicts badge joins it. 480
 * leaves every control its whole label and all but the longest meta row uncut.
 */
const DEFAULT_WIDTH = 480
const MIN_WIDTH = 272
const MAX_WIDTH = 720
/** Never let the rail take so much of the window that the conversation is unusable. */
const CONVERSATION_MIN_WIDTH = 360

function clampRailWidth(width: number): number {
  if (typeof window === 'undefined') return DEFAULT_WIDTH
  const viewportMaximum = Math.max(MIN_WIDTH, window.innerWidth - CONVERSATION_MIN_WIDTH)
  return Math.min(Math.max(Math.round(width), MIN_WIDTH), Math.min(MAX_WIDTH, viewportMaximum))
}

function loadRailWidth(): number {
  if (typeof window === 'undefined') return DEFAULT_WIDTH
  try {
    const stored = Number.parseInt(window.localStorage.getItem(STORAGE_KEY) ?? '', 10)
    if (Number.isFinite(stored)) return clampRailWidth(stored)
  } catch {
    // Storage unavailable. The default width is still perfectly usable.
  }
  return clampRailWidth(DEFAULT_WIDTH)
}

/**
 * Width of the full screen pull request reader's right rail.
 *
 * It lives outside the component because the component is mounted twice, once in
 * the dock and once full screen, and one shared value stops either mount from
 * restoring a stale width over the other. It is read at module scope, so the rail
 * paints its remembered width on the first frame instead of snapping to it after
 * mount.
 */
class PrReaderRailState {
  width = $state(loadRailWidth())
  /** True while the handle is being dragged or keyed, for the handle's own styling. */
  resizing = $state(false)

  /**
   * Applies a width, persisting every real change rather than only the end of a
   * drag: a drag released outside the window, or a reader closed mid drag, must
   * not lose the width the user just chose.
   */
  set(width: number): void {
    const next = clampRailWidth(width)
    if (next === this.width) return
    this.width = next
    this.persist()
  }

  persist(): void {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(STORAGE_KEY, String(this.width))
    } catch {
      // A remembered width is optional; unavailable storage must not break the rail.
    }
  }
}

export const prReaderRailState = new PrReaderRailState()
