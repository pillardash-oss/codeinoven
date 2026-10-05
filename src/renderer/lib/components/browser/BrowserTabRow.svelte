<script lang="ts">
  import { Globe, Loader2, Mic, Moon, Pin, Volume2, VolumeX, X } from '@lucide/svelte'
  import { feature } from '$lib/feature-registry'
  import { invoke } from '$lib/ipc.svelte'
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte'
  import { globalBrowser } from '$lib/stores/global-browser.svelte'
  import { browserBookmarks } from '$lib/stores/browser-bookmarks.svelte'
  import { threadNotesState } from '$lib/stores/thread-notes.svelte'
  import { harnessName } from '$lib/components/shared/model-picker-helpers'
  import ModelPickerVendorIcons from '$lib/components/shared/ModelPickerVendorIcons.svelte'
  import { providerCatalog } from '$lib/stores/provider-catalog.svelte'
  import { BROWSER_TAB_CAPTURE_LABEL, browserTabMuteLabel } from '$lib/stores/browser-tab-status'
  import {
    browserTabLabel,
    MAX_GLOBAL_BROWSER_GROUPS,
    type GlobalBrowserTab
  } from '$lib/stores/global-browser-types'
  import { browserTabAccent, browserTabIconUrl } from './browser-tab-appearance'
  import {
    browserAppearanceAccent,
    browserAppearanceHasIcon,
    browserAppearanceIconUrl
  } from './browser-group-appearance'

  interface Props {
    tab: GlobalBrowserTab
    selected: boolean
    onTabClick: (tabId: string, event: MouseEvent) => void
    onTabContextMenu: (tabId: string) => string[]
    onMoveTabsToGroup: (tabIds: string[], groupId: string) => void
    onCreateGroupForTabs: (tabIds: string[]) => void
    onReopenTabsInBox: (tabIds: string[], boxId: string | null) => void
    /** Open the group editor for a group id, or with null to create one. */
    onOpenGroupEditor: (groupId: string | null) => void
    /** Open this tab's own editor (title, colour, icon). */
    onEditTab: (tabId: string) => void
  }

  let {
    tab,
    selected,
    onTabClick,
    onTabContextMenu,
    onMoveTabsToGroup,
    onCreateGroupForTabs,
    onReopenTabsInBox,
    onOpenGroupEditor,
    onEditTab
  }: Props = $props()

  /**
   * One row in the browser tab strip.
   *
   * It reads like a thread row: what the page is, whether it is still loading,
   * and whether it wants the user (audio or a live capture). The row's own
   * controls sit in a cluster beside the activation button, never inside it,
   * which is invalid markup and would also make the mute toggle fire the row.
   * The cluster takes its place in the row's flow instead of floating over the
   * label, so a standing status icon (a pinned pin, the hibernation moon) can
   * never print on top of the tab's name, and revealing the close button on
   * hover shifts nothing. Because the cluster now owns the row's right edge, the
   * hover and active pill is painted by the row itself rather than by the
   * activation button, so the highlight still spans the full width.
   *
   * The row is also the strip's drag handle and drop target: dragging it onto a
   * group header files it under that group, and dropping it beside another tab
   * reorders it and adopts that tab's group. Grouping is deliberately sourced
   * from the row (right-click and drag) rather than a toolbar button.
   */

  const runtime = $derived(globalBrowser.runtimeFor(tab.id))
  const active = $derived(globalBrowser.activeTabId === tab.id)
  const highlighted = $derived(active || selected)
  /** The label the row shows: the user's own title when set, else the page's. */
  const label = $derived(browserTabLabel(tab))
  /** The tab's custom icon as an image, or null to fall back to the favicon. */
  const customIconUrl = $derived(browserTabIconUrl(tab, globalBrowser.tabIconUrl(tab.id)))
  const accent = $derived(browserTabAccent(tab))
  /** While this tab's agent sidebar is open the row grows a second line naming
   *  the model the conversation runs on, so the strip says which agent is
   *  answering without opening the panel. It is drawn as the harness mark beside
   *  the model provider's mark, exactly as every model control in the app draws
   *  it: the conversation is a conversation like any other, and its identity is
   *  the pair that runs it. */
  const agentChat = $derived(
    globalBrowser.agentSidebarShown && active ? globalBrowser.agentChatFor(tab.id) : null
  )
  const agentModel = $derived.by(() => {
    const thread = agentChat?.thread
    const harnessId = thread?.settings?.harnessId
    if (!thread || !harnessId) return null
    const providerId = thread.settings?.providerId ?? ''
    // The provider's display name is what the vendor mark falls back to, so it is
    // resolved from the catalog the model pickers read; an id-only provider (a
    // custom base-URL one) still resolves, because the mark is picked by id first.
    const providers = providerCatalog.cached(thread.projectId) ?? providerCatalog.allCached()
    const providerName =
      providers.find((provider) => provider.id === providerId)?.name ?? providerId
    return { harnessId, providerId, providerName }
  })
  const groups = $derived(globalBrowser.groups)
  /** The box this tab runs in, or null in the default jar. Drives the row's box
   *  badge and the menu's reopen targets. */
  const box = $derived(tab.boxId ? globalBrowser.boxById(tab.boxId) : null)
  const boxAccent = $derived(box ? browserAppearanceAccent(box) : null)
  const boxIcon = $derived(
    box && browserAppearanceHasIcon(box)
      ? browserAppearanceIconUrl(box, globalBrowser.boxIconUrl(box.id))
      : null
  )
  /** True while a drag is over this row and would reorder here. */
  let dropTarget = $state(false)
  /** The box a pending "reopen in box" targets: undefined while none is pending,
   *  null for the default jar. */
  let reopenTarget = $state<string | null | undefined>(undefined)
  const reopenTargetLabel = $derived(
    reopenTarget === undefined
      ? ''
      : reopenTarget === null
        ? 'no box'
        : (globalBrowser.boxById(reopenTarget)?.name ?? 'that box')
  )

  function closeTab(event: MouseEvent): void {
    event.preventDefault()
    event.stopPropagation()
    globalBrowser.close(tab.id)
  }

  /** Start a group from this tab: the group exists before the editor opens, so
   *  the editor always edits something real and the row's placement is settled
   *  even if the user dismisses the dialog. */
  function createGroupFromTab(): void {
    const id = globalBrowser.createGroup('New group')
    globalBrowser.moveToGroup(tab.id, id)
    onOpenGroupEditor(id)
  }

  /** Close this tab and open its page in the chosen box. Confirmed first: a tab
   *  cannot change jars in place, so this really is a close plus an open. */
  function confirmReopen(): void {
    const target = reopenTarget
    reopenTarget = undefined
    if (target === undefined) return
    globalBrowser.reopenInBox(tab.id, target)
  }

  function onDragStart(event: DragEvent): void {
    globalBrowser.beginDrag(tab.id)
    if (!event.dataTransfer) return
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', tab.id)
  }

  function onDragOver(event: DragEvent): void {
    const dragged = globalBrowser.draggingTabId
    if (!dragged || dragged === tab.id) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    dropTarget = true
  }

  function onDrop(event: DragEvent): void {
    dropTarget = false
    const dragged = globalBrowser.draggingTabId ?? event.dataTransfer?.getData('text/plain') ?? ''
    if (!dragged || dragged === tab.id) return
    event.preventDefault()
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect()
    const position = event.clientY < box.top + box.height / 2 ? 'before' : 'after'
    globalBrowser.reorder(dragged, tab.id, position)
    globalBrowser.endDrag()
  }

  /** Both regular and multi-tab actions use OS menus above the native page view. */
  function onContextMenu(event: MouseEvent): void {
    const contextSelection = onTabContextMenu(tab.id)
    event.preventDefault()
    event.stopPropagation()
    const currentTarget = event.currentTarget
    const bounds =
      currentTarget instanceof HTMLElement ? currentTarget.getBoundingClientRect() : null
    if (!bounds) return
    const x = event.clientX || bounds.left + Math.min(bounds.width / 2, 24)
    const y = event.clientY || bounds.top + bounds.height / 2
    const selectedIds = [...contextSelection]

    if (selectedIds.length === 1) {
      const currentTab = globalBrowser.tabById(tab.id)
      if (!currentTab) return
      void invoke(
        'browser:tabContextMenu',
        {
          tabId: currentTab.id,
          title: browserTabLabel(currentTab),
          url: currentTab.url,
          bookmarkAvailable: currentTab.url !== '',
          bookmarked: currentTab.url !== '' && browserBookmarks.isBookmarked(currentTab.url),
          pinned: currentTab.pinned,
          groupId: currentTab.groupId,
          boxId: currentTab.boxId,
          canReopenClosedTab: globalBrowser.canReopenClosedTab,
          groups: groups.map(({ id, name }) => ({ id, name })),
          boxes: globalBrowser.boxes.map(({ id, name }) => ({ id, name }))
        },
        x,
        y
      )
        .then((choice) => {
          if (!choice) return
          switch (choice.action) {
            case 'edit':
              onEditTab(tab.id)
              return
            case 'togglePin':
              globalBrowser.toggleTabPin(tab.id)
              return
            case 'toggleBookmark':
              if (currentTab.url !== '') {
                browserBookmarks.toggle(
                  currentTab.url,
                  browserTabLabel(currentTab),
                  currentTab.favicon
                )
              }
              return
            case 'duplicate':
              globalBrowser.duplicateTab(tab.id)
              return
            case 'newBefore':
              globalBrowser.createTab('', tab.groupId, tab.boxId, {
                tabId: tab.id,
                position: 'before'
              })
              globalBrowser.openAddressSpotlight()
              return
            case 'newTab':
              globalBrowser.createTab('', tab.groupId, tab.boxId, {
                tabId: tab.id,
                position: 'after'
              })
              globalBrowser.openAddressSpotlight()
              return
            case 'newPlaced':
              globalBrowser.createTab('', choice.groupId, choice.boxId, {
                tabId: tab.id,
                position: 'after'
              })
              globalBrowser.openAddressSpotlight()
              return
            case 'createGroup':
              createGroupFromTab()
              return
            case 'editGroup':
              if (tab.groupId) onOpenGroupEditor(tab.groupId)
              return
            case 'removeFromGroup':
              globalBrowser.moveToGroup(tab.id, null)
              return
            case 'moveToGroup':
              globalBrowser.moveToGroup(tab.id, choice.groupId)
              return
            case 'reopenInBox':
              reopenTarget = choice.boxId
              return
            case 'reopenClosed':
              globalBrowser.reopenLastClosedTab()
              return
            case 'close':
              globalBrowser.close(tab.id)
              return
          }
        })
        .catch(() => {})
      return
    }

    void invoke(
      'browser:tabSelectionMenu',
      {
        selectedCount: selectedIds.length,
        groups: groups.map(({ id, name }) => ({ id, name })),
        boxes: globalBrowser.boxes.map(({ id, name }) => ({ id, name })),
        canCreateGroup: groups.length < MAX_GLOBAL_BROWSER_GROUPS
      },
      x,
      y
    )
      .then((choice) => {
        if (!choice) return
        switch (choice.action) {
          case 'moveToGroup':
            onMoveTabsToGroup(selectedIds, choice.groupId)
            return
          case 'createGroup':
            onCreateGroupForTabs(selectedIds)
            return
          case 'reopenInBox':
            onReopenTabsInBox(selectedIds, choice.boxId)
            return
        }
      })
      .catch(() => {})
  }
