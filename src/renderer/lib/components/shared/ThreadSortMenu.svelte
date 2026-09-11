<script lang="ts">
  import { DropdownMenu } from 'bits-ui'
  import { ArrowUpDown, Check } from '@lucide/svelte'
  import { threadSortState } from '$lib/stores/thread-sort.svelte'
  import type { ThreadSortMode } from '$lib/stores/workspace.svelte'

  const THREAD_SORT_OPTIONS: { id: ThreadSortMode; label: string }[] = [
    { id: 'default', label: 'Default' },
    { id: 'status', label: 'Status' },
    { id: 'time', label: 'Time' }
  ]

  const threadSortLabel = $derived(
    threadSortState.mode === 'status'
      ? 'Sort by status'
      : threadSortState.mode === 'time'
        ? 'Sort by time'
        : 'Default order'
  )
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger
    class="flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-elevated hover:text-foreground {threadSortState.mode ===
    'default'
      ? 'text-muted'
      : 'text-primary'}"
    aria-label="Sort threads"
    title="Sort threads   {threadSortLabel}"
  >
    <ArrowUpDown size={15} strokeWidth={1.8} />
  </DropdownMenu.Trigger>
  <DropdownMenu.Portal>
    <DropdownMenu.Content
      side="bottom"
      align="start"
      sideOffset={6}
      collisionPadding={8}
      class="z-50 w-44 overflow-hidden rounded-md border bg-surface p-1 shadow-lg"
    >
      {#each THREAD_SORT_OPTIONS as option (option.id)}
        {@const isSelected = threadSortState.mode === option.id}
        <DropdownMenu.Item
          class={[
            'flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none transition-colors',
            isSelected ? 'text-foreground' : 'text-muted hover:bg-elevated focus:bg-elevated'
          ]}
          onSelect={() => threadSortState.setMode(option.id)}
        >
          <span class="flex-1 truncate">{option.label}</span>
          {#if isSelected}
            <Check size={14} class="text-primary" />
          {/if}
        </DropdownMenu.Item>
      {/each}
    </DropdownMenu.Content>
  </DropdownMenu.Portal>
</DropdownMenu.Root>
