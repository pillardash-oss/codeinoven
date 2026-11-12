<script module lang="ts">
  import type { Component } from 'svelte'

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

  /** The panel's own search, which morphs out of its button into a field over
   *  the tabs and rolls back into that button from the chevron. */
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
  import { encodeShortcutTokens, formatKeyCombo } from '$lib/keymap/keymap'
  import type { Snippet } from 'svelte'
  import SidebarSearchBar from '$lib/components/layout/SidebarSearchBar.svelte'

  interface Props {
    /** Accessible name of the tab row, e.g. "Projects and threads". */
    label: string
    tabs?: SidebarPanelTab[]
    search: SidebarPanelSearch
    /** The action row under the tabs, owned by the panel that draws the list. */
    row?: Snippet
    /** Keymap key tokens that open the search, so its button wears its chord. */
    searchShortcut?: readonly string[]
    /** Text beside the search mark on its closed button. */
    searchLabel?: string
  }

  let {
    label,
    tabs = [],
    search,
    row,
    searchShortcut = [],
    searchLabel = undefined
  }: Props = $props()
</script>

<!--
  The panel's own bar: the tabs that switch which list it shows, the search that
  morphs over them with the tools that belong to it, and the actions for the list
  on screen.

  The tabs wear the app's one tab shape: equal shares of the row, centred text,
  and the current tab filled. They are drawn above the list's scroller rather than
  inside it, so they stay put while the rows move. Labels give way before the
  marks do, and a narrow panel keeps the tab marks' text truncated.
-->
<div class="@container shrink-0 bg-surface" data-region="sidebar-panel-bar">
  <div class="flex min-w-0 items-center gap-1 px-2 py-1.5">
    {#if search.open}
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
    {:else}
      {#if tabs.length > 0}
        <div
          class="flex min-w-0 flex-1 items-center gap-1 border bg-surface p-1"
          role="tablist"
          aria-label={label}
        >
          {#each tabs as tab (tab.id)}
            {@const TabIcon = tab.icon}
            <button
              type="button"
              role="tab"
              aria-selected={tab.active}
              class="flex min-w-0 flex-1 items-center justify-center gap-1.5 px-3 py-1.5 text-sm font-medium transition-colors {tab.active
                ? 'bg-elevated text-foreground'
                : 'text-muted hover:text-foreground'}"
              title={tab.shortcut?.length
                ? `${tab.label} (${formatKeyCombo(tab.shortcut)})`
                : tab.label}
              aria-label={tab.label}
              data-shortcut={encodeShortcutTokens(tab.shortcut ?? [])}
              onclick={tab.select}
            >
              <TabIcon size={15} class="shrink-0" />
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
      {/if}
      <div
        class="flex min-w-0 items-center gap-0.5 {tabs.length > 0
          ? 'ml-auto shrink-0'
          : 'flex-1 justify-center'}"
      >
        <SidebarSearchBar
          open={false}
          query={search.query}
          placeholder={search.placeholder}
          ariaLabel={search.ariaLabel}
          loading={search.loading}
          onOpenChange={search.onOpenChange}
          onQueryChange={search.onQueryChange}
          shortcut={searchShortcut}
          label={searchLabel}
        />
      </div>
    {/if}
  </div>

  {#if row}
    <!-- The list's own controls, centred under the tabs: their text is the
         control, so a row of them reads as one set rather than a toolbar. -->
    <div class="flex items-center justify-center gap-1 px-2 pb-1.5">
      {@render row()}
    </div>
  {/if}
</div>
