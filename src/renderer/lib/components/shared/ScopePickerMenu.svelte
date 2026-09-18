<script lang="ts">
  /**
   * The scope chooser panel shared by the composer shoe and the Assignment
   * worker scope picker, so both surfaces offer the exact same menu. This
   * component renders only the panel: positioning, the click-away overlay and
   * any creation modal belong to the caller.
   */
  import { onMount } from 'svelte'
  import { FolderTree, Search, X } from '@lucide/svelte'
  import { pickColorForSeed } from '$lib/project-colors'
  import { scopeState } from '$lib/stores/scope.svelte'
  import type { ScopeBucket, ScopeChoice } from '$shared/types'

  interface ScopePickerTarget {
    /** Bucket the `inherit` choice resolves to, when it is known on the board. */
    bucket?: ScopeBucket
    /** Name shown on the inherit row when the bucket is not on the board. */
    fallbackName: string
    /** Trailing hint on the inherit row, e.g. "Inherited". */
    hint: string
    /** Label for the auto-create row, e.g. "New worktree for this worker". */
    createLabel: string
    /** Trailing hint on the auto-create row, e.g. "At dispatch". */
    createHint: string
    /** Tooltip on the auto-create row. Carries the explanation the short label
     *  cannot, so the accessible name stays exactly the visible label. */
    createTitle: string
  }

  interface Props {
    projectId: string
    target: ScopePickerTarget
    /** The choice currently tracked, so its row is the checked radio. */
    value: ScopeChoice
    /** True while the caller is already creating something for this picker. */
    busy?: boolean
    /** Focus the search field on mount. */
    autofocusSearch?: boolean
    label: string
    onSelect: (choice: ScopeChoice) => void
    /** Opens the full scope creation form; the CALLER owns that modal. */
    onCreateScope: () => void
    onClose: () => void
  }

  let {
    projectId,
    target,
    value,
    busy = false,
    autofocusSearch = false,
    label,
    onSelect,
    onCreateScope,
    onClose
  }: Props = $props()

  let query = $state('')
  let searchInput: HTMLInputElement | undefined = $state(undefined)

  let inheritName = $derived(target.bucket?.name ?? target.fallbackName)
  let inheritColor = $derived(
    target.bucket ? bucketColor(target.bucket) : pickColorForSeed(target.fallbackName)
  )

  /** Ordered board buckets for the project, minus the inherit scope, search-filtered. */
  let otherBuckets = $derived(
    (scopeState.boards.get(projectId)?.buckets ?? [])
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .filter((candidate) => {
        if (target.bucket && candidate.id === target.bucket.id) return false
        const q = query.trim().toLocaleLowerCase()
        if (!q) return true
        return candidate.name.toLocaleLowerCase().includes(q)
      })
  )

  let noMatch = $derived(otherBuckets.length === 0 && query.trim().length > 0)

  function bucketColor(candidate: ScopeBucket): string {
    return candidate.color ?? pickColorForSeed(candidate.id)
  }

  function openCreateScope(): void {
    onClose()
    onCreateScope()
  }

  /**
   * Hold the search field and, when the caller asked for it, focus it. An
   * attachment runs as the field enters the DOM, so the focus lands on the same
   * frame the menu appears instead of a tick later.
   */
  function searchField(node: HTMLInputElement): void {
    searchInput = node
    if (autofocusSearch) node.focus()
  }

  onMount(() => {
    void scopeState.ensureBoardLoaded(projectId)
  })
</script>

<div
  class="w-72 overflow-hidden rounded-xl border bg-surface p-1.5 shadow-lg"
  role="menu"
  aria-label={label}
>
  <div class="flex items-center gap-2 rounded-lg border bg-elevated px-2.5 py-1.5">
    <Search size={13} class="shrink-0 text-dimmed" />
    <input
      {@attach searchField}
      bind:value={query}
      type="text"
      class="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-dimmed"
      placeholder="Search scopes…"
      aria-label="Search scopes"
    />
    {#if query}
      <button
        type="button"
        class="shrink-0 text-dimmed transition-colors hover:text-foreground"
        aria-label="Clear search"
        title="Clear search"
        onclick={() => {
          query = ''
          searchInput?.focus()
        }}
      >
        <X size={12} />
      </button>
    {/if}
  </div>

  <div class="max-h-60 overflow-y-auto">
    <!-- Inherited scope for this picker's caller -->
    <button
      type="button"
      class="mt-1 flex w-full items-center gap-2 rounded-lg border-l-2 bg-raised px-2.5 py-1.5 text-left text-xs text-foreground"
      style:border-left-color={inheritColor}
      title={`Inherited scope: ${inheritName}`}
      aria-label={`Inherited scope: ${inheritName}`}
      role="menuitemradio"
      aria-checked={value.mode === 'inherit'}
      onclick={() => onSelect({ mode: 'inherit' })}
    >
      {#if target.bucket?.root.kind === 'worktree'}
        <FolderTree size={12} class="shrink-0 text-warning" />
      {/if}
      <span class="min-w-0 flex-1 truncate">{inheritName}</span>
      <span class="shrink-0 text-[0.625rem] text-dimmed">{target.hint}</span>
    </button>

    <span
      class="mt-1 block px-2.5 py-1 text-[0.5625rem] font-semibold tracking-wide text-dimmed uppercase"
      >Create</span
    >
    <button
      type="button"
      class="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-elevated disabled:opacity-50"
      title={target.createTitle}
      aria-label={target.createLabel}
      role="menuitemradio"
      aria-checked={value.mode === 'dedicated'}
      disabled={busy}
      onclick={() => onSelect({ mode: 'dedicated' })}
    >
      <span class="min-w-0 flex-1">{target.createLabel}</span>
      <span class="shrink-0 text-[0.625rem] text-dimmed">{target.createHint}</span>
    </button>
    <button
      type="button"
      class="flex w-full items-center rounded-lg px-2.5 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-elevated"
      title="Open the full scope creation form"
      aria-label="Create a scope"
      onclick={openCreateScope}
    >
      Create a scope…
    </button>

    <span
      class="mt-1 block px-2.5 py-1 text-[0.5625rem] font-semibold tracking-wide text-dimmed uppercase"
      >Other scopes</span
    >
    {#each otherBuckets as candidate (candidate.id)}
      <button
        type="button"
        class="flex w-full items-center gap-2 rounded-lg border-l-2 px-2.5 py-1.5 text-left text-xs text-muted transition-colors hover:bg-elevated hover:text-foreground"
        style:border-left-color={bucketColor(candidate)}
        title={candidate.name}
        aria-label={`Use scope: ${candidate.name}`}
        role="menuitemradio"
        aria-checked={value.mode === 'scope' && value.bucketId === candidate.id}
        onclick={() => onSelect({ mode: 'scope', bucketId: candidate.id })}
      >
        {#if candidate.root.kind === 'worktree'}
          <FolderTree size={12} class="shrink-0 text-warning" />
        {/if}
        <span class="min-w-0 flex-1 truncate">{candidate.name}</span>
      </button>
    {:else}
      <p class="px-2.5 py-3 text-center text-[0.625rem] text-dimmed">
        {noMatch ? 'No other scopes match' : 'No other scopes'}
      </p>
    {/each}
  </div>
</div>
