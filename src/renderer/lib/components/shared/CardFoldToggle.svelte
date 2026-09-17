<script lang="ts">
  import { ChevronDown } from '@lucide/svelte'

  interface Props {
    /**
     * Whether the card is folded away (its body hidden). Bindable so the owning
     * card can gate its own body and footer on the same state.
     */
    folded?: boolean
    /** Card name used for the control's title and accessible label. */
    label: string
    /** Compact variant for the smaller composer-attached stacks. */
    compact?: boolean
    class?: string
  }

  let { folded = $bindable(false), label, compact = false, class: className = '' }: Props = $props()
</script>

<!-- Header control that folds a composer card down to its header row, mirroring
the agent task card: the card stays identifiable, only its body is hidden. The
chevron points down while expanded (fold away) and up while folded (expand
back), never sideways, so it never reads as a "next" affordance. -->
<button
  type="button"
  class={[
    'flex shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted transition-colors hover:bg-elevated hover:text-foreground',
    compact ? 'h-6 w-6' : 'h-8 w-8',
    className
  ]}
  aria-expanded={!folded}
  aria-label="{folded ? 'Expand' : 'Fold'} {label}"
  title="{folded ? 'Expand' : 'Fold'} {label}"
  onclick={() => (folded = !folded)}
>
  <ChevronDown
    size={compact ? 13 : 15}
    class="shrink-0 transition-transform {folded ? 'rotate-180' : ''}"
  />
</button>
