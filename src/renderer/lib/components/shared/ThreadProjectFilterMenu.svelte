<script lang="ts">
  import { FolderKanban } from '@lucide/svelte'
  import ProjectSwitch from './ProjectSwitch.svelte'
  import { threadProjectFilterState } from '$lib/stores/thread-project-filter.svelte'

  const filterActive = $derived(!threadProjectFilterState.isAll)
  const selectedCount = $derived(threadProjectFilterState.selectedIds.length)
  const filterLabel = $derived(
    filterActive
      ? `Filter threads by project · ${selectedCount} project${selectedCount === 1 ? '' : 's'}`
      : 'Filter threads by project'
  )
</script>

<!-- Multi-select project switcher acting as the Threads view project filter.
     Empty selection = all projects; a subset shows its size on the badge. -->
<ProjectSwitch
  multiSelect
  selectedIds={threadProjectFilterState.selectedIds}
  onSelectionChange={(ids) => threadProjectFilterState.setSelection(ids)}
  ariaLabel={filterLabel}
  class="h-6 w-6 rounded-md {filterActive ? 'text-primary' : 'text-muted'}"
>
  <span class="relative flex items-center justify-center">
    <FolderKanban size={14} />
    {#if filterActive}
      <span
        class="absolute -top-1.5 -right-2 flex min-w-3 items-center justify-center rounded-full bg-primary px-0.5 text-[0.5rem] font-semibold leading-3 tabular-nums text-on-primary"
      >
        {selectedCount}
      </span>
    {/if}
  </span>
</ProjectSwitch>
