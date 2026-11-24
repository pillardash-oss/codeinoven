<script lang="ts">
  import type { Snippet } from 'svelte'

  interface Props {
    /**
     * The falsy side: cancel, reject, dismiss, remove, and the chat actions
     * that gather context.
     */
    left?: Snippet
    /** The truthy side: the one action the card is asking for, always last. */
    right?: Snippet
    /**
     * Which side gives way when the foot runs out of room.
     *
     * `left` (default) lets the falsy actions wrap, the shape a foot with a
     * long reading on the left wants: a stepper, a sentence, a note.
     *
     * `right` pins the falsy actions to one row and takes the room from the
     * truthy side instead, where a model picker truncates its own labels. A
     * card whose foot carries a picker uses this, so its Dismiss and Raw Error
     * buttons never stack into a column beside a control that can shorten.
     */
    yields?: 'left' | 'right'
    class?: string
  }

  let { left, right, yields = 'left', class: className = '' }: Props = $props()
</script>

<!-- The design's card foot: falsy actions on the left, the truthy action on the
right, never a third place for an action to hide.

Neither side may paint over the other. Each side keeps at least its widest
button (`min-w-min`) and wraps its own buttons when the room runs out, and the
row itself wraps so the truthy side drops to a line of its own instead of
eating the falsy side to nothing. The falsy side is laid out with
`flex: 1 1 min-content`, so its share of the row is the narrowest it can be
without clipping a button: the row wraps before either side is squeezed. -->
<div
  class="flex shrink-0 flex-wrap items-center gap-1.5 border-t border-border px-3 py-2 {className}"
  data-card-foot
>
  <div
    class="flex items-center gap-1.5 {yields === 'right'
      ? 'min-w-0 shrink-0'
      : 'min-w-min flex-[1_1_min-content] flex-wrap'}"
  >
    {@render left?.()}
  </div>
  {#if right}
    <div
      class="ml-auto flex flex-wrap items-center justify-end gap-1.5 {yields === 'right'
        ? 'min-w-0 flex-1'
        : 'min-w-min'}"
    >
      {@render right()}
    </div>
  {/if}
</div>
