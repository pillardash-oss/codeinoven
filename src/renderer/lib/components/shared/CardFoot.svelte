<script lang="ts">
  import type { Snippet } from 'svelte'

  interface Props {
    /**
     * The falsy side: cancel, reject, dismiss, remove, and the chat actions
     * that gather context. Narrower than the primary side, so it wraps first.
     */
    left?: Snippet
    /** The truthy side: the one action the card is asking for, always last. */
    right?: Snippet
    class?: string
  }

  let { left, right, class: className = '' }: Props = $props()
</script>

<!-- The design's card foot: falsy actions on the left, the truthy action on the
right, never a third place for an action to hide. -->
<div
  class="flex shrink-0 items-center gap-1.5 border-t border-border px-3 py-2 {className}"
  data-card-foot
>
  <div class="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
    {@render left?.()}
  </div>
  {#if right}
    <div class="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
      {@render right()}
    </div>
  {/if}
</div>
