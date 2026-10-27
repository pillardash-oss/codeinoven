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
right, never a third place for an action to hide. -->
<div
  class="flex shrink-0 items-center gap-1.5 border-t border-border px-3 py-2 {className}"
  data-card-foot
>
  <div
    class="flex min-w-0 items-center gap-1.5 {yields === 'right' ? 'shrink-0' : 'flex-1 flex-wrap'}"
  >
    {@render left?.()}
  </div>
  {#if right}
    <div
      class="flex min-w-0 flex-wrap items-center justify-end gap-1.5 {yields === 'right'
        ? 'flex-1'
        : 'shrink-0'}"
    >
      {@render right()}
    </div>
  {/if}
</div>
