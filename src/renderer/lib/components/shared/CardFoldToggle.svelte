<script lang="ts">
  import CioChevronDown from 'cio-icon/CioChevronDown.svelte'
  interface Props {
    /**
     * Whether the card is folded away (its body hidden). Bindable so the owning
     * card can gate its own body and footer on the same state.
     */
    folded?: boolean
    /** Card name used for the control's title and accessible label. */
    label: string
    class?: string
  }

  let { folded = $bindable(false), label, class: className = '' }: Props = $props()
</script>

<!-- Header control that folds a composer card down to its header row, mirroring
the design's fold: a 1.5rem square at the far right of the head. The chevron
points down while expanded (fold away) and up while folded (expand back), never
sideways, so it never reads as a "next" affordance. -->
<button
  type="button"
  class="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center text-muted transition-colors hover:bg-elevated hover:text-foreground {className}"
  aria-expanded={!folded}
  aria-label="{folded ? 'Expand' : 'Fold'} {label}"
  title="{folded ? 'Expand' : 'Fold'} {label}"
  onclick={() => (folded = !folded)}
>
  <CioChevronDown size={14} class="shrink-0 transition-transform {folded ? 'rotate-180' : ''}" />
</button>
