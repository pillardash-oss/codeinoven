import { SvelteMap } from 'svelte/reactivity'

/**
 * Scroll memory for conversation surfaces.
 *
 * The workspace keeps a thread mounted while the reader moves between views, so
 * a thread's viewport has to survive a remount. Remembering it is its own
 * concern, and the map lives here rather than inside a component so every
 * conversation surface shares one store instead of allocating its own.
 */

export interface ThreadScrollState {
  top: number
  /** Whether the user was scrolled away from the bottom when saved. */
  awayFromBottom: boolean
}

/** Persists each thread's scroll position across component remounts. */
export const threadScrollPositions = new SvelteMap<string, ThreadScrollState>()
