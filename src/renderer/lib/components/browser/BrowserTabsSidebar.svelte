<script lang="ts">
  import { onMount } from 'svelte'
  import type { Attachment } from 'svelte/attachments'
  import {
    ArrowLeft,
    ArrowRight,
    Check,
    Globe,
    Loader2,
    Lock,
    LockOpen,
    Pin,
    PinOff,
    Plus,
    Puzzle,
    RotateCw,
    Search,
    Settings2,
    Star,
    X
  } from '@lucide/svelte'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { GLOBAL_BROWSER_PROJECT_ID, type BrowserViewBounds } from '$shared/ipc-contract'
  import { globalBrowser } from '$lib/stores/global-browser.svelte'
  import { browserBookmarks } from '$lib/stores/browser-bookmarks.svelte'
  import CollapsibleSidebar from '$lib/components/layout/CollapsibleSidebar.svelte'
  import { browserVisibility } from '$lib/stores/browser-visibility.svelte'
  import { browserStripOverlay } from '$lib/stores/browser-strip-overlay.svelte'
  import { sidebarState } from '$lib/stores/sidebar.svelte'
  import { appConfigState } from '$lib/stores/app-config.svelte'
  import { projectStripChrome, projectStripTabs } from '$lib/browser-strip-overlay-bridge'
  import {
    browserTabLabel,
    DEFAULT_BOX_NAME,
    type GlobalBrowserTab
  } from '$lib/stores/global-browser-types'
  import {
    installStoreExtensionOffer,
    storeExtensionOffer,
    storeOfferInstallVerb
  } from '$lib/stores/browser-extension-store-offer'
  import BrowserTabRow from './BrowserTabRow.svelte'
  import BrowserNewTabMenu from './BrowserNewTabMenu.svelte'
  import BrowserGroupModal from './BrowserGroupModal.svelte'
  import BrowserTabModal from './BrowserTabModal.svelte'
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte'
  import { browserGroupAccent, browserGroupIconUrl } from './browser-group-appearance'
  import { browserSiteHost, openBrowserPageMenu, openBrowserSiteMenu } from './browser-chrome-menus'

  interface Props {
    /** Summon the address spotlight, which is how Cmd/Ctrl+L also opens it. */
    onOpenAddress: () => void
  }

  let { onOpenAddress }: Props = $props()
  /**
   * The browser view's left sidebar: browser chrome and the global tab strip.
   *
   * The chrome is fixed at the top left, so the address, history and downloads
   * stay put while the strip scrolls under them. Below it the sidebar holds the
   * tabs the way the thread sidebar holds threads: a row carries the page, its
   * loading state and whether it wants the user, and a group folds related tabs
   * under a name, a colour and an icon. Hiding the sidebar is how the user gets
   * an uninterrupted page.
   */

  /** The search field's own element, captured as an attachment. Revealing the
   *  field is what opens the search, so taking the caret on mount is the whole
   *  focus story and needs no `bind:this`. */
  const attachSearchInput: Attachment<HTMLInputElement> = (element) => {
    element.focus()
  }
  /** The group whose editor is open; `undefined` means closed and null means
   *  "create a new group", so the two states can never be confused. */
  let editorGroupId = $state<string | null | undefined>(undefined)
  /** The tab whose editor is open, or null while it is closed. */
  let editorTabId = $state<string | null>(null)
  /** Tabs chosen with Cmd/Ctrl-click or Shift-click for a group operation. */
  let selectedTabIds = $state<string[]>([])
  /** The fixed endpoint used by the next Shift-click range. */
  let selectionAnchorId = $state<string | null>(null)
  let pendingBulkBox = $state<{
    tabIds: string[]
    boxId: string | null
    boxName: string
  } | null>(null)
  const visibleSelectedTabIds = $derived(
    selectedTabIds.filter((id) => globalBrowser.tabById(id) !== null)
  )

  const activeTab = $derived(globalBrowser.activeTab)
  const runtime = $derived(activeTab ? globalBrowser.runtimeFor(activeTab.id) : null)
  const secure = $derived(Boolean(activeTab?.url.startsWith('https:')))
  /** Expanded state of the padlock while its native site menu is up. The menu
   *  itself is an OS popup above the page view, so this only tracks the button. */
  let siteMenuOpen = $state(false)

  // The native site menu reports its own dismissal, which is the only signal the
  // button has to drop its expanded state.
  onMount(() => subscribe('browser:siteMenuClosed', () => (siteMenuOpen = false)))

  /** The page on screen's address. The bar shows it rather than owning an
   *  editable copy of it: the address the user types goes through the spotlight
   *  (see {@link onOpenAddress}), which is where history is suggested too. */
  const address = $derived(activeTab?.url ?? '')
  /** Whether the page on screen is already saved, which is what the star beside
   *  the address reads and toggles. */
  const bookmarked = $derived(browserBookmarks.isBookmarked(address))

  /**
   * The extension the page on screen is, when it is a Chrome Web Store page.
   *
   * The store cannot install anything in this app: its "Add to Chrome" button is
   * Chrome's inline-install API, which Electron does not implement, so it sits
   * disabled. The app therefore offers the install itself, and this is what
   * decides when the affordance exists.
   */
  const storeOffer = $derived(storeExtensionOffer())
  const storeOfferTitle = $derived.by(() => {
    if (!storeOffer) return 'Open the extensions panel'
    const verb = storeOfferInstallVerb(storeOffer)
    if (verb) return `${verb} ${storeOffer.name ?? 'the extension'}`
    if (storeOffer.installed) {
      return `${storeOffer.name ?? 'This extension'} is installed. Open the extensions panel.`
    }
    return `Install ${storeOffer.name ?? 'this extension'} in ${storeOffer.boxName}`
  })
  /** This offer's own install, if it has one. Only this extension's install makes
   *  the chip busy: another extension downloading behind it must not. */
  const storeOfferInstall = $derived(storeOffer?.install ?? null)

  /** Install the offer, or open the rail on what is already installed. */
  function actOnStoreOffer(): void {
    if (!storeOffer) return
    if (storeOffer.installed) {
      globalBrowser.showExtensionsSidebar()
      return
    }
    void installStoreExtensionOffer()
  }

  const groups = $derived(globalBrowser.orderedGroups)

  // A group's or a tab's icon is a file on disk, so its bytes are read once and
  // cached; this keeps the strip's icons current without every row reading a
  // file itself.
  $effect(() => {
    for (const group of globalBrowser.groups) {
      if (group.imagePath && !globalBrowser.groupIconUrls.has(group.id)) {
        void globalBrowser.ensureGroupIconLoaded(group.id)
      }
    }
    for (const tab of globalBrowser.tabs) {
      if (tab.imagePath && !globalBrowser.tabIconUrls.has(tab.id)) {
        void globalBrowser.ensureTabIconLoaded(tab.id)
      }
    }
    // A tab the app has no page for (one a restart restored, one hibernated
    // before its page reported an icon) takes the icon its own address is known
    // by, so the row wears the site's mark instead of a globe. The store asks at
    // most once per address per tab and writes the answer down with the tab, so
    // this is not a render-time lookup.
    for (const tab of globalBrowser.tabs) {
      if (tab.url !== '' && tab.favicon === null) void globalBrowser.ensureFavicon(tab.id)
    }
  })
  const ungrouped = $derived(globalBrowser.tabsInGroup(null))
  const pinned = $derived(globalBrowser.pinnedTabs.filter(matches))
  const totalTabs = $derived(globalBrowser.tabs.length)
  const query = $derived(globalBrowser.tabSearchQuery)
  const searchGroupId = $derived(globalBrowser.tabSearchGroupId)
  const scopedGroup = $derived(searchGroupId ? globalBrowser.groupById(searchGroupId) : null)

  function matches(tab: GlobalBrowserTab): boolean {
    const needle = query.trim().toLowerCase()
    if (needle === '') return true
    if (
      browserTabLabel(tab).toLowerCase().includes(needle) ||
      tab.url.toLowerCase().includes(needle)
    ) {
      return true
    }
    // The box a tab runs in is part of what the user is searching for, so a
    // query for "work" finds every page in the work box and not only the pages
    // whose own title or address happens to contain the word.
    const box = tab.boxId ? globalBrowser.boxById(tab.boxId) : null
    return box ? box.name.toLowerCase().includes(needle) : false
  }

  function tabsFor(groupId: string | null): GlobalBrowserTab[] {
    return globalBrowser.tabsInGroup(groupId).filter(matches)
  }

  function handleTabClick(tabId: string, event: MouseEvent): void {
    const additive = event.metaKey || event.ctrlKey
    if (event.shiftKey) {
      const tabs = globalBrowser.tabs
      const anchorIndex = tabs.findIndex((tab) => tab.id === selectionAnchorId)
      const targetIndex = tabs.findIndex((tab) => tab.id === tabId)
      if (targetIndex < 0) return
      const start = anchorIndex < 0 ? targetIndex : Math.min(anchorIndex, targetIndex)
      const end = anchorIndex < 0 ? targetIndex : Math.max(anchorIndex, targetIndex)
      const rangeIds = tabs.slice(start, end + 1).map((tab) => tab.id)
      selectedTabIds = additive ? [...new Set([...visibleSelectedTabIds, ...rangeIds])] : rangeIds
      if (selectionAnchorId === null) selectionAnchorId = tabId
      return
    }
    if (additive) {
      selectedTabIds = visibleSelectedTabIds.includes(tabId)
        ? visibleSelectedTabIds.filter((id) => id !== tabId)
        : [...visibleSelectedTabIds, tabId]
      selectionAnchorId = tabId
      return
    }
    selectedTabIds = []
    selectionAnchorId = tabId
    globalBrowser.switchTo(tabId)
  }

  function handleTabContextMenu(tabId: string): string[] {
    if (visibleSelectedTabIds.includes(tabId)) return [...visibleSelectedTabIds]
    selectedTabIds = [tabId]
    selectionAnchorId = tabId
    return [tabId]
  }

  function moveTabsToGroup(tabIds: string[], groupId: string): void {
    globalBrowser.moveTabsToGroup(tabIds, groupId)
    selectedTabIds = []
    selectionAnchorId = null
  }

  function createGroupForTabs(tabIds: string[]): void {
    const groupId = globalBrowser.createGroup('New group')
    if (!globalBrowser.groupById(groupId)) return
    globalBrowser.moveTabsToGroup(tabIds, groupId)
    selectedTabIds = []
    selectionAnchorId = null
    editorGroupId = groupId
  }

  function reopenTabsInBox(tabIds: string[], boxId: string | null): void {
    for (const tabId of tabIds) globalBrowser.reopenInBox(tabId, boxId)
    selectedTabIds = []
    selectionAnchorId = null
  }

  function requestReopenTabsInBox(tabIds: string[], boxId: string | null): void {
    const tabsToReopen = tabIds.filter((tabId) => {
      const tab = globalBrowser.tabById(tabId)
      return tab !== null && tab.boxId !== boxId
    })
    if (tabsToReopen.length === 0) return
    pendingBulkBox = {
      tabIds: tabsToReopen,
      boxId,
      boxName: boxId
        ? (globalBrowser.boxById(boxId)?.name ?? 'the selected box')
        : 'the default box'
    }
  }

  function newTab(groupId: string | null = null): void {
    onOpenAddress()
    globalBrowser.createTab('', groupId)
  }

  /** Narrow the strip to one group's tabs and take the caret, so a group's own
   *  search affordance lands the user in the field rather than on the button. */
  function scopeSearch(groupId: string | null): void {
    globalBrowser.openTabSearch(groupId)
  }

  /** Save the page on screen, or take it out of the list again. The page's own
   *  favicon goes with it: that is what a saved page wears by default, and the tab
   *  holds one for as long as it holds its address, hibernated or not. */
  function toggleBookmark(): void {
    const tab = activeTab
    if (!tab || tab.url === '') return
    browserBookmarks.toggle(tab.url, browserTabLabel(tab), tab.favicon)
  }

  /** Left click reloads, or aborts the in-flight navigation while loading. */
  function reloadActiveTab(): void {
    const tab = activeTab
    if (!tab) return
    void invoke(runtime?.loading ? 'browser:stop' : 'browser:reload', tab.id).catch(() => {})
  }

  /** Right click offers the soft/hard reload choice, exactly as the project
   *  sidebar's reload button and the page area do. */
  function onReloadContextMenu(event: MouseEvent): void {
    event.preventDefault()
    const tab = activeTab
    if (!tab) return
    const button = event.currentTarget
    if (!(button instanceof HTMLElement)) return
    openBrowserPageMenu(tab.id, button)
  }

  /** Open the native site-settings menu (clear cookies, site data, cache and
   *  remembered permissions) under the padlock. */
  function openSiteMenu(event: MouseEvent): void {
    const tab = activeTab
    if (!tab) return
    const button = event.currentTarget
    if (!(button instanceof HTMLElement)) return
    const host = browserSiteHost(tab.url)
    siteMenuOpen = true
    void openBrowserSiteMenu(
      GLOBAL_BROWSER_PROJECT_ID,
      host,
      button,
      globalBrowser.activeTabBoxId,
      globalBrowser.boxById(globalBrowser.activeTabBoxId)?.name ?? DEFAULT_BOX_NAME
    ).then((opened) => {
      if (!opened) siteMenuOpen = false
    })
  }

  /** The group a dragged tab is hovering, so its header can highlight as a drop
   *  target. Dragging a tab onto a header files it under that group. */
  let groupDropTargetId = $state<string | null>(null)

  function onGroupDragOver(event: DragEvent, groupId: string): void {
    if (!globalBrowser.draggingTabId) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    groupDropTargetId = groupId
  }

  function onGroupDrop(event: DragEvent, groupId: string): void {
    groupDropTargetId = null
    const dragged = globalBrowser.draggingTabId ?? event.dataTransfer?.getData('text/plain') ?? ''
    if (!dragged) return
    event.preventDefault()
    globalBrowser.moveToGroup(dragged, groupId)
    globalBrowser.endDrag()
  }

  // ─── The floating panel above a live page ─────────────────────────────────
  /**
   * While the browser's sidebar is collapsed, hovering the left edge reveals it
   * as a floating panel. The page is a native view painted above every DOM node,
   * so from the moment a page reaches the panel's band the panel is drawn by the
   * native overlay window instead, and the page keeps running underneath it.
   *
   * The decision is geometric and lives here because this is the only place that
   * knows the panel and the window: the panel's rectangle is the sidebar's own
   * width against the viewport, and a page covers it when a native frame
   * intersects it. The overlay then gets the projection, and answers with an
   * acknowledgement `browserStripOverlay` watches.
   *
   * The occlusion rule is the load-bearing half: while the overlay is being asked
   * to draw the panel, the panel must not publish itself as an occluder, or the
   * visibility store would detach the page and the overlay would mirror a frame
   * that no longer exists. That is why the phase, not the panel alone, decides
   * both the occlusion and whether the DOM panel is drawn.
   */

  /** The window's own size, tracked because the panel's band runs to its bottom
   *  edge and the page frame is measured in the same space. */
  let viewport = $state({ width: window.innerWidth, height: window.innerHeight })

  /** The floating panel's top edge, which is the application header's own height
   *  (`top-12`), and therefore follows the user's appearance font size. */
  const stripTop = $derived(Math.round(3 * appConfigState.appFontSize))

  /** The band the floating panel occupies in the viewport. */
  const stripBand = $derived<BrowserViewBounds>({
    x: 0,
    y: stripTop,
    width: sidebarState.width,
    height: Math.max(0, viewport.height - stripTop)
  })

  const floating = $derived(!sidebarState.docked && sidebarState.hoverOpen)
  const pageCoversStrip = $derived(browserVisibility.overlapsNative(stripBand))
  /** Whether the overlay may be used for the floating panel at all: the panel has
   *  to be floating, and the window has to be able to hear and draw it. */
  const overlayAvailable = $derived(floating && !browserStripOverlay.unavailable)
  /**
   * Whether the strip belongs in the overlay right now.
   *
   * `pageCoversStrip` alone is not enough. A tab switch remounts the page frame
   * (`BrowserView` keys `BrowserWorkspace` by tab), and the new frame only
   * publishes its rectangle after a `tick`, so the coverage reading dips false
   * for a flush. Releasing the strip on that dip both flashed the panel and let
   * the DOM panel publish an occlusion over the page frame the switch was about
   * to attach, which parked the new page and left the panel showing. Keeping the
   * overlay while it is already live bridges the dip; a genuine full-window
   * surface (a modal) is the signal that actually ends the handover.
   */
  const overlayWanted = $derived(
    overlayAvailable &&
      (pageCoversStrip || browserStripOverlay.live) &&
      !browserVisibility.hasFullWindowSurface
  )

  /**
   * What the sidebar is told about its floating panel: `none` leaves everything
   * to the DOM panel, `pending` means the overlay is loading so the panel must
   * keep drawing but must not occlude, and `live` means the overlay owns it.
   *
   * While the panel floats and the overlay is usable the DOM panel never falls
   * back to `none`, even when no page covers its band this instant. Publishing an
   * occlusion there is what detached the page and left the overlay mirroring a
   * frame that no longer existed; `pending` keeps the panel drawable without
   * occluding, so the page can always attach underneath it.
   */
  const stripPhase = $derived<'none' | 'pending' | 'live'>(
    overlayAvailable && !browserVisibility.hasFullWindowSurface
      ? browserStripOverlay.live
        ? 'live'
        : 'pending'
      : 'none'
  )

  $effect(() => {
    if (!overlayWanted) {
      void browserStripOverlay.publish(null)
      return
    }
    void browserStripOverlay.publish({
      width: sidebarState.width,
      top: stripTop,
      theme: browserStripOverlay.theme,
      chrome: projectStripChrome(),
      tabs: projectStripTabs()
    })
  })

  onMount(() => {
    const trackViewport = (): void => {
      viewport = { width: window.innerWidth, height: window.innerHeight }
    }
    window.addEventListener('resize', trackViewport)
    // Wire the overlay's reports before anything can publish a strip, so a
    // window that cannot hear it never hands it the panel in the first place.
    const stopOverlay = browserStripOverlay.start()
    return () => {
      window.removeEventListener('resize', trackViewport)
      // Leaving the view drops the panel with it: the page it was drawn over is
      // going away in the same breath.
      void browserStripOverlay.publish(null)
      stopOverlay()
    }
  })
