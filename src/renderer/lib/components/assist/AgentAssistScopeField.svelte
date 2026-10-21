<script lang="ts">
  import CioChevronDown from '@pdslng/cio-icon/CioChevronDown.svelte'
  import CioFolderGit from '@pdslng/cio-icon/CioFolderGit.svelte'
  import ScopeBadge from '../shared/ScopeBadge.svelte'
  import { Popover } from 'bits-ui'
  import { onMount } from 'svelte'
  import PickerMenuShell from '../shared/PickerMenuShell.svelte'
  import { scopeState } from '$lib/stores/scope.svelte'
  import type { ScopeBucket } from '$shared/types'

  /**
   * The scope a confirmed agent handoff runs in.
   *
   * Reached from surfaces that are not a composer (a pull request, a failing
   * deployment, an issue), so it cannot assume a current thread's scope. The
   * rows are the project's board plus the one checkout the action can prepare
   * for itself, which is the review checkout's whole point.
   *
   * The menu is portaled: this field sits in a scrolling modal body, and an
   * inline popover would be clipped by the panel instead of drawn over it.
   */
  interface Props {
    projectId: string
    /** Bucket to run in; null means the fresh isolated checkout. */
    value: string | null
    /** Name of the fresh checkout row, shown only when the action offers one. */
    newCheckoutLabel?: string
    onSelect: (bucketId: string | null) => void
  }

  let { projectId, value, newCheckoutLabel, onSelect }: Props = $props()

  let open = $state(false)
  let query = $state('')
  let menuEl: HTMLDivElement | undefined = $state(undefined)

  let buckets = $derived(
    (scopeState.boards.get(projectId)?.buckets ?? [])
      .filter((bucket) => !bucket.archivedAt)
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .filter((bucket) =>
        bucket.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
      )
  )
  let selected = $derived(
    value === null
      ? null
      : (scopeState.boards.get(projectId)?.buckets.find((bucket) => bucket.id === value) ?? null)
  )
  let label = $derived(
    value === null ? (newCheckoutLabel ?? 'Choose a scope') : (selected?.name ?? 'Choose a scope')
  )
  let detail = $derived(
    value === null
      ? 'New isolated checkout'
      : selected?.root.kind === 'worktree'
        ? selected.root.branch
        : 'Project directory'
  )

  onMount(() => {
    void scopeState.ensureBoardLoaded(projectId)
  })

  function choose(bucketId: string | null): void {
    onSelect(bucketId)
    open = false
  }

  function bucketHint(bucket: ScopeBucket): string {
    return bucket.root.kind === 'worktree' ? 'Worktree' : 'Project directory'
  }
</script>

<Popover.Root bind:open onOpenChange={(next) => (query = next ? '' : query)}>
  <Popover.Trigger
    class="flex w-full min-w-0 items-center gap-2 border bg-elevated px-3 py-2 text-left text-xs transition-colors hover:bg-overlay"
    title="Scope the agent runs in: {label}"
    aria-label="Scope the agent runs in: {label}"
  >
    {#if selected}
      <ScopeBadge bucket={selected} variant="mark" size="sm" showIcon />
    {:else}
      <CioFolderGit size={13} class="shrink-0 text-warning" />
      <span class="min-w-0 flex-1 truncate text-xs text-foreground">{label}</span>
    {/if}
    <span class="flex-1"></span>
    <span class="shrink-0 text-[0.625rem] text-dimmed">{detail}</span>
    <CioChevronDown size={11} class="shrink-0 text-dimmed" />
  </Popover.Trigger>
  <Popover.Portal>
    <Popover.Content
      side="bottom"
      align="start"
      sideOffset={4}
      collisionPadding={12}
      class="z-90"
      onOpenAutoFocus={(event) => event.preventDefault()}
    >
      <PickerMenuShell
        bind:query
        bind:menuEl
        label="Choose a scope for the agent"
        placeholder="Search scopes…"
        autofocusSearch
        onSearchInput={() => undefined}
        onSearchKeydown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            menuEl?.querySelector<HTMLButtonElement>('[data-scope-row]')?.focus()
          }
          if (event.key === 'Escape') {
            event.stopPropagation()
            open = false
          }
        }}
      >
        {#if newCheckoutLabel}
          <button
            type="button"
            data-scope-row="checkout"
            class="mt-1 flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-elevated focus:bg-elevated focus:outline-none"
            title="Create a fresh isolated checkout for this run"
            aria-label="New isolated checkout"
            role="menuitemradio"
            aria-checked={value === null}
            onclick={() => choose(null)}
          >
            <CioFolderGit size={12} class="shrink-0 text-warning" />
            <span class="min-w-0 flex-1 truncate">New isolated checkout</span>
            <span class="shrink-0 text-[0.625rem] text-dimmed">Isolated</span>
          </button>
        {/if}
        <span
          class="mt-1 block px-2.5 py-1 text-[0.5625rem] font-semibold tracking-wide text-dimmed uppercase"
          >Project scopes</span
        >
        {#each buckets as bucket (bucket.id)}
          <button
            type="button"
            data-scope-row={bucket.id}
            class="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-muted transition-colors hover:bg-elevated hover:text-foreground focus:bg-elevated focus:text-foreground focus:outline-none"
            title={`Use ${bucket.name}`}
            aria-label={`Use scope: ${bucket.name}`}
            role="menuitemradio"
            aria-checked={value === bucket.id}
            onclick={() => choose(bucket.id)}
          >
            <ScopeBadge {bucket} variant="mark" size="sm" showIcon />
            <span class="flex-1"></span>
            <span class="max-w-32 shrink-0 truncate text-[0.625rem] text-dimmed"
              >{bucketHint(bucket)}</span
            >
          </button>
        {:else}
          <p class="px-2.5 py-3 text-center text-[0.625rem] text-dimmed">
            {query.trim() ? 'No matching scopes' : 'No scopes yet'}
          </p>
        {/each}
      </PickerMenuShell>
    </Popover.Content>
  </Popover.Portal>
</Popover.Root>
