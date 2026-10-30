import { tick } from 'svelte'

import type OvenControls from '../OvenControls.svelte'
import type { ThreadView } from './ThreadView-board.svelte'
import { BoardUnit } from '$lib/components/board-unit'
/** One concern of the ThreadView board. */
export class ThreadViewOpenOvenPicker extends BoardUnit<ThreadView> {
  constructor(root: ThreadView) {
    super(root)
  }
  /** Composer scope shoe data   project mode only (ChatComposer hides it in chat mode). */
  ovenControl: OvenControls | undefined = $state(undefined)

  async openOvenPicker(): Promise<void> {
    await import('../OvenControls.svelte')
    await tick()
    await this.ovenControl?.openPicker()
  }
}
