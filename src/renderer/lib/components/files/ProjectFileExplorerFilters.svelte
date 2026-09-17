<script lang="ts">
  import { FileDiff, GitMerge, Search, X } from '@lucide/svelte'
  import Switch from '../ui/Switch.svelte'

  interface Props {
    filterOpen: boolean
    filterQuery: string
    includeCio: boolean
    lastTurnOnly: boolean
    lastTurnCount: number
    lastTurnDisabled: boolean
    conflictsOnly: boolean
    conflictCount: number
    showConflicts: boolean
    onFilterInputElement: (element: HTMLInputElement | null) => void
    onFilterInput: (event: Event) => void
    onCloseFilter: () => void
    onToggleCio: (checked: boolean) => void
    onToggleLastTurn: () => void
    onToggleConflicts: () => void
  }

  let {
    filterOpen,
    filterQuery,
    includeCio,
    lastTurnOnly,
    lastTurnCount,
    lastTurnDisabled,
    conflictsOnly,
    conflictCount,
    showConflicts,
    onFilterInputElement,
    onFilterInput,
    onCloseFilter,
    onToggleCio,
    onToggleLastTurn,
    onToggleConflicts
  }: Props = $props()

  let filterInput = $state<HTMLInputElement | null>(null)

  $effect(() => {
    onFilterInputElement(filterInput)
    return () => onFilterInputElement(null)
  })
</script>

{#if filterOpen}
  <div
    class="absolute left-2 right-2 top-7 z-20 rounded-xl border border-border bg-surface shadow-xl"
    role="search"
    aria-label="Search project files"
  >
    <div class="flex items-center border-b border-border px-2.5 py-1">
      <Switch
        checked={includeCio}
        label="Toggle .cio visibility"
        class="text-[0.625rem] font-semibold text-dimmed"
        title="Include the .cio directory in search results"
        aria-label="Include the .cio directory in search results"
        onchange={onToggleCio}
      />
    </div>
    <div class="flex items-center gap-1 p-1.5">
      <Search size={13} class="shrink-0 text-dimmed" />
      <input
        bind:this={filterInput}
        type="search"
        class="h-7 min-w-0 flex-1 rounded-lg bg-app px-2 text-[0.6875rem] text-foreground outline-none placeholder:text-dimmed"
        placeholder="Search files and folders…"
        value={filterQuery}
        oninput={onFilterInput}
        onkeydown={(event: KeyboardEvent) => event.key === 'Escape' && onCloseFilter()}
      />
      <button
        type="button"
        class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-dimmed hover:bg-elevated hover:text-foreground"
        aria-label="Close file search"
        title="Close file search (Escape)"
        onclick={onCloseFilter}
      >
        <X size={12} />
      </button>
    </div>
  </div>
{/if}

<div class="shrink-0 border-b border-border p-2">
  <button
    type="button"
    class={[
      'mt-1.5 flex h-7 w-full items-center gap-1.5 rounded border px-2 text-[0.625rem] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40',
      lastTurnOnly
        ? 'border-primary/40 bg-primary/10 text-primary'
        : 'border-border text-muted hover:bg-elevated hover:text-foreground'
    ]}
    aria-label="Filter files changed in the last turn"
    aria-pressed={lastTurnOnly}
    title="Show only files changed in the last completed turn"
    disabled={lastTurnDisabled}
    onclick={onToggleLastTurn}
  >
    <FileDiff size={12} />
    <span class="flex-1 text-left">Last turn</span>
    <span class="tabular-nums text-dimmed">{lastTurnCount}</span>
  </button>
  {#if showConflicts}
    <button
      type="button"
      class={[
        'mt-1.5 flex h-7 w-full items-center gap-1.5 rounded border px-2 text-[0.625rem] font-medium transition-colors',
        conflictsOnly
          ? 'border-warning/40 bg-warning/10 text-warning'
          : 'border-border text-muted hover:bg-elevated hover:text-foreground'
      ]}
      aria-label="Filter files that need conflict resolution"
      aria-pressed={conflictsOnly}
      title="Show only files that still need conflict resolution"
      onclick={onToggleConflicts}
    >
      <GitMerge size={12} />
      <span class="flex-1 text-left">Conflicts</span>
      <span class="tabular-nums text-dimmed">{conflictCount}</span>
    </button>
  {/if}
</div>
