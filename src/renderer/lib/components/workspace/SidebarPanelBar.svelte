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

  /** The panel's own search, which morphs out of its action button into a field
   *  over the tabs and rolls back into that button from the chevron. */
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
  import { encodeShortcutTokens, formatKeyCombo } from '$lib/keymap/keymap'
  import type { Snippet } from 'svelte'
  import SidebarSearchBar from '$lib/components/layout/SidebarSearchBar.svelte'

  interface Props {
    /** Accessible name of the tab row, e.g. "Projects and threads". */
    label: string
    tabs?: SidebarPanelTab[]
    search: SidebarPanelSearch
    /**
     * The list's own actions, drawn under the tabs. `compact` is the state the
     * row collapses into once the list is scrolled: one line of marks instead of
     * the stacked buttons that name themselves.
     */
    row?: Snippet<[compact: boolean]>
    /** Keymap key tokens that open the search, so its button wears its chord. */
    searchShortcut?: readonly string[]
    /** What the search button says beside its mark, e.g. "Search projects". */
    searchLabel: string
    /** Whether the list has been scrolled, which folds the actions to their marks. */
    compact?: boolean
  }

  let {
    label,
    tabs = [],
    search,
    row,
    searchShortcut = [],
    searchLabel,
    compact = false
  }: Props = $props()
</script>

<!--
  The panel's own bar: the tabs that switch which list it shows, the search, and
  the actions for the list on screen.

  At the top of the list the actions are stacked and name themselves. Once the
  list is scrolled they fold into one line of marks under the tabs, so the rows
  keep the room they were using. The search is one of those actions, never a
  fourth thing in the tab row.
-->
<div class="@container shrink-0 bg-surface" data-region="sidebar-panel-bar">
  {#if search.open}
    <div class="flex items-center gap-1 px-2 py-1.5">
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
    </div>
  {:else}
    {#if tabs.length > 0}
      <div class="px-2 pt-1.5 pb-1">
        <div
          class="flex min-w-0 items-center gap-1 border bg-surface p-1"
          role="tablist"
          aria-label={label}
        >
          {#each tabs as tab (tab.id)}
            {@const TabIcon = tab.icon}
            <button
              type="button"
              role="tab"
              aria-selected={tab.active}
              class="flex min-w-0 flex-1 items-center justify-center gap-1.5 px-2 py-1.5 text-[0.6875rem] font-medium transition-colors {tab.active
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

    <div
      class="panel-actions flex gap-1 px-2 pb-1.5 {compact
        ? 'panel-actions-compact items-center justify-center'
        : 'flex-col items-stretch'}"
    >
      {@render row?.(compact)}
      <button
        type="button"
        class="flex h-7 items-center gap-1.5 text-muted transition-colors hover:bg-elevated hover:text-foreground {compact
          ? 'w-7 justify-center'
          : 'w-full justify-start px-2 text-[0.6875rem] font-medium'}"
        aria-label={searchLabel}
        title={searchLabel}
        data-shortcut={encodeShortcutTokens(searchShortcut)}
        onclick={() => search.onOpenChange(true)}
      >
        <CioSearch size={compact ? 15 : 13} class="shrink-0" />
        {#if !compact}
          <span class="truncate">{searchLabel}</span>
        {/if}
      </button>
    </div>
  {/if}
</div>

<style>
  /* The actions fold from their stacked, self-naming shape into one line of
     marks under the tabs. A plain CSS animation keeps the switch off the main
     thread's transition machinery and works in a panel that is never measured. */
  .panel-actions-compact {
    animation: panel-actions-fold 140ms cubic-bezier(0.22, 1, 0.36, 1) both;
  }

  @keyframes panel-actions-fold {
    from {
      opacity: 0.4;
      transform: translateY(-4px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .panel-actions-compact {
      animation: none;
    }
  }
</style>
