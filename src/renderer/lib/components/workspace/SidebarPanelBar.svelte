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
  import CioChevronUp from '@pdslng/cio-icon/CioChevronUp.svelte'
  import CioSearch from '@pdslng/cio-icon/CioSearch.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import { ICON_SIZE } from '$lib/components/icons/cio/scale'
  import { encodeShortcutTokens, formatKeyCombo } from '$lib/keymap/keymap'
  import type { Attachment } from 'svelte/attachments'
  import type { Snippet } from 'svelte'

  interface Props {
    /** Accessible name of the tab row, e.g. "Projects and threads". */
    label: string
    tabs?: SidebarPanelTab[]
    search: SidebarPanelSearch
    /** Extra controls beside the search button, e.g. the new-chat door. */
    trailing?: Snippet
    /** The action row under the tabs, owned by the panel that draws the list. */
    row?: Snippet
    /** Keymap key tokens that open the search, so its button wears its chord. */
    searchShortcut?: readonly string[]
  }

  let { label, tabs = [], search, trailing, row, searchShortcut = [] }: Props = $props()

  // The field takes the focus the moment it exists: the user asked for the
  // search, so their next keystroke belongs in it.
  const focusField: Attachment<HTMLInputElement> = (element) => {
    element.focus()
  }

  let searchButton: HTMLButtonElement | undefined = $state(undefined)

  /** The chevron rolls the field back into the button it came from, so the
   *  pointer lands where the search was rather than nowhere. */
  function collapse(): void {
    search.onOpenChange(false)
    searchButton?.focus()
  }
</script>

<!--
  The panel's own bar: the tabs that switch which list it shows, the search that
  morphs over them, and the actions for the list on screen.

  It is drawn above the list's scroller rather than inside it, so the tabs and
  the actions stay put while the rows move. Labels give way before the buttons
  do: the row is a container, and a narrow sidebar keeps the marks alone.
-->
<div class="@container shrink-0 border-b border-border bg-surface" data-region="sidebar-panel-bar">
  <div class="grid h-10 items-stretch">
    {#if !search.open}
      <div class="col-start-1 row-start-1 flex min-w-0 items-center gap-0.5 px-1.5">
        {#if tabs.length > 0}
          <div class="flex min-w-0 items-center gap-0.5" role="tablist" aria-label={label}>
            {#each tabs as tab (tab.id)}
              {@const TabIcon = tab.icon}
              <button
                type="button"
                role="tab"
                aria-selected={tab.active}
                class="flex min-w-0 items-center gap-1.5 px-2 py-1.5 transition-colors duration-150 {tab.active
                  ? 'bg-elevated text-foreground'
                  : 'text-muted hover:bg-elevated hover:text-foreground'}"
                title={tab.shortcut?.length
                  ? `${tab.label} (${formatKeyCombo(tab.shortcut)})`
                  : tab.label}
                aria-label={tab.label}
                data-shortcut={encodeShortcutTokens(tab.shortcut ?? [])}
                onclick={tab.select}
              >
                <TabIcon size={ICON_SIZE.row} class="shrink-0" />
                <span class="hidden truncate text-[0.6875rem] font-medium @min-[15rem]:inline"
                  >{tab.label}</span
                >
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
        <div class="ml-auto flex shrink-0 items-center gap-0.5">
          <button
            bind:this={searchButton}
            type="button"
            class="flex h-7 w-7 items-center justify-center text-muted transition-colors hover:bg-elevated hover:text-foreground"
            aria-label={search.ariaLabel}
            title={search.ariaLabel}
            data-shortcut={encodeShortcutTokens(searchShortcut)}
            onclick={() => search.onOpenChange(true)}
          >
            <CioSearch size={ICON_SIZE.row} />
          </button>
          {@render trailing?.()}
        </div>
      </div>
    {:else}
      <div
        class="panel-search-layer col-start-1 row-start-1 flex min-w-0 items-center gap-1.5 px-2"
      >
        <CioSearch size={ICON_SIZE.inline} class="shrink-0 text-dimmed" />
        <input
          {@attach focusField}
          type="text"
          class="h-6 min-w-0 flex-1 bg-app px-1.5 text-[0.6875rem] text-foreground outline-none placeholder:text-dimmed"
          placeholder={search.placeholder}
          aria-label={search.ariaLabel}
          value={search.query}
          oninput={(event) => search.onQueryChange(event.currentTarget.value)}
          onkeydown={(event) => {
            if (event.key !== 'Escape') return
            event.preventDefault()
            collapse()
          }}
        />
        {#if search.loading}
          <span
            class="flex h-6 w-6 shrink-0 items-center justify-center text-dimmed"
            role="status"
            aria-label="Searching"
          >
            <CioSpinner size={12} class="animate-spin" />
          </span>
        {/if}
        <button
          type="button"
          class="flex h-7 w-7 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
          aria-label="Hide search"
          title="Hide search"
          onclick={collapse}
        >
          <CioChevronUp size={ICON_SIZE.inline} />
        </button>
      </div>
    {/if}
  </div>

  {#if row}
    <div class="flex items-center gap-1 border-t border-border px-1.5 py-1">
      {@render row()}
    </div>
  {/if}
</div>

<style>
  /* The field slides in over the tabs and the tabs give way at once: a plain
     CSS animation rather than a transition, because the row is not measured and
     the swap must never wait on the outgoing layer. */
  .panel-search-layer {
    animation: panel-search-in 140ms cubic-bezier(0.22, 1, 0.36, 1) both;
  }

  @keyframes panel-search-in {
    from {
      opacity: 0.35;
      transform: translateX(-6px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .panel-search-layer {
      animation: none;
    }
  }
</style>
