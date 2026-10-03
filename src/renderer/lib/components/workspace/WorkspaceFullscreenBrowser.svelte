<script lang="ts">
  import BrowserPanel from '$lib/components/browser/BrowserPanel.svelte'
  import BrowserTabIndicator from '$lib/components/browser/BrowserTabIndicator.svelte'
  import FullscreenPanelDialog from '$lib/components/workspace/FullscreenPanelDialog.svelte'
  import { subscribe } from '$lib/ipc.svelte'
  import { keymapState } from '$lib/keymap/keymap-state.svelte'
  import { browserKeyboardFocus } from '$lib/stores/browser-keyboard-focus'
  import { browserTabIndicators } from '$lib/stores/browser-tab-status'
  import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
  import { faviconState } from '$lib/stores/favicons.svelte'
  import { threadBrowserTabs } from '$lib/stores/thread-browser-tabs.svelte'
  import { GlobeCode } from '@lucide/svelte'

  interface Props {
    tabId: string | null
    onTabIdChange: (id: string | null) => void
    /**
     * Opens a fresh browser tab.
     *
     * The workspace settles this overlay onto the new tab itself, because the
     * same handler answers the strip's create button and the browser's new-tab
     * chord, and only one of them is a click here. It returns nothing for the
     * same reason: an id this surface would forward has already been applied.
     */
    onNewBrowser: () => void
    onCloseTab: (id: string) => void
  }

  let { tabId, onTabIdChange, onNewBrowser, onCloseTab }: Props = $props()

  let browserTabs = $derived(contextSidebarState.tabs.filter((tab) => tab.kind === 'browser'))

  let fullscreenTabs = $derived(
    browserTabs.map((tab) => ({
      id: tab.id,
      title: tab.title,
      // The strip hides the globe for a tab that is playing audio or
      // recording, and the dialog sizes that tab's icon slot from this count.
      indicatorCount: browserTabIndicators(contextSidebarState.browserRuntime(tab.id)).length
    }))
  )

  /** The site mark a tab wears, from the page or from its address, or null when
   *  there is none to draw and the strip falls back to the globe. */
  function tabFavicon(id: string): string | null {
    const tab = browserTabs.find((candidate) => candidate.id === id)
    if (!tab) return null
    return tab.favicon ?? faviconState.faviconFor(tab.url)
  }

  // Fill in the icon of any tab whose page never announced one, so a restored or
  // agent-opened tab wears the mark of its address rather than a globe. The
  // sidebar strip asks for the same thing with the same dedupe, so a tab shown
  // in both places costs one lookup.
  $effect(() => {
    faviconState.ensureResolved(browserTabs.map((tab) => tab.url))
    for (const tab of browserTabs) {
      if (tab.url !== '' && tab.favicon === null) {
        contextSidebarState.ensureBrowserTabFavicon(tab.id)
      }
    }
  })

  // While this overlay is up the browser is the surface the user is in, so its
  // keys are the browser's, wherever the focus sits inside the dialog: the
  // strip, the transport, the toolbar or the page. Released with the overlay.
  $effect(() => {
    const active = tabId
    if (!active) return
    browserKeyboardFocus.setClaim('fullscreen', active)
    return () => browserKeyboardFocus.setClaim('fullscreen', null)
  })

  // Publish which tab this surface shows, so the thread switcher knows the
  // Ctrl+Tab gesture belongs to the browser while it is up, and record it as the
  // tab in use so a cycle can reach the one before it.
  $effect(() => {
    threadBrowserTabs.setFullscreen(tabId)
    if (tabId) threadBrowserTabs.record(tabId)
    return () => threadBrowserTabs.setFullscreen(null)
  })

  /**
   * Walk the browser's recently-used tabs, exactly as the browser's own Ctrl+Tab
   * does: the first press goes to the tab in use before this one, each further
   * press keeps walking the order that was frozen when the gesture began, and
   * the Control release settles on the tab it landed on.
   */
  function cycleTabs(direction: 1 | -1): void {
    const liveIds = browserTabs.map((tab) => tab.id)
    const target = threadBrowserTabs.cycle(direction, liveIds, tabId)
    if (!target || target === tabId) return
    // Focus keeps the sidebar's own strip on the tab the browser settled on, and
    // the overlay follows the same id.
    contextSidebarState.focus(target)
    onTabIdChange(target)
  }

  function handleWindowKeydown(event: KeyboardEvent): void {
    if (!tabId) return
    if (!keymapState.matches('thread-switcher', event)) return
    event.preventDefault()
    event.stopPropagation()
    cycleTabs(event.shiftKey ? -1 : 1)
  }

  function handleWindowKeyup(event: KeyboardEvent): void {
    if (event.key !== 'Control') return
    threadBrowserTabs.commit()
  }

  // A key pressed in a native page never reaches this DOM, so main claims the
  // gesture there and forwards it here (see the thread switcher, which owns the
  // same gesture everywhere else). The Control release then reaches this window
  // and commits, exactly as a DOM press would.
  $effect(() =>
    subscribe('browser:switcherKey', ({ backward }) => {
      if (!tabId) return
      cycleTabs(backward ? -1 : 1)
    })
  )
</script>

<svelte:window
  onkeydown={handleWindowKeydown}
  onkeyup={handleWindowKeyup}
  onblur={() => threadBrowserTabs.commit()}
/>

{#if tabId}
  {@const browserTab = contextSidebarState.tabs.find((tab) => tab.id === tabId)}
  {#if browserTab?.kind === 'browser'}
    <FullscreenPanelDialog
      tabs={fullscreenTabs}
      activeTabId={tabId}
      newLabel="New browser tab"
      minimizeLabel="Minimize browser"
      hostsBrowserView
      onSelect={(id) => onTabIdChange(id)}
      onCloseTab={(id) => onCloseTab(id)}
      onNew={onNewBrowser}
      onMinimize={() => onTabIdChange(null)}
    >
      {#snippet tabIcon(entry)}
        {@const favicon = tabFavicon(entry.id)}
        {#if favicon}
          <img
            src={favicon}
            alt=""
            class="h-3 w-3 shrink-0 rounded-sm object-contain"
            aria-hidden="true"
          />
        {:else}
          <GlobeCode size={11} class="shrink-0" />
        {/if}
      {/snippet}
      {#snippet tabIndicator(entry)}
        <BrowserTabIndicator tabId={entry.id} />
      {/snippet}
      {#key tabId}
        <BrowserPanel tab={browserTab} fullscreen onTabReplaced={(id) => onTabIdChange(id)} />
      {/key}
    </FullscreenPanelDialog>
  {/if}
{/if}
