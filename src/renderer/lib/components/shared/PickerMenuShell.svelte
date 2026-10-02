<script lang="ts">
  import type { Snippet } from 'svelte'
  import { Search, X } from '@lucide/svelte'
  let {
    query = $bindable(''),
    menuEl = $bindable<HTMLDivElement | undefined>(),
    label,
    placeholder,
    autofocusSearch = false,
    onSearchInput,
    onSearchKeydown,
    children
  }: {
    query?: string
    menuEl?: HTMLDivElement
    label: string
    placeholder: string
    autofocusSearch?: boolean
    onSearchInput: (input: HTMLInputElement) => void
    onSearchKeydown: (event: KeyboardEvent) => void
    children: Snippet
  } = $props()
  let searchInput: HTMLInputElement | undefined
  function menuField(node: HTMLDivElement): () => void {
    menuEl = node
    return () => {
      if (menuEl === node) menuEl = undefined
    }
  }
  function searchField(node: HTMLInputElement): void {
    searchInput = node
    onSearchInput(node)
    if (autofocusSearch) node.focus()
  }
</script>

<div
  {@attach menuField}
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
      {placeholder}
      aria-label={placeholder}
      onkeydown={onSearchKeydown}
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
        }}><X size={12} /></button
      >
    {/if}
  </div>
  <div class="max-h-60 overflow-y-auto">{@render children()}</div>
</div>
