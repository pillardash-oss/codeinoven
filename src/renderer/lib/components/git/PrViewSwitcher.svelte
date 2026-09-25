<script lang="ts">
  import { Check, ChevronDown } from '@lucide/svelte'
  import { DropdownMenu } from 'bits-ui'
  import type { PrDetailTabId } from './pr-view'

  interface Props {
    /** The reader's views with their counts, from `pr-view.ts`. */
    views: Array<{ id: PrDetailTabId; label: string; icon: typeof Check; count: number }>
    active: PrDetailTabId
    onSelect: (id: PrDetailTabId) => void
  }

  let { views, active, onSelect }: Props = $props()

  const activeEntry = $derived(views.find((view) => view.id === active) ?? null)
</script>

<!--
  Which part of the pull request you are reading. The panel draws this in its
  action row, ahead of Pull and Push, because the sidebar has no room for a list
  of views of its own; the full screen reader lists them down its rail instead.
-->
<DropdownMenu.Root>
  <DropdownMenu.Trigger
    class="flex h-6 min-w-0 shrink cursor-pointer items-center gap-1 rounded-xs px-1.5 text-[0.625rem] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground data-[state=open]:bg-elevated data-[state=open]:text-foreground"
    title="Switch pull request view"
    aria-label="Switch pull request view"
  >
    {#if activeEntry}
      {@const ActiveIcon = activeEntry.icon}
      <ActiveIcon size={12} class="shrink-0" />
    {/if}
    <span class="min-w-0 truncate">{activeEntry?.label ?? 'View'}</span>
    <ChevronDown size={10} class="shrink-0 text-dimmed" />
  </DropdownMenu.Trigger>
  <DropdownMenu.Portal>
    <DropdownMenu.Content
      side="bottom"
      align="end"
      sideOffset={4}
      collisionPadding={8}
      class="z-90 w-44 overflow-hidden rounded-lg border border-border bg-surface p-1 shadow-lg"
    >
      {#each views as view (view.id)}
        {@const ViewIcon = view.icon}
        <DropdownMenu.Item
          class="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated"
          onSelect={() => onSelect(view.id)}
        >
          <ViewIcon size={12} class="shrink-0 text-dimmed" />
          <span class="min-w-0 flex-1 truncate">{view.label}</span>
          {#if view.count > 0}
            <span class="shrink-0 tabular-nums text-dimmed">{view.count}</span>
          {/if}
          {#if active === view.id}
            <Check size={12} class="shrink-0 text-primary" />
          {/if}
        </DropdownMenu.Item>
      {/each}
    </DropdownMenu.Content>
  </DropdownMenu.Portal>
</DropdownMenu.Root>
