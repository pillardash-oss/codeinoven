import type { DesignBoard } from './DesignCoordinatorPanel-board.svelte'
import { BoardUnit } from '$lib/components/board-unit'
/** One concern of the DesignBoard board. */
export class DesignBoardMenus extends BoardUnit<DesignBoard> {
  constructor(root: DesignBoard) {
    super(root)
  }
  /**
   * The board's own menus, so the pane can step aside while one of them is
   * showing.
   *
   * A menu opens downward over the composition, and a native view is composited
   * above every DOM node, so a menu cannot be raised above the page: the page has
   * to come off screen for as long as the menu is up. That is the same answer a
   * modal gives, which is why every root here is watched rather than only the one
   * the user happened to open first.
   */
  menus = $state({ list: false, sort: false, options: false })

  /**
   * The screen whose card menu is open, `null` when none is.
   *
   * Every card is its own menu root, so this remembers the one the user actually
   * opened instead of a single flag every card would read: a flag shared by all
   * roots opens the menu of every screen at once, and only the one under the
   * pointer lands at the pointer while the rest fall back to the top-left corner.
   */
  cardMenuEntry = $state<string | null>(null)

  menuOpen = $derived(
    this.menus.list || this.menus.sort || this.menus.options || this.cardMenuEntry !== null
  )

  /**
   * Keep the card menu on one screen: opening a card replaces whatever card menu
   * was up, and only a close that belongs to the open card clears it. A stale
   * close from the previously open card must not tear down the one now showing.
   */
  setCardMenu(entry: string, open: boolean): void {
    if (open) {
      this.cardMenuEntry = entry
      return
    }
    if (this.cardMenuEntry === entry) this.cardMenuEntry = null
  }
}
