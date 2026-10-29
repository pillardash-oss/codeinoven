import { AppOnKeydown } from './App-on-keydown.svelte'
import { AppSpotlightPalette } from './App-spotlight-palette.svelte'
import { AppOpenAssistantFromSearch } from './App-open-assistant-from-search.svelte'
import { AppUpdateConfig } from './App-update-config.svelte'
import { AppSettleCloseConfirmationThread } from './App-settle-close-confirmation-thread.svelte'
import { AppState } from './App-state.svelte'
import { AppEffects } from './App-effects.svelte'
/**
 * The App board: one instance per concern, each holding this board.
 *
 * It is built during the component's own setup, so an `$effect` a unit registers
 * is owned by the component and tears down with it. A unit reads the props
 * through this board, so a prop that changes keeps every `$derived` live.
 */
export class App {
  readonly onKeydown = new AppOnKeydown(this)
  readonly spotlightPalette = new AppSpotlightPalette(this)
  readonly openAssistantFromSearch = new AppOpenAssistantFromSearch(this)
  readonly updateConfig = new AppUpdateConfig(this)
  readonly settleCloseConfirmationThread = new AppSettleCloseConfirmationThread(this)
  readonly state = new AppState(this)
  readonly effects = new AppEffects(this)
  constructor() {
    this.effects.init()
  }
}
/** Build the board from the surface props. */
export function createApp(): App {
  return new App()
}
