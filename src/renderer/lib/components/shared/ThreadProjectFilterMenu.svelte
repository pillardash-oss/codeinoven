<script lang="ts">
  import CioFilter from '@pdslng/cio-icon/CioFilter.svelte'
  import CioGrip from '@pdslng/cio-icon/CioGrip.svelte'
  import CioInbox from '@pdslng/cio-icon/CioInbox.svelte'
  import CioUndo from '@pdslng/cio-icon/CioUndo.svelte'
  import { ContextMenu } from 'bits-ui'
  import {
    THREAD_GROUP_ICONS,
    THREAD_GROUP_COLORS
  } from '$lib/components/threads/thread-group-presentation'
  import Switch from '$lib/components/ui/Switch.svelte'
  import { threadGroupingState, type ThreadGroup } from '$lib/stores/thread-grouping.svelte'
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

  /** The status rows in the order the sidebar draws them, so the menu the user
   *  rearranges is the list they are rearranging, not a second copy of it. */
  const orderedGroups = $derived(threadGroupingState.order)

  // ─── Arranging the inbox ─────────────────────────────────────────────────
  // The statuses are moved by dragging the row itself. The menu stays open across
  // the drag, and the sidebar behind it regroups the moment the drop lands: the
  // order is the store's, and every surface that draws the inbox reads it from
  // there, so nothing here has to be echoed to the list.

  /** The status currently held by the pointer, if any. */
  let draggedGroup = $state<ThreadGroup | null>(null)
  /** The row the pointer is over, and the edge the status would land on. */
  let dropTarget = $state<{ group: ThreadGroup; position: 'before' | 'after' } | null>(null)

  function beginGroupDrag(event: DragEvent, group: ThreadGroup): void {
    draggedGroup = group
    if (!event.dataTransfer) return
    event.dataTransfer.effectAllowed = 'move'
    // A private type keeps the reorder out of every text and file drop handler
    // that watches the document; the group itself is read from component state.
    event.dataTransfer.setData('application/x-cio-thread-group', group)
  }

  function hoverGroup(event: DragEvent, group: ThreadGroup): void {
    if (draggedGroup === null) return
    if (draggedGroup === group) {
      // Over the row being dragged there is no edge to land on, so the promise
      // the indicator made elsewhere is withdrawn instead of left behind.
      dropTarget = null
      return
    }
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    const row = event.currentTarget as HTMLElement
    const bounds = row.getBoundingClientRect()
    dropTarget = {
      group,
      position: event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after'
    }
  }

  function dropGroup(event: DragEvent, group: ThreadGroup): void {
    event.preventDefault()
    const dragged = draggedGroup
    const position = dropTarget?.group === group ? dropTarget.position : 'after'
    endGroupDrag()
    if (dragged === null || dragged === group) return
    threadGroupingState.moveGroup(dragged, group, position)
  }

  function endGroupDrag(): void {
    draggedGroup = null
    dropTarget = null
  }
</script>

<!-- Multi-select project switcher acting as the Threads view project filter.
     Empty selection = all projects; a subset shows its size on the badge. -->
<ProjectSwitch
  multiSelect
  selectedIds={threadProjectFilterState.selectedIds}
  onSelectionChange={(ids) => threadProjectFilterState.setSelection(ids)}
  ariaLabel={filterLabel}
  class="h-7 w-7 {filterActive ? 'text-primary' : 'text-muted'}"
>
  <span class="relative flex items-center justify-center">
    <CioFilter size={15} />
    {#if filterActive}
      <span
        class="absolute -top-1.5 -right-2 flex min-w-3 items-center justify-center bg-primary px-0.5 text-[0.5rem] font-semibold leading-3 tabular-nums text-on-primary"
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
      class="flex h-7 w-7 items-center justify-center transition-colors hover:bg-overlay {threadGroupingState.enabled ||
      inboxFilterActive
        ? 'text-primary'
        : 'text-muted'}"
      title={inboxLabel}
      aria-label={inboxLabel}
      aria-pressed={threadGroupingState.enabled}
      onclick={() => threadGroupingState.toggleEnabled()}
    >
      <span class="relative flex items-center justify-center">
        <CioInbox size={15} strokeWidth={1.8} />
        {#if inboxFilterActive}
          <span
            class="absolute -top-1.5 -right-2 flex min-w-3 items-center justify-center bg-primary px-0.5 text-[0.5rem] font-semibold leading-3 tabular-nums text-on-primary"
          >
            {inboxSelectedCount}
          </span>
        {/if}
      </span>
    </button>
  </ContextMenu.Trigger>
  <ContextMenu.Portal>
    <ContextMenu.Content class="z-60 min-w-64 border border-border bg-surface p-1 shadow-lg">
      <ContextMenu.Item
        class="flex items-center gap-2 px-2.5 py-2 outline-none transition-colors data-[highlighted]:bg-elevated"
        textValue="All"
        onSelect={(event) => {
          event.preventDefault()
          threadGroupingState.setAllVisible(!threadGroupingState.isAll)
        }}
      >
        <CioInbox size={12} class="shrink-0 text-muted" aria-hidden="true" />
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
      {#each orderedGroups as group (group)}
        {@const Icon = THREAD_GROUP_ICONS[group]}
        {@const edge = dropTarget?.group === group ? dropTarget.position : null}
        <div class="relative" class:opacity-45={draggedGroup === group}>
          <ContextMenu.Item
            class="flex cursor-grab items-center gap-2 px-2.5 py-2 outline-none transition-colors active:cursor-grabbing data-[highlighted]:bg-elevated"
            textValue={group}
            draggable="true"
            ondragstart={(event: DragEvent) => beginGroupDrag(event, group)}
            ondragover={(event: DragEvent) => hoverGroup(event, group)}
            ondrop={(event: DragEvent) => dropGroup(event, group)}
            ondragend={endGroupDrag}
            onSelect={(event) => {
              event.preventDefault()
              threadGroupingState.setVisible(group, !threadGroupingState.isVisible(group))
            }}
          >
            <span
              class="flex shrink-0 items-center text-dimmed"
              title="Drag to reorder the statuses"
              aria-hidden="true"
            >
              <CioGrip size={11} />
            </span>
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
          {#if edge}
            <!-- The edge the status will land on, drawn on the row it will land
                 beside: the sidebar draws the same order, so the line is a
                 promise, not a hint. -->
            <span
              class="pointer-events-none absolute inset-x-0 h-0.5 bg-primary {edge === 'before'
                ? 'top-0'
                : 'bottom-0'}"
              aria-hidden="true"
            ></span>
          {/if}
        </div>
      {/each}
      <div class="mx-1 my-1 border-t border-border" aria-hidden="true"></div>
      <ContextMenu.Item
        class="flex items-center gap-2 px-2.5 py-2 outline-none transition-colors data-[highlighted]:bg-elevated {threadGroupingState.isDefaultOrder
          ? 'pointer-events-none opacity-45'
          : ''}"
        textValue="Restore default order"
        disabled={threadGroupingState.isDefaultOrder}
        onSelect={(event) => {
          event.preventDefault()
          threadGroupingState.restoreDefaultOrder()
        }}
      >
        <CioUndo size={12} class="shrink-0 text-muted" aria-hidden="true" />
        <span class="min-w-0 flex-1 truncate text-xs font-medium">Restore default order</span>
      </ContextMenu.Item>
    </ContextMenu.Content>
  </ContextMenu.Portal>
</ContextMenu.Root>
