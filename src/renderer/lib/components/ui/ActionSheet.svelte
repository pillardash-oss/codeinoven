<script lang="ts">
  import { Check } from '@lucide/svelte'
  import type { MenuItem } from '$lib/components/shared/ThreadDropdown.svelte'
  import BottomSheet from './BottomSheet.svelte'

  interface Props {
    open: boolean
    title?: string
    items: MenuItem[]
    onClose: () => void
  }

  let { open, title = 'Actions', items, onClose }: Props = $props()

  function select(item: MenuItem): void {
    onClose()
    item.onClick?.()
  }
</script>

<BottomSheet {open} {title} {onClose} maxHeight="max-h-[70dvh]">
  <div class="p-1.5">
    {#each items as item (item.label)}
      {#if item.divider}
        <div class="mx-2 my-1.5 h-px bg-border"></div>
      {:else}
        <button
          type="button"
          class="flex w-full cursor-pointer items-center gap-3 rounded-xl px-3 py-3 text-left text-[15px] transition-colors active:bg-elevated disabled:cursor-not-allowed disabled:opacity-40 {item.danger
            ? 'text-danger'
            : 'text-foreground'}"
          disabled={item.disabled}
          onclick={() => select(item)}
        >
          {#if item.icon}
            {@const Icon = item.icon}
            <Icon size={17} class={item.danger ? '' : 'text-muted'} />
          {/if}
          <span class="min-w-0 flex-1 truncate text-left">{item.label}</span>
          {#if item.selected}
            <Check size={17} class="shrink-0 text-primary" />
          {/if}
        </button>
      {/if}
    {/each}
  </div>
</BottomSheet>
