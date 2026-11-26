<script lang="ts">
  import CioCheck from '@pdslng/cio-icon/CioCheck.svelte'
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

<BottomSheet {open} {title} {onClose}>
  <div class="p-1.5">
    {#each items as item (item.label)}
      {#if item.divider}
        <div class="mx-2 my-1.5 h-px bg-border"></div>
      {:else if item.header}
        <div
          class="truncate px-3 pt-1.5 pb-0.5 text-[0.625rem] font-semibold tracking-wide text-dimmed uppercase"
        >
          {item.label}
        </div>
      {:else if item.children}
        <!-- A sheet has no hover menu to open sideways, so a submenu becomes a
             caption naming the group followed by its entries. -->
        <div
          class="truncate px-3 pt-1.5 pb-0.5 text-[0.625rem] font-semibold tracking-wide text-dimmed uppercase"
        >
          {item.label}
        </div>
        {#each item.children as child (child.label)}
          {#if child.divider}
            <div class="mx-2 my-1.5 h-px bg-border"></div>
          {:else}
            <button
              type="button"
              class="flex w-full cursor-pointer items-center gap-3 px-3 py-3 text-left text-[0.9375rem] transition-colors active:bg-elevated disabled:cursor-not-allowed disabled:opacity-40 {child.danger
                ? 'text-danger'
                : 'text-foreground'}"
              disabled={child.disabled}
              onclick={() => select(child)}
            >
              {#if child.icon}
                {@const Icon = child.icon}
                <Icon size={17} class={child.danger ? '' : 'text-muted'} />
              {/if}
              <span class="min-w-0 flex-1 truncate text-left">{child.label}</span>
              {#if child.selected}
                <CioCheck size={17} class="shrink-0 text-primary" />
              {/if}
            </button>
          {/if}
        {/each}
      {:else}
        <button
          type="button"
          class="flex w-full cursor-pointer items-center gap-3 px-3 py-3 text-left text-[0.9375rem] transition-colors active:bg-elevated disabled:cursor-not-allowed disabled:opacity-40 {item.danger
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
            <CioCheck size={17} class="shrink-0 text-primary" />
          {/if}
        </button>
      {/if}
    {/each}
  </div>
</BottomSheet>
