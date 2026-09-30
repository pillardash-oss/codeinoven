<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import {
    AppWindow,
    Bookmark,
    Boxes,
    Clock,
    Download,
    Globe,
    MessagesCircle,
    Puzzle,
    StickyNote
  } from '@lucide/svelte'
  import { subscribe } from '$lib/ipc.svelte'
  import { GLOBAL_BROWSER_PROJECT_ID, type BrowserPanelShortcutAction } from '$shared/ipc-contract'
  import ContextDock, { type ContextDockItem } from '$lib/components/layout/ContextDock.svelte'
  import GitHubSignInBrowserDock from '$lib/components/git/GitHubSignInBrowserDock.svelte'
  import { githubSignIn } from '$lib/stores/github-sign-in.svelte'
  import { globalBrowser } from '$lib/stores/global-browser.svelte'
  import { DEFAULT_BOX_ID } from '$lib/stores/global-browser-types'
  import { loadBrowser } from '$lib/stores/browser-access.svelte'
  import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
  import { browserDownloads } from '$lib/stores/browser-downloads.svelte'
  import { storeExtensionOffer } from '$lib/stores/browser-extension-store-offer'
  import { browserPopupWindows } from '$lib/stores/browser-popup-windows.svelte'
  import { motionDuration } from '$lib/motion'
  import { threadNotesState } from '$lib/stores/thread-notes.svelte'
  import { viewActions, type ViewActionItem } from '$lib/stores/view-actions.svelte'
  import {
    browserAppearanceAccent,
    browserAppearanceIconUrl,
    browserAppearanceIsCustomised
  } from './browser-group-appearance'
  import BrowserTabSearchButton from './BrowserTabSearchButton.svelte'
  import BrowserNewTabButton from './BrowserNewTabButton.svelte'
  import BrowserTabsSidebar from './BrowserTabsSidebar.svelte'
  import BrowserWorkspace from './BrowserWorkspace.svelte'
  import BrowserContextSidebar from './BrowserContextSidebar.svelte'
  import BrowserAddressSpotlight from './BrowserAddressSpotlight.svelte'

  /**
   * The global browser view: the top-level workspace the app's Browser entry
   * opens.
   *
   * Its left sidebar is the browser's chrome and tab strip, and the rest of the
   * window is the page. The view owns the address spotlight, because Cmd/Ctrl+L
   * must summon it from anywhere in here. It does not own the keyboard claim:
   * that belongs to the surface showing the page (`BrowserWorkspace`), which
   * publishes it while the page is the surface on screen rather than while focus
   * sits inside the view, so the browser's keys survive a press with the app
   * header, the nav sidebar or nothing at all holding the focus.
   *
   * It also hosts the docked sign-in bar, under the page column, when a GitHub
   * sign-in was handed off to this browser: a page is a native view composited
   * above the DOM, so the sign-in cannot float over the page it opened, and a row
   * of this view is what keeps it on screen instead
   * (`src/renderer/lib/components/git/GitHubSignInBrowserDock.svelte`).
   */

  let addressSpotlightOpen = $derived(globalBrowser.addressSpotlightOpen)
  const activeTab = $derived(globalBrowser.activeTab)

  /** How many of the profile's downloads are unfinished: still running, or stopped
   *  with bytes kept for a resume, for the rail badge. */
  const unfinishedDownloadCount = $derived(
    browserDownloads.unfinishedCount(GLOBAL_BROWSER_PROJECT_ID)
  )

  /**
   * The offer the page on screen makes, when it is an extension's store page for
   * something this profile does not have yet.
   *
   * That is the rail's one indicator on the extensions tool: it says there is an
   * install here for the user to take, which is the only thing the tool can hand
   * them from the page they are looking at. How many extensions are installed is
   * not an indicator, so the tool states no count.
   */
  const installableStoreOffer = $derived.by(() => {
    const offer = storeExtensionOffer()
    return offer && !offer.installed ? offer : null
  })

  /**
   * The box the page on screen lives in, and the identity its tool wears.
   *
   * A box is a named identity rather than a fixed concept, so the rail shows the
   * one in use. Like a project, a box always has a mark: the icon the user picked
   * for it, or its initials on its own colour, resolved by the same resolver every
   * other identity in the app uses. Two boxes therefore never read as one generic
   * tool, which is what tells a user at a glance that the page on screen is not in
   * their default box.
   *
   * The box nobody styled keeps the tool's own glyph and colour. It is the jar the
   * browser's own pages live in, so wearing its identity would say nothing, and
   * the first run of the browser would lose the rail's only handle on the tool.
   */
  const activeBox = $derived(globalBrowser.activeBox)
  const activeBoxNamed = $derived(
    activeBox.id !== DEFAULT_BOX_ID || browserAppearanceIsCustomised(activeBox)
  )
  const boxesAppearance = $derived(
    activeBoxNamed
      ? {
          color: browserAppearanceAccent(activeBox),
          iconUrl: browserAppearanceIconUrl(activeBox, globalBrowser.boxIconUrl(activeBox.id))
        }
      : undefined
  )
  const boxesLabel = $derived(activeBoxNamed ? `Boxes: ${activeBox.name}` : 'Boxes')

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
    const hasAgent = tab ? globalBrowser.agentChatFor(tab.id) !== null : false
    /** The popup windows this tab's page opened. A popup that ends leaves the list
     *  and takes the rail's panel with it when it was the last, so the tool is only
     *  offered while there is a window for it to show. */
    const popupWindows = tab ? browserPopupWindows.forTab(tab.id) : []
    const browserTools: ContextDockItem[] = [
      {
        id: 'downloads',
        label:
          unfinishedDownloadCount > 0
            ? `Downloads (${unfinishedDownloadCount} unfinished)`
            : 'Downloads',
        icon: Download,
        active: globalBrowser.downloadsSidebarShown,
        countBadge: unfinishedDownloadCount > 0 ? String(unfinishedDownloadCount) : undefined,
        onSelect: () => globalBrowser.toggleDownloadsSidebar()
      },
      // History, bookmarks and boxes belong to the person, like downloads do, so
      // they are reachable with no tab open: the browser's whole memory is
      // browsable even when the strip is empty.
      {
        id: 'history',
        label: 'History',
        icon: Clock,
        active: globalBrowser.historySidebarShown,
        onSelect: () => globalBrowser.toggleHistorySidebar()
      },
      // No badge and no count on the label: a bookmark is quick access the user
      // put there and knows about, not a queue with a backlog, so the rail states
      // the tool and nothing else.
      {
        id: 'bookmarks',
        label: 'Bookmarks',
        icon: Bookmark,
        active: globalBrowser.bookmarksSidebarShown,
        onSelect: () => globalBrowser.toggleBookmarksSidebar()
      },
      // Boxes belong to the profile, like downloads and bookmarks, so the tool is
      // reachable with no tab open. That is also what makes it the first browser
      // tool a user needs: a box is made before a tab is opened inside it.
      //
      // No badge and no count on the label: a rail indicator reads as a
      // notification, and how many boxes exist is not one. The tool instead wears
      // the active box's own icon and colour, and names it in the tooltip, which
      // is the identity a user needs here rather than a number.
      {
        id: 'boxes',
        label: boxesLabel,
        icon: Boxes,
        appearance: boxesAppearance,
        active: globalBrowser.boxesSidebarShown,
        onSelect: () => globalBrowser.toggleBoxesSidebar()
      },
      // Extensions belong to the profile like boxes and downloads do, and they are
      // the tool that comes first of the three: installing an extension is what
      // puts something on disk for a box to contain.
      //
      // The rail carries one indicator here and only one: an extension on a store
      // page that this profile does not have yet, which is the single thing the
      // tool can hand the user to install. How many are installed is not an
      // indicator, so the tool states no count.
      {
        id: 'extensions',
        label: 'Extensions',
        icon: Puzzle,
        active: globalBrowser.extensionsSidebarShown,
        badge: installableStoreOffer ? 'attention' : undefined,
        badgeTitle: installableStoreOffer
          ? `Install ${installableStoreOffer.name ?? 'the extension'} from the store page you are on`
          : undefined,
        onSelect: () => globalBrowser.toggleExtensionsSidebar()
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
            // The conversation wears the Chats view's mark: it is a chat, not a
            // status, so it takes no tone either.
            icon: MessagesCircle,
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
        component: BrowserNewTabButton as unknown as ViewActionItem['component']
      }
    ])
  })

  // Hand the slot back when the view goes away, unless another view has already
  // claimed it, which is the normal case when the user switches views.
  onDestroy(() => {
    if (viewActions.view === 'browser') viewActions.set('none', [])
  })

  /**
   * Open a resolved address from the spotlight. The store owns the rule   the tab
   * on screen navigates, a browser with none opens its first tab   so the history
   * and bookmark panels take the same path.
   */
  function openAddress(url: string): void {
    globalBrowser.openInActiveTab(url)
  }

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
    // Find belongs to the surface showing the page (`BrowserWorkspace`), which owns
    // the bar and its own row, so nothing here answers it. It is named rather than
    // left to fall through, because the fall-through below closes the tab.
    if (action === 'find' || action === 'find-next' || action === 'find-previous') return
    const tab = globalBrowser.activeTab
    if (tab) globalBrowser.close(tab.id)
  }

  onMount(() => {
    // This surface asks for the browser itself: nothing about the browser is built
    // at boot (see `browser-access.svelte`), so the view that needs it is the one
    // that asks. Idempotent, and it is also what publishes the store to the eager
    // surfaces that read it.
    void loadBrowser()
    globalBrowser.markOpened()
    // The profile's downloads are read back here too: a download recovered from an
    // earlier run has to reach the rail's badge and list without the user having
    // to open the downloads panel first.
    void browserDownloads.load(GLOBAL_BROWSER_PROJECT_ID)
    const unsubscribePanelShortcut = subscribe('browser:panelShortcut', handlePanelShortcut)
    return () => {
      unsubscribePanelShortcut()
    }
  })
