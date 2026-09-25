<script lang="ts">
  import type { PrState } from '$shared/types'

  interface Props {
    state: PrState
    onSelect: (next: PrState) => void
  }

  let { state, onSelect }: Props = $props()

  // The same chips appear in the Git panel's action row and in the full screen
  // reader's own list row, where the list draws its controls itself. Keeping
  // them in one component avoids two copies drifting apart.
  const states: Array<{ id: PrState; label: string }> = [
    { id: 'open', label: 'Open' },
    { id: 'closed', label: 'Closed' },
    { id: 'all', label: 'All' }
  ]
</script>

{#each states as option (option.id)}
  <button
    type="button"
    class="h-6 shrink-0 cursor-pointer rounded-md px-2 text-[0.625rem] font-medium transition-colors {state ===
    option.id
      ? 'bg-elevated text-foreground'
      : 'text-muted hover:text-foreground'}"
    aria-pressed={state === option.id}
    onclick={() => onSelect(option.id)}
  >
    {option.label}
  </button>
{/each}
