<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import { AppWindow, Bot, Download, Globe, Plus, StickyNote } from '@lucide/svelte'
  import { subscribe } from '$lib/ipc.svelte'
  import { GLOBAL_BROWSER_PROJECT_ID, type BrowserPanelShortcutAction } from '$shared/ipc-contract'
  import ContextDock, { type ContextDockItem } from '$lib/components/layout/ContextDock.svelte'
  import { globalBrowser } from '$lib/stores/global-browser.svelte'
  import { startBrowserRuntime } from '$lib/stores/browser-runtime'
  import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
  import { browserDownloads } from '$lib/stores/browser-downloads.svelte'
  import { browserPopupWindows } from '$lib/stores/browser-popup-windows.svelte'
  import { motionDuration } from '$lib/motion'
  import { threadNotesState } from '$lib/stores/thread-notes.svelte'
  import { browserKeyboardFocus } from '$lib/stores/browser-keyboard-focus'
  import { keymapState } from '$lib/keymap/keymap-state.svelte'
  import { viewActions, type ViewActionItem } from '$lib/stores/view-actions.svelte'
  import BrowserTabSearchButton from './BrowserTabSearchButton.svelte'
  import BrowserTabsSidebar from './BrowserTabsSidebar.svelte'
  import BrowserWorkspace from './BrowserWorkspace.svelte'
  import BrowserContextSidebar from './BrowserContextSidebar.svelte'
  import BrowserAddressSpotlight from './BrowserAddressSpotlight.svelte'

  /**
   * The global browser view: the top-level workspace the app's Browser entry
   * opens.
   *
   * Its left sidebar is the browser's chrome and tab strip, and the rest of the
   * window is the page. The view owns the two things that belong to neither
   * surface: the keyboard claim for the whole view (so browser shortcuts work
   * wherever focus sits inside it) and the address spotlight, because Cmd/Ctrl+L
   * must summon it from anywhere in here.
   */

  let addressSpotlightOpen = $derived(globalBrowser.addressSpotlightOpen)
  const activeTab = $derived(globalBrowser.activeTab)

  /** How many of the profile's downloads are still running, for the rail badge. */
  const activeDownloadCount = $derived(browserDownloads.activeCount(GLOBAL_BROWSER_PROJECT_ID))

  /**
   * The browser view's tools for the context rail.
   *
   * The rail is constant, exactly as it is in every other view: the window's
   * right edge always carries the context tools. The browser's own tools come
   * first   downloads, then the popup windows the page opened, with the
   * extensions and profiles that belong beside them still to be built   and the
   * tab on screen's own tools follow. Downloads and popups belong to the profile
   * and the page rather than to a thread, and downloads are what keep the rail
   * here with the strip empty.
   */
  const dockGroups = $derived.by((): ContextDockItem[][] => {
    const tab = activeTab
    const hasNote = tab ? threadNotesState.has(tab.id) : false
    const hasAgent = tab ? globalBrowser.agentChatTabFor(tab.id) !== null : false
    /** The popup windows this tab's page opened. A popup that ends leaves the list
     *  and takes the rail's panel with it when it was the last, so the tool is only
     *  offered while there is a window for it to show. */
    const popupWindows = tab ? browserPopupWindows.forTab(tab.id) : []
    const browserTools: ContextDockItem[] = [
      {
        id: 'downloads',
        label: activeDownloadCount > 0 ? `Downloads (${activeDownloadCount} active)` : 'Downloads',
        icon: Download,
        active: globalBrowser.downloadsSidebarShown,
        countBadge: activeDownloadCount > 0 ? String(activeDownloadCount) : undefined,
        onSelect: () => globalBrowser.toggleDownloadsSidebar()
      },
      ...(popupWindows.length > 0
        ? [
            {
              id: 'popups',
              label:
                popupWindows.length === 1
                  ? 'Popup window'
                  : `Popup windows (${popupWindows.length})`,
              icon: AppWindow,
              active: globalBrowser.popupsSidebarShown,
              onSelect: () => globalBrowser.togglePopupsSidebar()
            }
          ]
        : [])
    ]
    const tabTools: ContextDockItem[] = tab
      ? [
          {
            id: 'note',
            label: hasNote ? 'Note available' : 'Add note',
            icon: StickyNote,
            active: globalBrowser.noteSidebarShown,
            tone: hasNote ? 'warning' : undefined,
            onSelect: () => globalBrowser.toggleContextSidebar()
          },
          {
            id: 'agent',
            label: hasAgent ? 'Agent conversation' : 'Ask the agent',
            icon: Bot,
            active: globalBrowser.agentSidebarShown,
            onSelect: () => globalBrowser.toggleAgentSidebar()
          }
        ]
      : []
    return [browserTools, tabTools].filter((group) => group.length > 0)
  })

  /** Whether the right rail is on screen, for a tool of the browser's or the app's
   *  own notifications panel. */
  const railShown = $derived(globalBrowser.contextSidebarShown || globalBrowser.notificationsShown)

  /**
   * The view's quick actions, rendered beside the view switcher exactly like
   * every other view's: search the tab strip, then open a tab. Creating a group
   * stays a tab's own context-menu action, so it is deliberately absent here.
   */
  $effect(() => {
    viewActions.set('browser', [
      {
        id: 'search-tabs',
        component: BrowserTabSearchButton as unknown as ViewActionItem['component']
      },
      {
        id: 'new-tab',
        icon: Plus,
        ariaLabel: 'New browser tab',
        title: 'New tab',
        shortcut: keymapState.keysFor('browser-new-tab'),
        run: () => globalBrowser.openNewTabAddress()
      }
    ])
  })

  // Hand the slot back when the view goes away, unless another view has already
  // claimed it, which is the normal case when the user switches views.
  onDestroy(() => {
    if (viewActions.view === 'browser') viewActions.set('none', [])
  })

  /**
   * The browser shortcuts main routes back to the renderer are the ones whose
   * answer is DOM state: which tab is on screen, and where the address field is.
   * They arrive for whichever tab main believes holds the keyboard.
   */
  function handlePanelShortcut(_tabId: string, action: BrowserPanelShortcutAction): void {
    if (action === 'focus-address') {
      globalBrowser.openAddressSpotlight()
      return
    }
    if (action === 'new-tab') {
      globalBrowser.openNewTabAddress()
      return
    }
    if (action === 'toggle-notes') {
      globalBrowser.toggleContextSidebar()
      return
    }
    const tab = globalBrowser.activeTab
    if (tab) globalBrowser.close(tab.id)
  }

  function onFocusIn(event: FocusEvent): void {
    const target = event.target
    const tab = globalBrowser.activeTab
    if (!tab) return
    if (!(target instanceof Element) || !target.closest('[data-region="browser-view"]')) return
    browserKeyboardFocus.setClaim('workspace', tab.id)
  }

  function onFocusOut(event: FocusEvent): void {
    const next = event.relatedTarget
    if (next instanceof Element && next.closest('[data-region="browser-view"]')) return
    browserKeyboardFocus.setClaim('workspace', null)
  }

  onMount(() => {
    // This surface asks for the browser's renderer runtime itself: the runtime is
    // not wired at boot (see `startBrowserRuntime`), so the view that needs it is
    // the one that starts it, before it reads any of the state below.
    startBrowserRuntime()
    globalBrowser.markOpened()
    const unsubscribePanelShortcut = subscribe('browser:panelShortcut', handlePanelShortcut)
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('focusout', onFocusOut)
    return () => {
      unsubscribePanelShortcut()
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('focusout', onFocusOut)
      browserKeyboardFocus.setClaim('workspace', null)
    }
  })
