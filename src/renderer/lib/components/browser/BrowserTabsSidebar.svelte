<script lang="ts">
  import type { Attachment } from 'svelte/attachments'
  import {
    ArrowLeft,
    ArrowRight,
    Download,
    Globe,
    Lock,
    LockOpen,
    Plus,
    RotateCw,
    Search,
    Settings2,
    X
  } from '@lucide/svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { normalizeBrowserUrl } from '$shared/local-development-url'
  import { GLOBAL_BROWSER_PROJECT_ID } from '$shared/ipc-contract'
  import { globalBrowser } from '$lib/stores/global-browser.svelte'
  import { browserGroupColor, type GlobalBrowserTab } from '$lib/stores/global-browser-types'
  import { browserDownloads } from '$lib/stores/browser-downloads.svelte'
  import BrowserTabRow from './BrowserTabRow.svelte'
  import BrowserGroupModal from './BrowserGroupModal.svelte'
  import { BROWSER_GROUP_ICONS } from './browser-group-icons'

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

  const activeTab = $derived(globalBrowser.activeTab)
  const runtime = $derived(activeTab ? globalBrowser.runtimeFor(activeTab.id) : null)
  const secure = $derived(Boolean(activeTab?.url.startsWith('https:')))
  const activeDownloadCount = $derived(browserDownloads.activeCount(GLOBAL_BROWSER_PROJECT_ID))

  /** Null while the address mirrors the page; a string once the user types, so a
   *  page that navigates mid-edit never steals the caret's line. The draft is
   *  only consulted while the field has focus, which is what makes a tab switch
   *  show the new tab's address without a reset effect. */
  let addressDraft = $state('')
  let addressFocused = $state(false)
  let addressError = $state('')

  const groups = $derived(globalBrowser.groups)
  const ungrouped = $derived(globalBrowser.tabsInGroup(null))
  const totalTabs = $derived(globalBrowser.tabs.length)
  const query = $derived(globalBrowser.tabSearchQuery)
  const searchGroupId = $derived(globalBrowser.tabSearchGroupId)
  const scopedGroup = $derived(searchGroupId ? globalBrowser.groupById(searchGroupId) : null)
  const address = $derived(addressFocused ? addressDraft : (activeTab?.url ?? ''))

  function matches(tab: GlobalBrowserTab): boolean {
    const needle = query.trim().toLowerCase()
    if (needle === '') return true
    return tab.title.toLowerCase().includes(needle) || tab.url.toLowerCase().includes(needle)
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
    const url = normalizeBrowserUrl(addressDraft)
    if (!url) {
      addressError = 'Enter an http or https address'
      return
    }
    addressError = ''
    addressFocused = false
    if (activeTab) void invoke('browser:navigate', activeTab.id, url).catch(() => {})
  }

  function startEditingAddress(input: EventTarget | null): void {
    if (!(input instanceof HTMLInputElement)) return
    addressFocused = true
    addressDraft = activeTab?.url ?? ''
    input.select()
  }

  function openDownloadsMenu(event: MouseEvent): void {
    const button = event.currentTarget
    if (!(button instanceof HTMLElement)) return
    const rect = button.getBoundingClientRect()
    void invoke(
      'browser:downloadsMenu',
      GLOBAL_BROWSER_PROJECT_ID,
      Math.max(0, Math.round(rect.left)),
      Math.max(0, Math.round(rect.bottom + 4))
    ).catch(() => {})
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

<aside
  class="flex h-full w-80 shrink-0 flex-col border-r bg-surface"
  data-region="browser-sidebar"
  aria-label="Browser tabs"
>
  <!-- Fixed chrome: the address, history and downloads stay at the top left
       while the tab strip scrolls beneath them. -->
  <div class="shrink-0 border-b px-2 py-2">
    <div class="mb-1.5 flex items-center gap-1">
      <button
        type="button"
        class="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
        aria-label="Go back in page history"
        title="Go back"
        disabled={!runtime?.canGoBack}
        onclick={() => activeTab && void invoke('browser:goBack', activeTab.id).catch(() => {})}
      >
        <ArrowLeft size={15} />
      </button>
      <button
        type="button"
        class="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
        aria-label="Go forward in page history"
        title="Go forward"
        disabled={!runtime?.canGoForward}
        onclick={() => activeTab && void invoke('browser:goForward', activeTab.id).catch(() => {})}
      >
        <ArrowRight size={15} />
      </button>
      <button
        type="button"
        class="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
        aria-label={runtime?.loading ? 'Stop loading' : 'Reload page'}
        title={runtime?.loading ? 'Stop loading' : 'Reload page'}
        disabled={!activeTab}
        onclick={() =>
          activeTab &&
          void invoke(runtime?.loading ? 'browser:stop' : 'browser:reload', activeTab.id).catch(
            () => {}
          )}
      >
        {#if runtime?.loading}
          <X size={15} />
        {:else}
          <RotateCw size={14} />
        {/if}
      </button>
      <div class="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg bg-elevated px-2">
        {#if activeTab?.url}
          {#if secure}
            <Lock size={12} class="shrink-0 text-success" />
          {:else}
            <LockOpen size={12} class="shrink-0 text-dimmed" />
          {/if}
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
          disabled={!activeTab}
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
      <button
        type="button"
        class="relative flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-elevated hover:text-foreground"
        aria-label="Open browser downloads"
        title="Downloads"
        onclick={openDownloadsMenu}
      >
        <Download size={14} />
        {#if activeDownloadCount > 0}
          <span
            class="absolute -top-0.5 -right-0.5 flex h-3 min-w-3 items-center justify-center rounded-full bg-accent px-0.5 text-[0.5rem] font-semibold text-on-accent"
          >
            {activeDownloadCount}
          </span>
        {/if}
      </button>
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

  <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
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
      {#each groups as group (group.id)}
        {@const palette = browserGroupColor(group.color)}
        {#if searchGroupId === null || searchGroupId === group.id}
          {#if searchGroupId !== null || tabsFor(group.id).length > 0}
            <div class="mb-1">
              <div
                class="flex items-center gap-1 rounded-lg px-1.5 py-1 transition-colors {palette.tint} {groupDropTargetId ===
                group.id
                  ? 'ring-1 ring-info'
                  : ''}"
                role="group"
                aria-label={`${group.name}, drop a tab here to move it into this group`}
                ondragover={(event: DragEvent) => onGroupDragOver(event, group.id)}
                ondragleave={() => (groupDropTargetId = null)}
                ondrop={(event: DragEvent) => onGroupDrop(event, group.id)}
              >
                <button
                  type="button"
                  class="flex min-w-0 flex-1 items-center gap-2 px-1 py-0.5 text-left"
                  title={`Search only inside ${group.name}`}
                  aria-label={`Filter the tab strip to ${group.name}`}
                  onclick={() => scopeSearch(group.id)}
                >
                  {#if group.icon}
                    {@const GroupIcon = BROWSER_GROUP_ICONS[group.icon]}
                    <GroupIcon size={13} class="shrink-0 {palette.text}" />
                  {:else}
                    <span class="h-2 w-2 shrink-0 rounded-full {palette.dot}"></span>
                  {/if}
                  <span class="truncate text-[0.6875rem] font-semibold {palette.text}">
                    {group.name}
                  </span>
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
                  <BrowserTabRow {tab} onOpenGroupEditor={(id) => (editorGroupId = id)} />
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
          <p
            class="px-2 pt-2 pb-1 text-[0.625rem] font-semibold uppercase tracking-wide text-dimmed"
          >
            Ungrouped
          </p>
        {/if}
        {#each tabsFor(null) as tab (tab.id)}
          <BrowserTabRow {tab} onOpenGroupEditor={(id) => (editorGroupId = id)} />
        {/each}
        {#if query !== '' && ungrouped.length > 0 && tabsFor(null).length === 0}
          <p class="px-2 py-1.5 text-[0.6875rem] text-dimmed">No ungrouped tabs match</p>
        {/if}
      {/if}
    {/if}
  </div>
</aside>

{#if editorGroupId !== undefined}
  <BrowserGroupModal groupId={editorGroupId} onClose={() => (editorGroupId = undefined)} />
{/if}
