<script lang="ts">
  import { onMount } from 'svelte'
  import { Globe } from '@lucide/svelte'
  import { subscribe } from '$lib/ipc.svelte'
  import type { BrowserPanelShortcutAction } from '$shared/ipc-contract'
  import { globalBrowser } from '$lib/stores/global-browser.svelte'
  import { browserKeyboardFocus } from '$lib/stores/browser-keyboard-focus'
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
  {#if globalBrowser.sidebarVisible}
    <BrowserTabsSidebar onOpenAddress={() => globalBrowser.openAddressSpotlight()} />
  {/if}

  {#if activeTab}
    {#key activeTab.id}
      <BrowserWorkspace tab={activeTab} />
    {/key}
  {:else}
    <div class="flex h-full min-h-0 min-w-0 flex-1 items-center justify-center bg-surface">
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

  {#if globalBrowser.contextSidebarVisible}
    <BrowserContextSidebar onClose={() => globalBrowser.toggleContextSidebar()} />
  {/if}
</div>

{#if addressSpotlightOpen}
  <BrowserAddressSpotlight onClose={() => globalBrowser.closeAddressSpotlight()} />
{/if}
