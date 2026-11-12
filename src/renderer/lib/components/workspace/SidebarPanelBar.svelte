<script module lang="ts">
  import type { Component } from 'svelte'
  import type { SidebarPanelAction } from '$lib/components/layout/SidebarActionStack.svelte'

  /** One tab in a panel bar: the surface it switches to, its mark, and the
   *  shortcut that reaches the same place from the keyboard. */
  export interface SidebarPanelTab {
    id: string
    label: string
    icon: Component
    /** Symbolic key tokens, drawn beside the label while there is room. */
    shortcut?: readonly string[]
    active: boolean
    select: () => void
  }

  /** The panel's own search, which replaces the tabs with its field while open. */
  export interface SidebarPanelSearch {
    open: boolean
    query: string
    placeholder: string
    ariaLabel: string
    loading?: boolean
    onOpenChange: (open: boolean) => void
    onQueryChange: (value: string) => void
  }
</script>

<script lang="ts">
  import CioSearch from '@pdslng/cio-icon/CioSearch.svelte'
  import SidebarActionStack from '$lib/components/layout/SidebarActionStack.svelte'
  import SidebarSearchBar from '$lib/components/layout/SidebarSearchBar.svelte'
  import { encodeShortcutTokens, formatKeyCombo } from '$lib/keymap/keymap'
  import type { Snippet } from 'svelte'

  interface Props {
    /** Accessible name of the tab row, e.g. "Projects and threads". */
    label: string
    tabs?: SidebarPanelTab[]
    search: SidebarPanelSearch
    /** The list's own actions, drawn above the tabs. */
    actions: SidebarPanelAction[]
    /** How far the list has scrolled, 0 to 1: the actions fold from their
     *  stacked shape into one line of marks. */
    progress?: number
    /** Keymap key tokens that open the search, so its button wears its chord. */
    searchShortcut?: readonly string[]
    /** What the search button says beside its mark, e.g. "Search projects". */
    searchLabel: string
    /** The search's own results, floated above the field while it is open. */
    results?: Snippet
  }

  let {
    label,
    tabs = [],
    search,
    actions,
    progress = 0,
    searchShortcut = [],
    searchLabel,
    results
  }: Props = $props()

  /** The search is the last action of the stack, so it folds with the rest. */
  const stackActions = $derived<SidebarPanelAction[]>([
    ...actions,
    {
      id: 'panel-search',
      label: searchLabel,
      icon: CioSearch,
      run: () => search.onOpenChange(true),
      shortcut: searchShortcut
    }
  ])
</script>

<!--
  The panel's foot: the actions for the list on screen, folded by the list's own
  scroll, above the tabs that switch which list it is.
-->
<div class="@container shrink-0 bg-surface px-2 pb-2" data-region="sidebar-panel-bar">
  {#if search.open}
    <div class="relative py-1.5">
      <SidebarSearchBar
        open
        query={search.query}
        placeholder={search.placeholder}
        ariaLabel={search.ariaLabel}
        loading={search.loading}
        onOpenChange={search.onOpenChange}
        onQueryChange={search.onQueryChange}
        shortcut={searchShortcut}
      />
      {#if results}
        <!-- The bar is the panel's foot, so the results open upward, over the
             list the search is narrowing. -->
        <div
          class="absolute inset-x-2 bottom-full z-30 mb-1 max-h-80 overflow-y-auto overscroll-contain border bg-surface p-1.5 shadow-lg"
        >
          {@render results()}
        </div>
      {/if}
    </div>
  {:else}
    <SidebarActionStack actions={stackActions} {progress} />
    {#if tabs.length > 0}
      <div class="mt-[2px] h-8">
        <div
          class="flex h-full min-w-0 items-center gap-1 border bg-surface p-1"
          role="tablist"
          aria-label={label}
        >
          {#each tabs as tab (tab.id)}
            {@const TabIcon = tab.icon}
            <button
              type="button"
              role="tab"
              aria-selected={tab.active}
              class="flex h-6 min-w-0 flex-1 items-center justify-center gap-1.5 px-2 text-[0.6875rem] font-medium transition-colors {tab.active
                ? 'bg-elevated text-foreground'
                : 'text-muted hover:text-foreground'}"
              title={tab.shortcut?.length
                ? `${tab.label} (${formatKeyCombo(tab.shortcut)})`
                : tab.label}
              aria-label={tab.label}
              data-shortcut={encodeShortcutTokens(tab.shortcut ?? [])}
              onclick={tab.select}
            >
              <TabIcon size={13} class="shrink-0" />
              <span class="truncate">{tab.label}</span>
              {#if tab.shortcut && tab.shortcut.length > 0}
                <kbd
                  class="hidden shrink-0 text-[0.625rem] tracking-wide text-dimmed @min-[21rem]:inline"
                  aria-hidden="true">{formatKeyCombo(tab.shortcut)}</kbd
                >
              {/if}
            </button>
          {/each}
        </div>
      </div>
    {/if}
  {/if}
</div>
