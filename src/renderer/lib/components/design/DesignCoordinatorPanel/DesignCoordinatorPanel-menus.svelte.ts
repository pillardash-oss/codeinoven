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
  menus = $state({ sort: false, options: false, card: false })

  menuOpen = $derived(this.menus.sort || this.menus.options || this.menus.card)
}
