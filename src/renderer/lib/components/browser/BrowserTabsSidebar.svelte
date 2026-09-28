<script lang="ts">
  import { onMount } from 'svelte'
  import type { Attachment } from 'svelte/attachments'
  import {
    ArrowLeft,
    ArrowRight,
    Globe,
    Lock,
    LockOpen,
    Pin,
    PinOff,
    Plus,
    RotateCw,
    Search,
    Settings2,
    X
  } from '@lucide/svelte'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { resolveBrowserAddress } from '$shared/browser-search-engines'
  import { appConfigState } from '$lib/stores/app-config.svelte'
  import { GLOBAL_BROWSER_PROJECT_ID } from '$shared/ipc-contract'
  import { GLOBAL_BROWSER_CONTEXT, globalBrowser } from '$lib/stores/global-browser.svelte'
  import CollapsibleSidebar from '$lib/components/layout/CollapsibleSidebar.svelte'
  import { browserTabLabel, type GlobalBrowserTab } from '$lib/stores/global-browser-types'
  import BrowserTabRow from './BrowserTabRow.svelte'
  import BrowserGroupModal from './BrowserGroupModal.svelte'
  import BrowserTabModal from './BrowserTabModal.svelte'
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

  const activeTab = $derived(globalBrowser.activeTab)
  const runtime = $derived(activeTab ? globalBrowser.runtimeFor(activeTab.id) : null)
  const secure = $derived(Boolean(activeTab?.url.startsWith('https:')))
  /** Expanded state of the padlock while its native site menu is up. The menu
   *  itself is an OS popup above the page view, so this only tracks the button. */
  let siteMenuOpen = $state(false)

  // The native site menu reports its own dismissal, which is the only signal the
  // button has to drop its expanded state.
  onMount(() => subscribe('browser:siteMenuClosed', () => (siteMenuOpen = false)))

  /** Null while the address mirrors the page; a string once the user types, so a
   *  page that navigates mid-edit never steals the caret's line. The draft is
   *  only consulted while the field has focus, which is what makes a tab switch
   *  show the new tab's address without a reset effect. */
  let addressDraft = $state('')
  let addressFocused = $state(false)
  let addressError = $state('')

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
  })
  const ungrouped = $derived(globalBrowser.tabsInGroup(null))
  const pinned = $derived(globalBrowser.pinnedTabs.filter(matches))
  const totalTabs = $derived(globalBrowser.tabs.length)
  const query = $derived(globalBrowser.tabSearchQuery)
  const searchGroupId = $derived(globalBrowser.tabSearchGroupId)
  const scopedGroup = $derived(searchGroupId ? globalBrowser.groupById(searchGroupId) : null)
  const address = $derived(addressFocused ? addressDraft : (activeTab?.url ?? ''))

  function matches(tab: GlobalBrowserTab): boolean {
    const needle = query.trim().toLowerCase()
    if (needle === '') return true
    return (
      browserTabLabel(tab).toLowerCase().includes(needle) || tab.url.toLowerCase().includes(needle)
    )
  }

  function tabsFor(groupId: string | null): GlobalBrowserTab[] {
    return globalBrowser.tabsInGroup(groupId).filter(matches)
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

  function navigate(): void {
    const resolution = resolveBrowserAddress(addressDraft, appConfigState.browserSearchEngine)
    if (!resolution) {
      addressError = 'Enter a search or an address'
      return
    }
    addressError = ''
    addressFocused = false
    // With a tab on screen the address drives it. With none it is the way in, so
    // it opens the first tab instead of doing nothing.
    if (activeTab)
      void invoke(
        'browser:navigate',
        activeTab.id,
        GLOBAL_BROWSER_CONTEXT.projectId,
        GLOBAL_BROWSER_CONTEXT.threadId,
        resolution.url
      ).catch(() => {})
    else globalBrowser.createTab(resolution.url)
  }

  function startEditingAddress(input: EventTarget | null): void {
    if (!(input instanceof HTMLInputElement)) return
    addressFocused = true
    addressDraft = activeTab?.url ?? ''
    input.select()
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
    void openBrowserSiteMenu(GLOBAL_BROWSER_PROJECT_ID, host, button).then((opened) => {
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
</script>

{#snippet chrome()}
  <!-- Fixed chrome: the address and history stay at the top left while the tab
       strip scrolls beneath them. Downloads live in the right rail, so the
       address bar keeps the room between the history buttons and the edge. -->
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
      <div class="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg bg-elevated px-2">
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
        <input
          type="text"
          class="h-7 min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-dimmed"
          placeholder="Search or enter an address"
          aria-label="Address"
          aria-invalid={addressError !== ''}
          value={address}
          onfocus={(event: FocusEvent) => startEditingAddress(event.currentTarget)}
          onblur={() => (addressFocused = false)}
          oninput={(event: Event) => {
            if (event.currentTarget instanceof HTMLInputElement)
              addressDraft = event.currentTarget.value
          }}
          onkeydown={(event: KeyboardEvent) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            navigate()
          }}
        />
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
            class="h-7 min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-dimmed"
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

<CollapsibleSidebar
  title="Browser"
  hideHeader
  onboardingAnchor={false}
  label="Browser tabs"
  region="browser-sidebar"
  {chrome}
>
  {#if totalTabs === 0}
    <div class="flex flex-col items-center gap-3 px-4 py-10 text-center">
      <Globe size={22} class="text-dimmed" />
      <p class="text-xs leading-relaxed text-dimmed">
        No tabs are open. Pages here run in their own profile, separate from the browsers your
        agents use.
      </p>
      <button
        type="button"
        class="rounded-lg bg-primary px-3 py-2 text-xs font-medium text-on-primary transition-colors hover:bg-primary-hover"
        title="Open a new browser tab"
        onclick={() => newTab()}
      >
        New tab
      </button>
    </div>
  {:else}
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
              <button
                type="button"
                class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-overlay hover:text-foreground"
                aria-label={`New tab in ${group.name}`}
                title={`New tab in ${group.name}`}
                onclick={() => newTab(group.id)}
              >
                <Plus size={13} />
              </button>
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
          onEditTab={(id) => (editorTabId = id)}
          onOpenGroupEditor={(id) => (editorGroupId = id)}
        />
      {/each}
      {#if query !== '' && ungrouped.length > 0 && tabsFor(null).length === 0}
        <p class="px-2 py-1.5 text-[0.6875rem] text-dimmed">No ungrouped tabs match</p>
      {/if}
    {/if}
  {/if}
</CollapsibleSidebar>

{#if editorGroupId !== undefined}
  <BrowserGroupModal groupId={editorGroupId} onClose={() => (editorGroupId = undefined)} />
{/if}

{#if editorTabId !== null}
  <BrowserTabModal tabId={editorTabId} onClose={() => (editorTabId = null)} />
{/if}
