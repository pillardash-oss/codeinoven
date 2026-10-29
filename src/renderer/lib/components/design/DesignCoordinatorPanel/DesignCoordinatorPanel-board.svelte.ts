import { DesignBoardGallery } from './DesignCoordinatorPanel-gallery.svelte'
import { DesignBoardStudio } from './DesignCoordinatorPanel-studio.svelte'
import { DesignBoardHistoryActions } from './DesignCoordinatorPanel-history-actions.svelte'
import { DesignBoardMenus } from './DesignCoordinatorPanel-menus.svelte'
import { DesignBoardState } from './DesignCoordinatorPanel-state.svelte'
import { DesignBoardEffects } from './DesignCoordinatorPanel-effects.svelte'
import type { Props } from './DesignCoordinatorPanel-types'
/**
 * The DesignBoard board: one instance per concern, each holding this board.
 *
 * It is built during the component's own setup, so an `$effect` a unit registers
 * is owned by the component and tears down with it. A unit reads the props
 * through this board, so a prop that changes keeps every `$derived` live.
 */
export class DesignBoard {
  private readonly readProps: () => Props
  readonly gallery = new DesignBoardGallery(this)
  readonly studio = new DesignBoardStudio(this)
  readonly historyActions = new DesignBoardHistoryActions(this)
  readonly menus = new DesignBoardMenus(this)
  readonly state = new DesignBoardState(this)
  readonly effects = new DesignBoardEffects(this)
  constructor(readProps: () => Props) {
    this.readProps = readProps
    this.gallery.bindDesignState()
    this.effects.init()
  }
  get props(): Props {
    return this.readProps()
  }
}
/** Build the board from the surface props. */
export function createDesignBoard(readProps: () => Props): DesignBoard {
  return new DesignBoard(readProps)
}
