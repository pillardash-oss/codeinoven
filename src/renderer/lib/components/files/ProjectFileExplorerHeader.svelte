<script lang="ts">
  import { ChevronsDown, ChevronsUp, FolderOpen, RefreshCw, Search } from '@lucide/svelte'

  interface Props {
    projectName: string
    explorerWidth: number
    resizing: boolean
    dropActive: boolean
    dropFolder: string | null
    anyDirExpanded: boolean
    treeBusy: boolean
    filterOpen: boolean
    rootLoading: boolean
    onStartResize: (event: PointerEvent) => void
    onResizeKeydown: (event: KeyboardEvent) => void
    onToggleExpandAll: () => void
    onToggleFilter: () => void
    onRefresh: () => void
  }

  let {
    projectName,
    explorerWidth,
    resizing,
    dropActive,
    dropFolder,
    anyDirExpanded,
    treeBusy,
    filterOpen,
    rootLoading,
    onStartResize,
    onResizeKeydown,
    onToggleExpandAll,
    onToggleFilter,
    onRefresh
  }: Props = $props()
</script>

<button
  type="button"
  class="absolute inset-y-0 -left-0.5 z-20 w-1.5 cursor-col-resize border-0 bg-transparent p-0 transition-colors hover:bg-primary/20 {resizing
    ? 'bg-primary/30'
    : ''}"
  tabindex="0"
  aria-label={`Resize file tree, ${explorerWidth} pixels wide`}
  title="Resize file tree"
  onpointerdown={onStartResize}
  onkeydown={onResizeKeydown}
></button>
{#if dropActive}
  <div
    class="pointer-events-none absolute inset-x-0 top-0 z-30 flex justify-center"
    aria-hidden="true"
  >
    <span
      class="mt-1.5 rounded-full bg-primary px-2.5 py-0.5 text-[0.625rem] font-medium text-on-primary shadow-lg"
      >{dropFolder ? `Drop into ${dropFolder || ''}` : 'Drop to import'}</span
    >
  </div>
{/if}
<div class="flex h-9 shrink-0 items-center gap-2 border-b border-border px-2">
  <FolderOpen size={13} class="shrink-0 text-primary" />
  <span class="min-w-0 flex-1 truncate text-[0.625rem] font-semibold text-foreground">
    {projectName}
  </span>
  <button
    type="button"
    class="flex h-7 w-7 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-50"
    aria-label={anyDirExpanded ? 'Collapse all folders' : 'Expand all folders'}
    title={anyDirExpanded ? 'Collapse all folders' : 'Expand all folders'}
    disabled={treeBusy}
    onclick={onToggleExpandAll}
  >
    {#if anyDirExpanded}
      <ChevronsUp size={12} />
    {:else}
      <ChevronsDown size={12} />
    {/if}
  </button>
  <button
    type="button"
    class={[
      'flex h-7 w-7 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground',
      filterOpen ? 'bg-elevated text-foreground' : ''
    ]}
    aria-label="Search project files"
    title="Search project files (Cmd/Ctrl+F)"
    aria-pressed={filterOpen}
    onclick={onToggleFilter}
  >
    <Search size={12} />
  </button>
  <button
    type="button"
    class="flex h-7 w-7 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-50"
    aria-label="Refresh project files"
    title="Refresh files"
    disabled={rootLoading}
    onclick={onRefresh}
  >
    <RefreshCw size={12} class={rootLoading ? 'animate-spin' : ''} />
  </button>
</div>
