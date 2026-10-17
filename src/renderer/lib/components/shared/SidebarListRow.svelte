<script lang="ts">
  import { fade } from 'svelte/transition'
  import { listRowArrive } from '$lib/motion'
  import type { Snippet } from 'svelte'

  /**
   * One row on a sidebar list's reflow grid.
   *
   * The list's `ListRowReflow` finds rows by `data-row-key` and reads their boxes
   * before and after an arrangement change. A list that draws a bare row
   * therefore cannot travel, and a new list author will not remember to add the
   * attribute. Wrapping every row here writes the key and plays the arrival fade
   * from one place, so a row that is listed is a row that can move.
   *
   * The fade is opacity only, deliberately: the reflow reads each row's box back
   * to animate it, and a transform animating through a `fly` would be read as the
   * row's position, so an arriving row would hand the next move a starting point
   * it never had. A row that is only fading is exactly where its box says it is.
   */
  interface Props {
    /** Stable identity of the row, written verbatim as `data-row-key`. */
    rowKey: string
    /** When the row's record was created. */
    createdAt: number
    /** When the list first painted. A row created after this is an arrival. */
    attachedAt: number
    children: Snippet
  }

  let { rowKey, createdAt, attachedAt, children }: Props = $props()
</script>

<div data-row-key={rowKey} in:fade={createdAt > attachedAt ? listRowArrive() : { duration: 0 }}>
  {@render children()}
</div>
