<script lang="ts">
  import { Check, ExternalLink, Plus, Search } from '@lucide/svelte'
  import { Popover } from 'bits-ui'
  import { SvelteMap } from 'svelte/reactivity'
  import { utilityKindIcon, utilityKindLabel } from './utility-kind'
  import { connectionSourceLabel, type ConnectionLibraryEntry } from './connection-library'

  interface Props {
    /** Every connection the app can offer: registry utilities and discovered capabilities. */
    entries: ConnectionLibraryEntry[]
    /** Entries already connected, rendered as picked rather than addable. */
    connectedIds: ReadonlySet<string>
    disabled?: boolean
    /** Label for the trigger button. */
    label?: string
    /** Open the Utilities page so the user can add or configure a capability. */
    onOpenLibrary?: () => void
    onSelect: (entry: ConnectionLibraryEntry) => void
  }

  let {
    entries,
    connectedIds,
    disabled = false,
    label = 'Add a connection',
    onOpenLibrary,
    onSelect
  }: Props = $props()

  let open = $state(false)
  let query = $state('')
  /** Kind filter; `all` shows the whole library. */
  let kindFilter = $state('all')

  const kindCounts = $derived.by(() => {
    const counts = new SvelteMap<string, number>()
    for (const entry of entries) counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1)
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  })

  const filtered = $derived.by(() => {
    const needle = query.trim().toLowerCase()
    return entries.filter((entry) => {
      if (kindFilter !== 'all' && entry.kind !== kindFilter) return false
      if (!needle) return true
      return `${entry.name} ${entry.description} ${entry.kind} ${entry.keywords}`
        .toLowerCase()
        .includes(needle)
    })
  })

  const readyCount = $derived(entries.filter((entry) => entry.enabled).length)

  function pick(entry: ConnectionLibraryEntry): void {
    if (connectedIds.has(entry.id)) return
    onSelect(entry)
    open = false
    query = ''
    kindFilter = 'all'
  }
</script>

<Popover.Root
  bind:open
  onOpenChange={(next) => {
    if (!next) {
      query = ''
      kindFilter = 'all'
    }
  }}
>
  <Popover.Trigger
    class="flex w-full items-center gap-1.5 rounded-md border border-dashed border-border px-2.5 py-1.5 text-left text-[0.75rem] text-muted transition-colors hover:border-border-strong hover:bg-elevated hover:text-foreground disabled:cursor-default disabled:opacity-50"
    {disabled}
    title={label}
    aria-label={label}
  >
    <Plus size={13} strokeWidth={1.8} />
    <span class="truncate">{label}</span>
    {#if entries.length > 0}
      <span class="ml-auto shrink-0 text-[0.625rem] text-dimmed">{entries.length}</span>
    {/if}
  </Popover.Trigger>

  <Popover.Portal>
    <Popover.Content
      side="bottom"
      align="start"
      sideOffset={4}
      collisionPadding={12}
      class="z-90 flex w-[var(--bits-popover-anchor-width)] min-w-64 flex-col overflow-hidden rounded-xl border bg-surface shadow-lg"
      role="dialog"
      aria-label="Choose a connection from the utility library"
      tabindex={-1}
      onCloseAutoFocus={(event) => event.preventDefault()}
    >
      <div class="flex items-center gap-1.5 border-b border-border px-2.5 py-2">
        <Search size={12} strokeWidth={1.8} class="shrink-0 text-dimmed" />
        <input
          type="text"
          class="min-w-0 flex-1 bg-transparent text-[0.75rem] text-foreground outline-none placeholder:text-dimmed"
          placeholder="Search the library…"
          aria-label="Search the utility library"
          bind:value={query}
        />
        <span class="shrink-0 text-[0.625rem] text-dimmed">{readyCount}/{entries.length}</span>
      </div>

      {#if kindCounts.length > 1}
        <div class="flex flex-wrap gap-1 border-b border-border px-2.5 py-1.5">
          <button
            type="button"
            class="rounded-md px-1.5 py-0.5 text-[0.625rem] transition-colors {kindFilter === 'all'
              ? 'bg-elevated text-foreground'
              : 'text-dimmed hover:bg-elevated hover:text-foreground'}"
            aria-pressed={kindFilter === 'all'}
            onclick={() => (kindFilter = 'all')}
          >
            All {entries.length}
          </button>
          {#each kindCounts as [kind, count] (kind)}
            <button
              type="button"
              class="rounded-md px-1.5 py-0.5 text-[0.625rem] transition-colors {kindFilter === kind
                ? 'bg-elevated text-foreground'
                : 'text-dimmed hover:bg-elevated hover:text-foreground'}"
              aria-pressed={kindFilter === kind}
              onclick={() => (kindFilter = kind)}
            >
              {utilityKindLabel(kind)}
              {count}
            </button>
          {/each}
        </div>
      {/if}

      <div class="max-h-[22rem] overflow-y-auto p-1">
        {#if filtered.length === 0}
          <p class="px-2 py-3 text-center text-[0.6875rem] text-dimmed">
            {entries.length === 0
              ? 'No utilities installed yet.'
              : query.trim()
                ? 'No matching connections.'
                : 'Nothing in this kind.'}
          </p>
        {:else}
          {#each filtered as entry (entry.id)}
            {@const connected = connectedIds.has(entry.id)}
            {@const KindIcon = utilityKindIcon(entry.kind)}
            <button
              type="button"
              class="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors {connected
                ? 'cursor-default opacity-60'
                : 'hover:bg-elevated'}"
              title={connected ? `${entry.name} is already connected` : entry.description}
              aria-label={connected ? `${entry.name}, already connected` : `Connect ${entry.name}`}
              disabled={connected}
              onclick={() => pick(entry)}
            >
              <span
                class="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-elevated text-muted"
              >
                <KindIcon size={12} strokeWidth={1.8} />
              </span>
              <span class="min-w-0 flex-1">
                <span class="flex items-center gap-1.5">
                  <span class="min-w-0 flex-1 truncate text-[0.75rem] text-foreground">
                    {entry.name}
                  </span>
                  {#if !entry.enabled}
                    <span
                      class="shrink-0 rounded-md bg-elevated px-1.5 py-0.5 text-[0.5625rem] font-medium tracking-wide text-dimmed uppercase"
                    >
                      Off
                    </span>
                  {/if}
                  <span
                    class="shrink-0 rounded-md bg-elevated px-1.5 py-0.5 text-[0.5625rem] font-medium tracking-wide text-muted uppercase"
                  >
                    {connectionSourceLabel(entry.source)}
                  </span>
                </span>
                {#if entry.description}
                  <span class="mt-0.5 line-clamp-2 block text-[0.625rem] text-dimmed">
                    {entry.description}
                  </span>
                {/if}
              </span>
              {#if connected}
                <Check size={12} strokeWidth={2} class="mt-1 shrink-0 text-primary" />
              {/if}
            </button>
          {/each}
        {/if}
      </div>

      {#if onOpenLibrary}
        <button
          type="button"
          class="flex items-center gap-1.5 border-t border-border px-2.5 py-2 text-left text-[0.6875rem] text-muted transition-colors hover:bg-elevated hover:text-foreground"
          title="Open the Utilities page to install or configure a capability"
          aria-label="Open the Utilities page to install or configure a capability"
          onclick={() => {
            open = false
            onOpenLibrary?.()
          }}
        >
          <ExternalLink size={12} strokeWidth={1.8} />
          Manage utilities
        </button>
      {/if}
    </Popover.Content>
  </Popover.Portal>
</Popover.Root>
