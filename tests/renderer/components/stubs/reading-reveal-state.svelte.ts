/**
 * The shape of the owner's reveal work, as state.
 *
 * `revealContextUsage` folds the next reading over the one already on screen, so
 * it reads the state it then writes. That is fine on a click, and fatal inside an
 * effect: the effect re-triggers itself until Svelte raises
 * `effect_update_depth_exceeded`, which is exactly what the `/status` reading did
 * when the popover ran its owner's reveal from its own effect.
 */
let reveals = $state(0)

export const readingReveal = {
  get reveals(): number {
    return reveals
  },
  reveal(): void {
    reveals = reveals + 1
  }
}
