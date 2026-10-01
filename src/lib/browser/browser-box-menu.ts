/**
 * The vocabulary of the thread browser's native box menu.
 *
 * A box is a named cookie jar, and the profile's list of them lives in the
 * renderer, so the entries travel with the call that opens the menu: main turns
 * them into OS menu items and answers with the box id one of them was picked
 * for. Both sides read this shape, the way the browser library's snapshots are
 * read, so the two cannot disagree about what a menu row is.
 */

/** One selectable box: its jar id, and the name to show for it. */
export interface BrowserBoxMenuEntry {
  id: string
  name: string
}

/**
 * What the menu was answered with, or null when it was dismissed.
 *
 * A chosen `null` box is the conversation scope's own jar, which is the menu's
 * first entry and where every scope starts. Every other value is the jar of one
 * of the entries that was offered.
 */
export interface BrowserBoxMenuChoice {
  boxId: string | null
}

/** The entries one menu may carry. The renderer's own ceiling on the profile's
 *  boxes is lower; this only bounds a call main cannot take on trust. */
export const MAX_BROWSER_BOX_MENU_ENTRIES = 50

/** Everything one call to open the menu carries. */
export interface BrowserBoxMenuInput {
  /** The name of the scope's own jar. It heads the menu, and main spells out
   *  that the entry is the conversation's own jar rather than a box the profile
   *  happens to name the same way. */
  scopeLabel: string
  /** The profile's boxes to offer, in the order they are listed. */
  boxes: BrowserBoxMenuEntry[]
  /** The box the tab on screen runs in, marked as the current one. */
  currentBoxId: string | null
}
