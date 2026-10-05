<script lang="ts">
  import { Funnel, Inbox } from '@lucide/svelte'
  import { ContextMenu } from 'bits-ui'
  import {
    THREAD_GROUP_ICONS,
    THREAD_GROUP_COLORS
  } from '$lib/components/threads/thread-group-presentation'
  import Switch from '$lib/components/ui/Switch.svelte'
  import { THREAD_GROUPS, threadGroupingState } from '$lib/stores/thread-grouping.svelte'
  import ProjectSwitch from './ProjectSwitch.svelte'
  import { threadProjectFilterState } from '$lib/stores/thread-project-filter.svelte'

  const filterActive = $derived(!threadProjectFilterState.isAll)
  const selectedCount = $derived(threadProjectFilterState.selectedIds.length)
  const filterLabel = $derived(
    filterActive
      ? `Filter threads by project · ${selectedCount} project${selectedCount === 1 ? '' : 's'}`
      : 'Filter threads by project'
  )
  const inboxFilterActive = $derived(!threadGroupingState.isAll)
  const inboxSelectedCount = $derived(threadGroupingState.selectedCount)
  const inboxLabel = $derived(
    inboxFilterActive
      ? `Group threads by status · ${inboxSelectedCount} inbox${inboxSelectedCount === 1 ? '' : 'es'}`
      : 'Group threads by status'
  )
</script>

<!-- Multi-select project switcher acting as the Threads view project filter.
     Empty selection = all projects; a subset shows its size on the badge. -->
<ProjectSwitch
  multiSelect
  selectedIds={threadProjectFilterState.selectedIds}
  onSelectionChange={(ids) => threadProjectFilterState.setSelection(ids)}
  ariaLabel={filterLabel}
  class="h-7 w-7 rounded-md {filterActive ? 'text-primary' : 'text-muted'}"
>
  <span class="relative flex items-center justify-center">
    <Funnel size={15} strokeWidth={1.8} />
    {#if filterActive}
      <span
        class="absolute -top-1.5 -right-2 flex min-w-3 items-center justify-center rounded-full bg-primary px-0.5 text-[0.5rem] font-semibold leading-3 tabular-nums text-on-primary"
      >
        {selectedCount}
      </span>
    {/if}
  </span>
</ProjectSwitch>

<ContextMenu.Root>
  <ContextMenu.Trigger class="contents">
    <button
      type="button"
      class="flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-overlay {threadGroupingState.enabled ||
      inboxFilterActive
        ? 'text-primary'
        : 'text-muted'}"
      title={inboxLabel}
      aria-label={inboxLabel}
      aria-pressed={threadGroupingState.enabled}
      onclick={() => threadGroupingState.toggleEnabled()}
    >
      <span class="relative flex items-center justify-center">
        <Inbox size={15} strokeWidth={1.8} />
        {#if inboxFilterActive}
          <span
            class="absolute -top-1.5 -right-2 flex min-w-3 items-center justify-center rounded-full bg-primary px-0.5 text-[0.5rem] font-semibold leading-3 tabular-nums text-on-primary"
          >
            {inboxSelectedCount}
          </span>
        {/if}
      </span>
    </button>
  </ContextMenu.Trigger>
  <ContextMenu.Portal>
    <ContextMenu.Content
      class="z-60 min-w-64 rounded-xl border border-border bg-surface p-1 shadow-lg"
    >
      <ContextMenu.Item
        class="flex items-center gap-2 rounded-md px-2.5 py-2 outline-none transition-colors data-[highlighted]:bg-elevated"
        textValue="All"
        onSelect={(event) => {
          event.preventDefault()
          threadGroupingState.setAllVisible(!threadGroupingState.isAll)
        }}
      >
        <Inbox size={12} class="shrink-0 text-muted" aria-hidden="true" />
        <span class="min-w-0 flex-1 truncate text-xs font-medium">All</span>
        <span
          role="presentation"
          onclick={(event) => event.stopPropagation()}
          onkeydown={(event) => event.stopPropagation()}
        >
          <Switch
            checked={threadGroupingState.isAll}
            onchange={(visible) => threadGroupingState.setAllVisible(visible)}
            title="Show all inboxes"
            aria-label="Show all inboxes"
          />
        </span>
      </ContextMenu.Item>
      <div class="mx-1 my-1 border-t border-border" aria-hidden="true"></div>
      {#each THREAD_GROUPS as group (group)}
        <ContextMenu.Item
          class="flex items-center gap-2 rounded-md px-2.5 py-2 outline-none transition-colors data-[highlighted]:bg-elevated"
          textValue={group}
          onSelect={(event) => {
            event.preventDefault()
            threadGroupingState.setVisible(group, !threadGroupingState.isVisible(group))
          }}
        >
          {@const Icon = THREAD_GROUP_ICONS[group]}
          <Icon
            size={12}
            class="shrink-0"
            style={`color:${THREAD_GROUP_COLORS[group]}`}
            aria-hidden="true"
          />
          <span
            class="min-w-0 flex-1 truncate text-xs font-medium"
            style:color={THREAD_GROUP_COLORS[group]}>{group}</span
          >
          <span
            role="presentation"
            onclick={(event) => event.stopPropagation()}
            onkeydown={(event) => event.stopPropagation()}
          >
            <Switch
              checked={threadGroupingState.isVisible(group)}
              onchange={(visible) => threadGroupingState.setVisible(group, visible)}
              title={`Show ${group} inbox`}
              aria-label={`Show ${group} inbox`}
            />
          </span>
        </ContextMenu.Item>
      {/each}
    </ContextMenu.Content>
  </ContextMenu.Portal>
</ContextMenu.Root>