</script>

<div
  class="group flex items-center rounded-md transition-colors {dropTarget
    ? 'bg-info/10'
    : highlighted
      ? 'bg-elevated'
      : 'hover:bg-elevated'}"
  role="group"
  aria-label={`${label} tab row`}
  data-browser-tab-id={tab.id}
  oncontextmenu={onContextMenu}
>
  <button
    type="button"
    class="flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pr-2 pl-2 text-left"
    aria-current={active}
    aria-pressed={selected}
    title={tab.url || label}
    draggable="true"
    ondragstart={onDragStart}
    ondragend={() => {
      dropTarget = false
      globalBrowser.endDrag()
    }}
    ondragover={onDragOver}
    ondragleave={() => (dropTarget = false)}
    ondrop={onDrop}
    onclick={(event: MouseEvent) => onTabClick(tab.id, event)}
    onauxclick={(event: MouseEvent) => {
      if (event.button === 1) closeTab(event)
    }}
  >
    <span class="flex h-4 w-4 shrink-0 items-center justify-center">
      {#if customIconUrl}
        <img src={customIconUrl} alt="" class="h-4 w-4 rounded-sm object-contain" />
      {:else if runtime.loading}
        <Loader2 size={13} class="animate-spin text-muted" />
      {:else if tab.favicon}
        <img src={tab.favicon} alt="" class="h-4 w-4 rounded-sm object-contain" />
      {:else}
        <Globe size={12} class="text-dimmed" />
      {/if}
    </span>
    <span class="flex min-w-0 flex-1 flex-col">
      <span
        class="truncate text-xs {tab.hibernated && !highlighted
          ? 'text-dimmed'
          : 'text-foreground'} {highlighted ? 'font-medium' : ''}"
        style={accent ? `color: ${accent}` : undefined}
      >
        {label}
      </span>
      {#if agentModel}
        <span
          role="img"
          class="flex items-center gap-0.5"
          title={`${harnessName(agentModel.harnessId)} \u00b7 ${agentModel.providerName || 'No provider'}`}
          aria-label={`Agent conversation on ${harnessName(agentModel.harnessId)}${agentModel.providerName ? ` with ${agentModel.providerName}` : ''}`}
        >
          <ModelPickerVendorIcons
            harnessId={agentModel.harnessId}
            providerId={agentModel.providerId}
            providerName={agentModel.providerName}
          />
        </span>
      {/if}
    </span>
  </button>

  <div class="flex shrink-0 items-center gap-0.5 pr-1">
    {#if box}
      <span
        role="img"
        class="flex h-6 w-6 items-center justify-center"
        title={`In box: ${box.name}`}
        aria-label={`In box ${box.name}`}
      >
        {#if boxIcon}
          <img src={boxIcon} alt="" class="h-3 w-3 rounded-sm object-contain" />
        {:else}
          <span class="h-2.5 w-2.5 rounded-full" style="background-color: {boxAccent}"></span>
        {/if}
      </span>
    {/if}
    {#if tab.pinned}
      <span
        role="img"
        class="flex h-6 w-6 items-center justify-center text-accent"
        title="Pinned tab"
        aria-label="Pinned tab"
      >
        <Pin size={12} />
      </span>
    {/if}
    {#if threadNotesState.has(tab.id)}
      {@const TabNoteIcon = feature('tab-note').icon}
      <span
        role="img"
        class="flex h-6 w-6 items-center justify-center text-dimmed"
        title={`${feature('tab-note').name} available`}
        aria-label={`${feature('tab-note').name} available`}
      >
        <TabNoteIcon size={12} />
      </span>
    {/if}
    {#if runtime.capturing}
      <span
        role="img"
        class="flex h-6 w-6 items-center justify-center text-accent"
        title={BROWSER_TAB_CAPTURE_LABEL}
        aria-label={BROWSER_TAB_CAPTURE_LABEL}
      >
        <Mic size={12} />
      </span>
    {/if}
    {#if runtime.audible || runtime.muted}
      <button
        type="button"
        class="flex h-6 w-6 items-center justify-center rounded-md text-accent transition-colors hover:bg-overlay"
        aria-pressed={runtime.muted}
        title={browserTabMuteLabel(runtime.muted)}
        aria-label={browserTabMuteLabel(runtime.muted)}
        onclick={(event: MouseEvent) => {
          event.stopPropagation()
          globalBrowser.toggleMute(tab.id)
        }}
      >
        {#if runtime.muted}
          <VolumeX size={12} />
        {:else}
          <Volume2 size={12} />
        {/if}
      </button>
    {:else if tab.hibernated}
      <span
        role="img"
        class="flex h-6 w-6 items-center justify-center text-dimmed"
        title="Hibernated to save memory. Open the tab to reload it."
        aria-label="Hibernated tab"
      >
        <Moon size={12} />
      </span>
    {/if}
    <button
      type="button"
      class="flex h-6 w-6 items-center justify-center rounded-md text-muted opacity-0 transition-colors group-hover:opacity-100 hover:bg-overlay hover:text-foreground focus-visible:opacity-100"
      aria-label={`Close ${label}`}
      title={`Close ${label}`}
      onclick={closeTab}
    >
      <X size={12} />
    </button>
  </div>
</div>

{#if reopenTarget !== undefined}
  <ConfirmDialog
    open
    variant="danger"
    title="Reopen in another box?"
    confirmLabel="Close and reopen"
    onCancel={() => (reopenTarget = undefined)}
    onConfirm={confirmReopen}
  >
    <p>
      This tab closes and its address opens again in {reopenTargetLabel}. Cookies stay in their own
      boxes, so the page opens signed out unless that box is already signed in, no matter which
      browser signed it in. The tab's back and forward history is not carried over.
    </p>
  </ConfirmDialog>
{/if}