</script>

{#snippet chrome()}
  <!-- Fixed chrome: the address and history stay at the top left while the tab
       strip scrolls beneath them. The address is a control, not a field: clicking
       it opens the address spotlight, where the address is replaced and the pages
       already visited are offered underneath it. Bookmarks and downloads live in
       the right rail, so the address bar keeps the room between the history
       buttons and the edge. -->
  <div class="shrink-0 border-b px-2 py-2">
    <div class="mb-1.5 flex items-center gap-1">
      <!-- Only the navigation a page can actually take is shown: back when there
           is history behind, forward when there is history ahead, neither when
           the tab has no page yet, so the address bar never pays for a control
           that cannot do anything. -->
      {#if runtime?.canGoBack}
        <button
          type="button"
          class="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-elevated hover:text-foreground"
          aria-label="Go back in page history"
          title="Go back"
          onclick={() => activeTab && void invoke('browser:goBack', activeTab.id).catch(() => {})}
        >
          <ArrowLeft size={15} />
        </button>
      {/if}
      {#if runtime?.canGoForward}
        <button
          type="button"
          class="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-elevated hover:text-foreground"
          aria-label="Go forward in page history"
          title="Go forward"
          onclick={() =>
            activeTab && void invoke('browser:goForward', activeTab.id).catch(() => {})}
        >
          <ArrowRight size={15} />
        </button>
      {/if}
      <!-- Reload is shown only when there is a page to act on: an empty tab has
           nothing to reload, and the button is the stop affordance while a load
           is in flight, so it takes the address bar's room only when it can do
           something, just as back and forward do. -->
      {#if activeTab && (runtime?.loading || activeTab.url)}
        <button
          type="button"
          class="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-elevated hover:text-foreground"
          aria-label={runtime?.loading ? 'Stop loading' : 'Reload page'}
          title={runtime?.loading ? 'Stop loading' : 'Reload page'}
          onclick={reloadActiveTab}
          oncontextmenu={onReloadContextMenu}
        >
          {#if runtime?.loading}
            <X size={15} />
          {:else}
            <RotateCw size={14} />
          {/if}
        </button>
      {/if}
      <div class="flex min-w-0 flex-1 items-center gap-1 rounded-lg bg-elevated pr-0.5 pl-1.5">
        {#if activeTab?.url}
          <button
            type="button"
            class={[
              'flex h-5 w-5 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-overlay',
              secure ? 'text-success' : 'text-dimmed'
            ]}
            title={secure ? 'Site settings' : 'Connection is not secure'}
            aria-label={secure ? 'Site settings' : 'Connection is not secure'}
            aria-haspopup="menu"
            aria-expanded={siteMenuOpen}
            onclick={openSiteMenu}
          >
            {#if secure}
              <Lock size={12} />
            {:else}
              <LockOpen size={12} />
            {/if}
          </button>
        {:else}
          <Globe size={12} class="shrink-0 text-dimmed" />
        {/if}
        <!-- The page's address is a control rather than a field: clicking it opens
             the address spotlight, where the address is replaced and the pages
             already visited are offered underneath it. The address is only read
             here, so nothing in the strip ever mutates it. -->
        <button
          type="button"
          class={[
            'h-7 min-w-0 flex-1 truncate text-left text-xs',
            address === '' ? 'text-dimmed' : 'text-foreground'
          ]}
          title="Search or enter an address"
          aria-label="Search or enter an address"
          onclick={onOpenAddress}
        >
          {address === '' ? 'Search or enter an address' : address}
        </button>
        {#if storeOffer}
          <!-- The install the store's own button cannot offer: "Add to Chrome" is
               Chrome's inline-install API, which this runtime does not
               implement. Icon only, because the rail and the panel carry the
               words. -->
          <button
            type="button"
            class={[
              'flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-overlay disabled:opacity-60',
              storeOffer.installed ? 'text-success' : 'text-primary'
            ]}
            disabled={storeOfferInstall !== null && !storeOffer.installed}
            title={storeOfferTitle}
            aria-label={storeOfferTitle}
            onclick={actOnStoreOffer}
          >
            {#if storeOfferInstall !== null && !storeOffer.installed}
              <Loader2 size={12} class="animate-spin" />
            {:else if storeOffer.installed}
              <Check size={12} />
            {:else}
              <Puzzle size={12} />
            {/if}
          </button>
        {/if}
        <button
          type="button"
          class={[
            'flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-overlay',
            bookmarked ? 'text-warning' : 'text-dimmed hover:text-foreground'
          ]}
          disabled={address === ''}
          aria-label={bookmarked ? 'Remove this page from bookmarks' : 'Bookmark this page'}
          aria-pressed={bookmarked}
          title={bookmarked ? 'Remove bookmark' : 'Bookmark this page'}
          onclick={toggleBookmark}
        >
          <Star size={12} class={bookmarked ? 'fill-current' : ''} />
        </button>
      </div>
    </div>
  </div>

  {#if globalBrowser.tabSearchOpen}
    <!-- Keyed on the open request so opening the search (from the header, or from
         a group's own control while it is already up) remounts the field and the
         attachment takes the caret, with no focus effect. -->
    {#key globalBrowser.tabSearchFocusRequest}
      <div class="shrink-0 px-3 py-2">
        <div class="flex items-center gap-1.5 rounded-lg bg-elevated px-2.5">
          <Search size={13} class="shrink-0 text-dimmed" />
          <input
            {@attach attachSearchInput}
            type="text"
            class="h-7 min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none"
            placeholder={scopedGroup ? `Search in ${scopedGroup.name}` : 'Search tabs'}
            aria-label={scopedGroup ? `Search tabs in ${scopedGroup.name}` : 'Search browser tabs'}
            value={query}
            oninput={(event: Event) => {
              if (event.currentTarget instanceof HTMLInputElement)
                globalBrowser.setTabSearchQuery(event.currentTarget.value)
            }}
            onkeydown={(event: KeyboardEvent) => {
              if (event.key === 'Escape') globalBrowser.closeTabSearch()
            }}
          />
          {#if query !== '' || searchGroupId !== null}
            <button
              type="button"
              class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-dimmed transition-colors hover:bg-overlay hover:text-foreground"
              aria-label="Clear tab search"
              title="Clear search"
              onclick={() => globalBrowser.clearTabSearch()}
            >
              <X size={13} />
            </button>
          {/if}
        </div>
      </div>
    {/key}
  {/if}
{/snippet}

{#if totalTabs > 0}
  <CollapsibleSidebar
    title="Browser"
    hideHeader
    onboardingAnchor={false}
    label="Browser tabs"
    region="browser-sidebar"
    overlayPhase={stripPhase}
    {chrome}
  >
    {#if searchGroupId === null && pinned.length > 0}
      <div class="mb-1">
        <p
          class="flex items-center gap-1 px-2 pt-1 pb-0.5 text-[0.625rem] font-semibold uppercase tracking-wide text-dimmed"
        >
          <Pin size={10} aria-hidden="true" />
          Pinned
        </p>
        <div class="ml-2 border-l pl-1.5">
          {#each pinned as tab (tab.id)}
            <BrowserTabRow
              {tab}
              selected={visibleSelectedTabIds.includes(tab.id)}
              onTabClick={handleTabClick}
              onTabContextMenu={handleTabContextMenu}
              onMoveTabsToGroup={moveTabsToGroup}
              onCreateGroupForTabs={createGroupForTabs}
              onReopenTabsInBox={requestReopenTabsInBox}
              onEditTab={(id) => (editorTabId = id)}
              onOpenGroupEditor={(id) => (editorGroupId = id)}
            />
          {/each}
        </div>
      </div>
    {/if}

    {#each groups as group (group.id)}
      {@const accent = browserGroupAccent(group)}
      {@const hasAppearance = Boolean(
        group.color || group.iconType || group.customSvg || group.imagePath
      )}
      {@const iconUrl = hasAppearance
        ? browserGroupIconUrl(group, globalBrowser.groupIconUrl(group.id))
        : null}
      {#if searchGroupId === null || searchGroupId === group.id}
        {#if searchGroupId !== null || group.pinned || tabsFor(group.id).length > 0}
          <div class="mb-1">
            <div
              class="flex items-center gap-1 rounded-lg px-1.5 py-1 transition-colors {groupDropTargetId ===
              group.id
                ? 'ring-1 ring-info'
                : ''}"
              style="background-color: {accent}1a"
              role="group"
              aria-label={`${group.name}, drop a tab here to move it into this group`}
              ondragover={(event: DragEvent) => onGroupDragOver(event, group.id)}
              ondragleave={() => (groupDropTargetId = null)}
              ondrop={(event: DragEvent) => onGroupDrop(event, group.id)}
            >
              <button
                type="button"
                class="flex min-w-0 flex-1 items-center gap-2 px-1 py-0.5 text-left"
                title={group.description
                  ? `${group.name}: ${group.description}`
                  : `Search only inside ${group.name}`}
                aria-label={`Filter the tab strip to ${group.name}`}
                onclick={() => scopeSearch(group.id)}
              >
                {#if iconUrl}
                  <img
                    src={iconUrl}
                    alt=""
                    class="h-3.5 w-3.5 shrink-0 rounded-sm object-contain"
                    draggable="false"
                  />
                {:else}
                  <span class="h-2 w-2 shrink-0 rounded-full" style="background-color: {accent}"
                  ></span>
                {/if}
                <span class="truncate text-[0.6875rem] font-semibold" style="color: {accent}">
                  {group.name}
                </span>
                {#if group.pinned}
                  <Pin size={10} class="shrink-0" style="color: {accent}" aria-hidden="true" />
                {/if}
                <span class="shrink-0 text-[0.625rem] text-dimmed">
                  {tabsFor(group.id).length}
                </span>
              </button>
              <BrowserNewTabMenu groupId={group.id} anchorTabId={activeTab?.id ?? null}>
                {#snippet trigger()}
                  <button
                    type="button"
                    class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-overlay hover:text-foreground"
                    aria-label={`New tab in ${group.name}`}
                    title={`New tab in ${group.name}`}
                    onclick={() => newTab(group.id)}
                  >
                    <Plus size={13} />
                  </button>
                {/snippet}
              </BrowserNewTabMenu>
              <button
                type="button"
                class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-overlay hover:text-foreground"
                aria-label={`Search in ${group.name}`}
                title={`Search in ${group.name}`}
                onclick={() => scopeSearch(group.id)}
              >
                <Search size={12} />
              </button>
              <button
                type="button"
                class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-overlay hover:text-foreground {group.pinned
                  ? 'text-accent'
                  : 'text-muted'}"
                aria-label={group.pinned ? `Unpin ${group.name}` : `Pin ${group.name}`}
                aria-pressed={group.pinned}
                title={group.pinned ? `Unpin ${group.name}` : `Pin ${group.name}`}
                onclick={() => globalBrowser.toggleGroupPin(group.id)}
              >
                {#if group.pinned}
                  <Pin size={12} />
                {:else}
                  <PinOff size={12} />
                {/if}
              </button>
              <button
                type="button"
                class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-overlay hover:text-foreground"
                aria-label={`Edit ${group.name}`}
                title={`Edit ${group.name}`}
                onclick={() => (editorGroupId = group.id)}
              >
                <Settings2 size={12} />
              </button>
            </div>
            <div class="mt-0.5 ml-2 border-l pl-1.5">
              {#each tabsFor(group.id) as tab (tab.id)}
                <BrowserTabRow
                  {tab}
                  selected={visibleSelectedTabIds.includes(tab.id)}
                  onTabClick={handleTabClick}
                  onTabContextMenu={handleTabContextMenu}
                  onMoveTabsToGroup={moveTabsToGroup}
                  onCreateGroupForTabs={createGroupForTabs}
                  onReopenTabsInBox={requestReopenTabsInBox}
                  onEditTab={(id) => (editorTabId = id)}
                  onOpenGroupEditor={(id) => (editorGroupId = id)}
                />
              {/each}
              {#if tabsFor(group.id).length === 0}
                <p class="px-2 py-1.5 text-[0.6875rem] text-dimmed">No tabs match</p>
              {/if}
            </div>
          </div>
        {/if}
      {/if}
    {/each}

    {#if searchGroupId === null}
      {#if groups.length > 0 && ungrouped.length > 0}
        <p class="px-2 pt-2 pb-1 text-[0.625rem] font-semibold uppercase tracking-wide text-dimmed">
          Ungrouped
        </p>
      {/if}
      {#each tabsFor(null) as tab (tab.id)}
        <BrowserTabRow
          {tab}
          selected={visibleSelectedTabIds.includes(tab.id)}
          onTabClick={handleTabClick}
          onTabContextMenu={handleTabContextMenu}
          onMoveTabsToGroup={moveTabsToGroup}
          onCreateGroupForTabs={createGroupForTabs}
          onReopenTabsInBox={requestReopenTabsInBox}
          onEditTab={(id) => (editorTabId = id)}
          onOpenGroupEditor={(id) => (editorGroupId = id)}
        />
      {/each}
      {#if query !== '' && ungrouped.length > 0 && tabsFor(null).length === 0}
        <p class="px-2 py-1.5 text-[0.6875rem] text-dimmed">No ungrouped tabs match</p>
      {/if}
    {/if}
  </CollapsibleSidebar>
{/if}

{#if editorGroupId !== undefined}
  <BrowserGroupModal groupId={editorGroupId} onClose={() => (editorGroupId = undefined)} />
{/if}

{#if editorTabId !== null}
  <BrowserTabModal tabId={editorTabId} onClose={() => (editorTabId = null)} />
{/if}

{#if pendingBulkBox}
  <ConfirmDialog
    open
    variant="primary"
    title="Reopen selected tabs in another box?"
    confirmLabel="Reopen tabs"
    onCancel={() => (pendingBulkBox = null)}
    onConfirm={() => {
      if (pendingBulkBox) reopenTabsInBox(pendingBulkBox.tabIds, pendingBulkBox.boxId)
      pendingBulkBox = null
    }}
  >
    <p>
      {visibleSelectedTabIds.length} tabs will close and reopen in {pendingBulkBox.boxName}. Each
      box has separate cookies and sign-ins, and page history will not carry over.
    </p>
  </ConfirmDialog>
{/if}
