<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import { cubicOut } from 'svelte/easing'
  import { fly } from 'svelte/transition'
  import { Bot, Globe, Plus, StickyNote } from '@lucide/svelte'
  import { subscribe } from '$lib/ipc.svelte'
  import type { BrowserPanelShortcutAction } from '$shared/ipc-contract'
  import ContextDock, { type ContextDockItem } from '$lib/components/layout/ContextDock.svelte'
  import { globalBrowser } from '$lib/stores/global-browser.svelte'
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

  /**
   * The browser view's tools for the context rail.
   *
   * The rail is constant, exactly as it is in every other view: the window's
   * right edge always carries the context tools. This view has two, and both
   * belong to the tab on screen: its note and its agent conversation. Each item
   * leads to its own panel and has something to show only while a tab is open.
   */
  const dockGroups = $derived.by((): ContextDockItem[][] => {
    const tab = activeTab
    const hasNote = tab ? threadNotesState.has(tab.id) : false
    const hasAgent = tab ? globalBrowser.agentChatTabFor(tab.id) !== null : false
    return [
      [
        {
          id: 'note',
          label: !tab ? 'Notes' : hasNote ? 'Note available' : 'Add note',
          icon: StickyNote,
          active: globalBrowser.contextSidebarShown && !globalBrowser.agentSidebarShown,
          tone: hasNote ? 'warning' : undefined,
          onSelect: () => globalBrowser.toggleContextSidebar()
        },
        {
          id: 'agent',
          label: !tab ? 'Agent' : hasAgent ? 'Agent conversation' : 'Ask the agent',
          icon: Bot,
          active: globalBrowser.agentSidebarShown,
          tone: 'info' as const,
          onSelect: () => globalBrowser.toggleAgentSidebar()
        }
      ]
    ]
  })

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
       first address is typed. It slides in from the left edge and back out the
       same way the workspace sidebar does, so folding it reads as one motion
       instead of a jump. -->
  {#if globalBrowser.sidebarVisible}
    <div
      class="flex h-full min-h-0 shrink-0"
      in:fly={{ x: '-100%', duration: motionDuration(200), easing: cubicOut }}
      out:fly={{ x: '-100%', duration: motionDuration(160), easing: cubicOut }}
    >
      <BrowserTabsSidebar onOpenAddress={() => globalBrowser.openAddressSpotlight()} />
    </div>
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

  {#if globalBrowser.contextSidebarShown}
    <div
      class="flex h-full min-h-0 shrink-0"
      in:fly={{ x: '100%', duration: motionDuration(200), easing: cubicOut }}
      out:fly={{ x: '100%', duration: motionDuration(160), easing: cubicOut }}
    >
      <BrowserContextSidebar onClose={() => globalBrowser.toggleContextSidebar()} />
    </div>
  {/if}

  <ContextDock groups={dockGroups} />
</div>

{#if addressSpotlightOpen}
  <BrowserAddressSpotlight onClose={() => globalBrowser.closeAddressSpotlight()} />
{/if}