</script>

<div class="flex h-full min-h-0" data-region="browser-view">
  <!-- The sidebar is the browser's chrome (address, history, downloads) as well
       as its tab strip, so it is present with no tab open too: that is where the
       first address is typed. It is the app's own left sidebar, so it docks,
       resizes, folds and slides exactly like the workspace one. -->
  <BrowserTabsSidebar onOpenAddress={() => globalBrowser.openAddressSpotlight()} />

  <div class="flex min-h-0 min-w-0 flex-1 flex-col">
    {#if activeTab}
      {#key activeTab.id}
        <BrowserWorkspace tab={activeTab} />
      {/key}
    {:else}
      <div class="flex min-h-0 min-w-0 flex-1 items-center justify-center bg-app">
        <div class="flex flex-col items-center gap-3 px-8 text-center">
          <Globe size={26} class="text-dimmed" />
          <p class="max-w-sm text-sm leading-relaxed text-muted">
            The global browser keeps its own signed-in profile, separate from the browsers your
            agents run in.
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

    <!--
      The docked sign-in sits below the page column rather than over the page: the
      page is a native view composited above every DOM node, so an overlay on it
      would park it, and the whole point of this bar is that the code and the page
      it belongs to are on screen together. In flow, it shortens the page frame,
      and the frame's own observers re-place the native view above it.
    -->
    {#if githubSignIn.dockedInAppBrowser}
      <GitHubSignInBrowserDock />
    {/if}
  </div>

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
  <BrowserAddressSpotlight
    initialValue={activeTab?.url ?? ''}
    onOpen={openAddress}
    onClose={() => globalBrowser.closeAddressSpotlight()}
  />
{/if}

<style>
  .context-rail {
    transition-property: width;
    transition-timing-function: cubic-bezier(0.215, 0.61, 0.355, 1);
  }
</style>