</script>

<div class="flex h-full min-h-0" data-region="browser-view">
  <!-- The sidebar is the browser's chrome (address, history, downloads) as well
       as its tab strip, so it is present with no tab open too: that is where the
       first address is typed. It is the app's own left sidebar, so it docks,
       resizes, folds and slides exactly like the workspace one. -->
  <BrowserTabsSidebar onOpenAddress={() => globalBrowser.openAddressSpotlight()} />

  {#if activeTab}
    {#key activeTab.id}
      <BrowserWorkspace tab={activeTab} />
    {/key}
  {:else}
    <div class="flex h-full min-h-0 min-w-0 flex-1 items-center justify-center bg-app">
      <div class="flex flex-col items-center gap-3 px-8 text-center">
        <Globe size={26} class="text-dimmed" />
        <p class="max-w-sm text-sm leading-relaxed text-muted">
          The global browser keeps its own signed-in profile, separate from the browsers your agents
          run in.
        </p>
        <button
          type="button"
          class="rounded-lg bg-primary px-3.5 py-2 text-sm font-medium text-on-primary transition-colors hover:bg-primary-hover"
          title="Open a new browser tab"
          onclick={() => {
            globalBrowser.openNewTabAddress()
          }}
        >
          New tab
        </button>
      </div>
    </div>
  {/if}

  <!-- The rail's track. It is always in the layout, so the panel opens and closes
       by growing and shrinking this one box   the same motion the workspace rail's
       track makes. A Svelte transition here waited on an animation event that a
       renderer whose window is in the background never sends, which pinned the rail
       at zero width and left the page beside it half open. -->
  <div
    class="context-rail flex h-full min-h-0 shrink-0 overflow-hidden"
    style:width="{railShown ? contextSidebarState.width : 0}px"
    style:transition-duration="{motionDuration(railShown ? 200 : 160)}ms"
  >
    {#if railShown}
      <BrowserContextSidebar onClose={() => globalBrowser.toggleContextSidebar()} />
    {/if}
  </div>

  <ContextDock groups={dockGroups} />
</div>

{#if addressSpotlightOpen}
  <BrowserAddressSpotlight onClose={() => globalBrowser.closeAddressSpotlight()} />
{/if}

<style>
  .context-rail {
    transition-property: width;
    transition-timing-function: cubic-bezier(0.215, 0.61, 0.355, 1);
  }
</style>
