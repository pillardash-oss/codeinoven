<script lang="ts">
  import CioClose from '@pdslng/cio-icon/CioClose.svelte'
  import CioKeyboard from '@pdslng/cio-icon/CioKeyboard.svelte'
  import CioSearch from '@pdslng/cio-icon/CioSearch.svelte'
  import { KEYMAP, isMacPlatform, keymapKeyGroups } from '$lib/keymap/keymap'
  import { filterKeymapCategories } from '$lib/keymap/keymap-search'
  import { keymapState } from '$lib/keymap/keymap-state.svelte'

  const isMac = isMacPlatform()
  const totalShortcuts = KEYMAP.categories.reduce((total, category) => {
    return total + category.shortcuts.length
  }, 0)

  let query = $state('')

  const matchedCategories = $derived(
    filterKeymapCategories(KEYMAP.categories, query, {
      keysFor: (id) => keymapState.keysFor(id),
      isMac
    })
  )
  const matchCount = $derived(
    matchedCategories.reduce((total, category) => total + category.shortcuts.length, 0)
  )
  const isSearching = $derived(query.trim().length > 0)
</script>

<div class="pb-24">
  <div class="px-6 pt-6">
    <h1 class="flex items-center gap-2 text-xl font-bold tracking-tight">
      <CioKeyboard size={18} class="text-muted" />
      Keymap
    </h1>
    <p class="mt-0.5 text-sm text-muted">
      {#if isSearching}
        {matchCount} of {totalShortcuts} keyboard shortcuts match “{query.trim()}”.
      {:else}
        {totalShortcuts} keyboard shortcuts across the app.
      {/if}
    </p>
  </div>

  <!-- Pinned so the field stays reachable while the list scrolls under it. -->
  <div class="sticky top-0 z-20 mt-4 border-b border-border bg-app px-6 pb-3">
    <label class="relative block">
      <span class="sr-only">Search keyboard shortcuts</span>
      <CioSearch
        size={15}
        class="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-dimmed"
        aria-hidden="true"
      />
      <input
        type="search"
        bind:value={query}
        placeholder="Search shortcuts by name, action, or keys…"
        class="w-full border bg-surface py-2 pr-8 pl-9 text-sm text-foreground outline-none transition-colors placeholder:text-dimmed focus:border-primary"
      />
      {#if query}
        <button
          type="button"
          class="absolute top-1/2 right-2 flex h-6 w-6 -translate-y-1/2 items-center justify-center text-dimmed hover:bg-overlay hover:text-foreground"
          title="Clear search"
          aria-label="Clear search"
          onclick={() => (query = '')}><CioClose size={13} aria-hidden="true" /></button
        >
      {/if}
    </label>
  </div>

  <div class="px-6 pt-4">
    {#if matchedCategories.length === 0}
      <p class="border border-border bg-surface p-4 text-sm text-muted">
        No shortcuts match “{query.trim()}”. Try a shorter search, or a key name like “command
        palette”.
      </p>
    {:else}
      {#each matchedCategories as category (category.id)}
        <section class="mb-7">
          <h2
            class="mb-2 border-b border-border pb-2 text-[0.625rem] font-semibold tracking-wide text-dimmed uppercase"
          >
            {category.label}
          </h2>
          <div class="space-y-1.5">
            {#each category.shortcuts as shortcut (shortcut.id)}
              {@const keyGroups = keymapKeyGroups(keymapState.keysFor(shortcut.id), isMac)}
              <div
                class="flex items-start justify-between gap-4 border border-border bg-surface p-3"
              >
                <div class="min-w-0 flex-1">
                  <p class="text-sm font-medium text-foreground">{shortcut.label}</p>
                  <p class="mt-0.5 text-xs leading-relaxed text-muted">{shortcut.description}</p>
                  <p class="mt-1 text-[0.6875rem] text-dimmed">When: {shortcut.scenario}</p>
                </div>
                <div class="flex shrink-0 items-center gap-1 pt-0.5">
                  {#if keyGroups.length === 0}
                    <span class="text-[0.6875rem] text-dimmed">Unbound</span>
                  {:else}
                    {#each keyGroups as group, index (index)}
                      <kbd
                        class="inline-flex h-6 min-w-6 items-center justify-center border border-border bg-elevated px-1.5 font-mono text-[0.6875rem] leading-none text-foreground"
                      >
                        {group}
                      </kbd>
                      {#if index < keyGroups.length - 1}
                        <span class="text-[0.625rem] text-dimmed">/</span>
                      {/if}
                    {/each}
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        </section>
      {/each}
    {/if}
  </div>
</div>
