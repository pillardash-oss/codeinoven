import { tick } from 'svelte'

import type OvenControls from '../OvenControls.svelte'
import type { ThreadView } from './ThreadView-board.svelte'
/** One concern of the ThreadView board. */
export class ThreadViewOpenOvenPicker {
  #root: ThreadView | undefined
  /** The board this unit belongs to; set before any member of it runs. */
  get root(): ThreadView {
    if (!this.#root) throw new Error('ThreadViewOpenOvenPicker read its board before it was bound')
    return this.#root
  }
  constructor(root: ThreadView) {
    this.#root = root
  }
  /** Composer scope shoe data   project mode only (ChatComposer hides it in chat mode). */
  ovenControl: OvenControls | undefined = $state(undefined)

  async openOvenPicker(): Promise<void> {
    await import('../OvenControls.svelte')
    await tick()
    await this.ovenControl?.openPicker()
  }
}
