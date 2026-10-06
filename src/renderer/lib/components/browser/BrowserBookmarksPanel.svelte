<script lang="ts">
  import { onMount } from 'svelte'
  import { SvelteSet } from 'svelte/reactivity'
  import {
    Bookmark,
    ChevronDown,
    ChevronLeft,
    ChevronUp,
    Ellipsis,
    FolderPlus,
    Globe,
    Pencil,
    Search,
    Trash2,
    X
  } from '@lucide/svelte'
  import { DropdownMenu } from 'bits-ui'
  import {
    browserLibraryHost,
    type BrowserBookmark,
    type BrowserBookmarkGroup
  } from '$shared/browser/browser-library'
  import { browserBookmarks } from '$lib/stores/browser-bookmarks.svelte'
  import { globalBrowser } from '$lib/stores/global-browser.svelte'
  import EmptyState from '$lib/components/ui/EmptyState.svelte'
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte'
  import BrowserLibraryRow from './BrowserLibraryRow.svelte'
  import BrowserBookmarkEditor from './BrowserBookmarkEditor.svelte'
  import BrowserBookmarkGroupEditor from './BrowserBookmarkGroupEditor.svelte'
  import {
    browserBookmarkGroupAccent,
    browserBookmarkGroupIconUrl,
    browserBookmarkIconUrl
  } from './browser-bookmark-appearance'

  /**
   * The saved pages, docked in the browser's right rail.
   *
   * A saved page is quick access the user keeps, so this panel is where it is
   * shaped: a row opens the page in the tab on screen, and its own controls
   * rename, re-address, re-icon, regroup, reorder and remove it. Editing is a fold
   * on the row rather than a dialog, the same shape the boxes and extensions tools
   * use, so the list stays in view while the fields are read; the editor is mounted
   * fresh per fold, which is what makes an unsaved draft go when the fold closes,
   * and a row whose editor is open stops being a drag handle so its fields can be
   * selected with the mouse.
   *
   * Groups fold related pages under a name, a colour and an icon, exactly the way
   * the tab strip folds tabs: a group is a header whose body is the bookmarks
   * filed under it, and the ungrouped ones sit below. A bookmark can be dropped
   * onto a fold header to join it, onto a row to land beside it and adopt that
   * row's fold, or dragged out to the ungrouped header to leave its fold. A group's
   * own editor is a modal, because the group is an identity rather than a row.
   *
   * The row carries the same affordances in both directions: right-clicking
   * anywhere on it opens the menu, and the ellipsis does that same thing in one
   * click.
   *
   * It belongs to the person rather than to a tab, so the panel works with the
   * strip empty as well as with a page on screen.
   *
   * Nothing evicts here, which is why this panel has no cap and no footer control
   * for one: the list only shrinks because the user said so.
   */

  let query = $state('')
  /** The bookmark the user asked to remove, held while the confirmation is up. */
  let removingId = $state<string | null>(null)
  /** The saved page whose editor is folded open on its row, or null. One at a
   *  time, so two drafts can never both claim the fold. */
  let expandedId = $state<string | null>(null)
  /** The row whose menu is open. One menu serves the whole list, so the open row is
   *  identified rather than held, which is also what lets the row's own context
   *  menu open it. */
  let menuOpenId = $state<string | null>(null)
  /** The bookmark being dragged, and where the row under the pointer would take
   *  it. */
  let draggingId = $state<string | null>(null)
  /** The group being dragged, so a drop on another header reorders the folds
   *  instead of filing a bookmark. */
  let draggingGroupId = $state<string | null>(null)
  let dropTargetId = $state<string | null>(null)
  let dropPosition = $state<'before' | 'after' | null>(null)
  /** The fold header under a drag, so it can highlight as a drop target. */
  let groupDropTargetId = $state<string | 'ungrouped' | null>(null)
  /** The folds the user collapsed. Expanded is the default, so only the closed
   *  ones are held. */
  const collapsedGroupIds = new SvelteSet<string>()
  /** Whether the panel is showing the group list or the create page, the same
   *  page shape the boxes panel uses for making a box. */
  let creating = $state(false)
  /** The group whose editor is folded open on its row, or null. One at a time, so
   *  two drafts can never both claim the fold. */
  let expandedGroupId = $state<string | null>(null)
  /** The bookmark whose menu opened the create page, so the group it makes can
   *  receive it once it exists. */
  let pendingGroupBookmarkId = $state<string | null>(null)

  const groups = $derived(browserBookmarks.groups)
  const matching = $derived(browserBookmarks.search(query))
  const ungrouped = $derived(matching.filter((bookmark) => bookmark.groupId === null))
  const trimmedQuery = $derived(query.trim())
  /** The folds worth drawing: every one with no query, only the ones with a match
   *  while filtering. */
  const visibleGroups = $derived(
    trimmedQuery === ''
      ? groups
      : groups.filter((group) => matching.some((bookmark) => bookmark.groupId === group.id))
  )
  const showUngrouped = $derived(groups.length > 0 && (trimmedQuery === '' || ungrouped.length > 0))

  // Ask for the stored list on mount: the panel can be the first browser surface a
  // session opens, and the store only reads the file once the runtime comes up.
  onMount(() => browserBookmarks.start())

  // A saved page's or a group's chosen image icon is a file on disk, so its bytes
  // are read once and cached; this keeps the rows' and headers' icons current
  // without each reading one.
  $effect(() => {
    for (const bookmark of browserBookmarks.bookmarks) {
      if (bookmark.imagePath && !browserBookmarks.iconUrls.has(bookmark.id)) {
        void browserBookmarks.ensureIconLoaded(bookmark.id)
      }
    }
    for (const group of browserBookmarks.groups) {
      if (group.imagePath && !browserBookmarks.iconUrls.has(group.id)) {
        void browserBookmarks.ensureGroupIconLoaded(group.id)
      }
    }
  })

  function remove(): void {
    const id = removingId
    removingId = null
    if (id) browserBookmarks.remove(id)
  }

  /** Open a row's menu, whichever gesture asked for it. */
  function openMenu(event: MouseEvent, id: string): void {
    event.preventDefault()
    menuOpenId = id
  }

  /** Fold a row's editor open, or close it when it is already the one on screen. */
  function toggleExpanded(id: string): void {
    expandedId = expandedId === id ? null : id
  }

  /** Fold a group's body open or closed. */
  function toggleGroupCollapsed(id: string): void {
    if (collapsedGroupIds.has(id)) collapsedGroupIds.delete(id)
    else collapsedGroupIds.add(id)
  }

  /** Fold a group's editor open on its row, or close it when it is already the one
   *  on screen. */
  function toggleGroupEditor(id: string): void {
    expandedGroupId = expandedGroupId === id ? null : id
  }

  /** Show the create page, for a fresh group the bookmark whose menu asked for one
   *  joins once it exists. */
  function openCreatePage(bookmarkId: string | null = null): void {
    collapsedGroupIds.clear()
    expandedGroupId = null
    pendingGroupBookmarkId = bookmarkId
    creating = true
  }

  function closeCreatePage(): void {
    pendingGroupBookmarkId = null
    creating = false
  }

  /** File the pending bookmark into the group that was just made, then return to
   *  the list. A create page opened from the header has no bookmark to place. */
  function onGroupCreated(groupId: string): void {
    if (pendingGroupBookmarkId !== null) {
      browserBookmarks.moveToGroup(pendingGroupBookmarkId, groupId)
    }
    closeCreatePage()
  }

  /** The bookmarks filed under one group, in list order. */
  function groupBookmarks(id: string): BrowserBookmark[] {
    return matching.filter((bookmark) => bookmark.groupId === id)
  }

  // ─── Drag and drop ─────────────────────────────────────────────────────────

  function onDragStart(event: DragEvent, bookmark: BrowserBookmark): void {
    event.stopPropagation()
    draggingId = bookmark.id
    if (!event.dataTransfer) return
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', bookmark.id)
  }

  function onGroupDragStart(event: DragEvent, group: BrowserBookmarkGroup): void {
    draggingGroupId = group.id
    if (!event.dataTransfer) return
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', group.id)
  }

  function onDragOver(event: DragEvent, bookmark: BrowserBookmark): void {
    if (draggingId === null || draggingId === bookmark.id) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect()
    dropTargetId = bookmark.id
    dropPosition = event.clientY < box.top + box.height / 2 ? 'before' : 'after'
  }

  function onDrop(event: DragEvent, bookmark: BrowserBookmark): void {
    event.preventDefault()
    const dragged = draggingId ?? event.dataTransfer?.getData('text/plain') ?? ''
    const position = dropPosition
    endDrag()
    if (dragged === '' || dragged === bookmark.id || position === null) return
    // Resolved against the list on screen, so a drag in a filtered list still lands
    // where the user dropped it. The row names the fold the page joins as well as
    // the place in it, so a drop across a fold is one move.
    const mates = matching.filter((candidate) => candidate.groupId === bookmark.groupId)
    const index = mates.findIndex((candidate) => candidate.id === bookmark.id)
    const before = position === 'before' ? bookmark.id : (mates[index + 1]?.id ?? null)
    browserBookmarks.moveToGroupBefore(dragged, bookmark.groupId, before)
  }

  function onGroupDragOver(event: DragEvent, target: string | 'ungrouped'): void {
    if (draggingId === null && draggingGroupId === null) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    groupDropTargetId = target
  }

  function onGroupDrop(event: DragEvent, group: BrowserBookmarkGroup | null): void {
    event.preventDefault()
    const draggedGroup = draggingGroupId
    const draggedBookmark = draggingId ?? event.dataTransfer?.getData('text/plain') ?? ''
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect()
    const beforeHalf = event.clientY < box.top + box.height / 2
    endDrag()
    if (draggedGroup !== null) {
      if (!group || draggedGroup === group.id) return
      const order = groups.map((candidate) => candidate.id)
      const index = order.indexOf(group.id)
      const before = beforeHalf ? group.id : (order[index + 1] ?? null)
      browserBookmarks.moveGroupBefore(draggedGroup, before)
      return
    }
    if (draggedBookmark !== '') browserBookmarks.moveToGroup(draggedBookmark, group?.id ?? null)
  }

  function endDrag(): void {
    draggingId = null
    draggingGroupId = null
    dropTargetId = null
    dropPosition = null
    groupDropTargetId = null
  }

  /** Move a bookmark one place up among the pages sharing its fold. */
  function moveUp(bookmark: BrowserBookmark): void {
    const mates = matching.filter((candidate) => candidate.groupId === bookmark.groupId)
    const index = mates.findIndex((candidate) => candidate.id === bookmark.id)
    const previous = mates[index - 1]
    if (!previous) return
    browserBookmarks.moveBefore(bookmark.id, previous.id)
  }

  /** Move a bookmark one place down among the pages sharing its fold: in front of
   *  whatever follows the next one, or to the end when this is the second to
   *  last. */
  function moveDown(bookmark: BrowserBookmark): void {
    const mates = matching.filter((candidate) => candidate.groupId === bookmark.groupId)
    const index = mates.findIndex((candidate) => candidate.id === bookmark.id)
    browserBookmarks.moveBefore(bookmark.id, mates[index + 2]?.id ?? null)
  }
</script>

{#snippet bookmarkRow(bookmark: BrowserBookmark)}
  {@const mates = matching.filter((candidate) => candidate.groupId === bookmark.groupId)}
  {@const rowIndex = mates.findIndex((candidate) => candidate.id === bookmark.id)}
  {@const expanded = expandedId === bookmark.id}
  <li
    class="relative"
    draggable={!expanded}
    ondragstart={(event: DragEvent) => onDragStart(event, bookmark)}
    ondragover={(event: DragEvent) => onDragOver(event, bookmark)}
    ondragleave={() => {
      if (dropTargetId === bookmark.id) {
        dropTargetId = null
        dropPosition = null
      }
    }}
    ondrop={(event: DragEvent) => onDrop(event, bookmark)}
    ondragend={endDrag}
    oncontextmenu={(event: MouseEvent) => openMenu(event, bookmark.id)}
  >
    {#if dropTargetId === bookmark.id && dropPosition === 'before'}
      <span class="pointer-events-none absolute inset-x-1 top-0 h-0.5 rounded bg-primary"></span>
    {/if}
    <BrowserLibraryRow
      title={bookmark.title}
      meta={browserLibraryHost(bookmark.url)}
      url={bookmark.url}
      onOpen={() => globalBrowser.openInActiveTab(bookmark.url)}
    >
      {#snippet icon()}
        {@render BookmarkIcon({ bookmark })}
      {/snippet}
      {#snippet actions()}
        <DropdownMenu.Root
          open={menuOpenId === bookmark.id}
          onOpenChange={(open) => (menuOpenId = open ? bookmark.id : null)}
        >
          <DropdownMenu.Trigger
            class="flex h-6 w-6 items-center justify-center rounded-md text-dimmed opacity-0 transition-colors group-hover:opacity-100 hover:bg-overlay hover:text-foreground focus-visible:opacity-100 data-[state=open]:bg-elevated data-[state=open]:text-foreground data-[state=open]:opacity-100"
            aria-label={`Options for ${bookmark.title}`}
            title="Bookmark options"
            oncontextmenu={(event: MouseEvent) => event.preventDefault()}
          >
            <Ellipsis size={13} />
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              side="bottom"
              align="end"
              sideOffset={4}
              collisionPadding={8}
              class="z-50 w-52 overflow-hidden rounded-xl border bg-surface p-1 shadow-lg"
            >
              <p
                class="truncate px-2.5 py-1 text-[0.5625rem] font-semibold uppercase tracking-wide text-dimmed"
              >
                {bookmark.title}
              </p>
              <DropdownMenu.Item
                class="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-foreground outline-none transition-colors hover:bg-elevated focus:bg-elevated"
                onSelect={() => (expandedId = bookmark.id)}
              >
                <Pencil size={13} class="shrink-0 text-muted" />
                Edit bookmark
              </DropdownMenu.Item>
              <DropdownMenu.Sub>
                <DropdownMenu.SubTrigger
                  class="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-foreground outline-none transition-colors hover:bg-elevated focus:bg-elevated data-[state=open]:bg-elevated"
                >
                  <FolderPlus size={13} class="shrink-0 text-muted" />
                  Move to group
                </DropdownMenu.SubTrigger>
                <DropdownMenu.SubContent
                  class="z-50 w-48 overflow-hidden rounded-xl border bg-surface p-1 shadow-lg"
                  sideOffset={4}
                >
                  <DropdownMenu.Item
                    class="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-foreground outline-none transition-colors hover:bg-elevated focus:bg-elevated data-[disabled]:opacity-40"
                    disabled={bookmark.groupId === null}
                    onSelect={() => browserBookmarks.moveToGroup(bookmark.id, null)}
                  >
                    Ungrouped
                  </DropdownMenu.Item>
                  {#each groups as group (group.id)}
                    <DropdownMenu.Item
                      class="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-foreground outline-none transition-colors hover:bg-elevated focus:bg-elevated data-[disabled]:opacity-40"
                      disabled={bookmark.groupId === group.id}
                      onSelect={() => browserBookmarks.moveToGroup(bookmark.id, group.id)}
                    >
                      <span
                        class="h-2 w-2 shrink-0 rounded-full"
                        style:background-color={browserBookmarkGroupAccent(group)}
                      ></span>
                      <span class="truncate">{group.name}</span>
                    </DropdownMenu.Item>
                  {/each}
                  <DropdownMenu.Separator class="mx-2 my-1 h-px bg-border" />
                  <DropdownMenu.Item
                    class="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-foreground outline-none transition-colors hover:bg-elevated focus:bg-elevated"
                    onSelect={() => {
                      expandedId = null
                      openCreatePage(bookmark.id)
                    }}
                  >
                    <FolderPlus size={13} class="shrink-0 text-muted" />
                    New group…
                  </DropdownMenu.Item>
                </DropdownMenu.SubContent>
              </DropdownMenu.Sub>
              <DropdownMenu.Item
                class="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-foreground outline-none transition-colors hover:bg-elevated focus:bg-elevated data-[disabled]:opacity-40"
                disabled={rowIndex <= 0}
                onSelect={() => moveUp(bookmark)}
              >
                <ChevronUp size={13} class="shrink-0 text-muted" />
                Move up
              </DropdownMenu.Item>
              <DropdownMenu.Item
                class="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-foreground outline-none transition-colors hover:bg-elevated focus:bg-elevated data-[disabled]:opacity-40"
                disabled={rowIndex === mates.length - 1}
                onSelect={() => moveDown(bookmark)}
              >
                <ChevronDown size={13} class="shrink-0 text-muted" />
                Move down
              </DropdownMenu.Item>
              <DropdownMenu.Separator class="mx-2 my-1 h-px bg-border" />
              <DropdownMenu.Item
                class="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-danger outline-none transition-colors hover:bg-danger/10 focus:bg-danger/10"
                onSelect={() => (removingId = bookmark.id)}
              >
                <Trash2 size={13} />
                Remove bookmark
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
        <button
          type="button"
          class={[
            'flex h-6 w-6 items-center justify-center rounded-md text-muted transition-colors group-hover:opacity-100 hover:bg-overlay hover:text-foreground focus-visible:opacity-100',
            expanded ? 'opacity-100' : 'opacity-0'
          ]}
          title={expanded ? `Hide the editor for ${bookmark.title}` : `Edit ${bookmark.title}`}
          aria-label={expanded ? `Hide the editor for ${bookmark.title}` : `Edit ${bookmark.title}`}
          aria-expanded={expanded}
          aria-controls="bookmark-editor-{bookmark.id}"
          onclick={() => toggleExpanded(bookmark.id)}
        >
          <ChevronDown size={13} class={expanded ? 'rotate-180' : ''} />
        </button>
      {/snippet}
    </BrowserLibraryRow>

    {#if expanded}
      <!-- A right-click inside the editor belongs to its fields, not to the row's
           options menu. -->
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        id="bookmark-editor-{bookmark.id}"
        class="mb-1 rounded-lg border p-3"
        oncontextmenu={(event: MouseEvent) => event.stopPropagation()}
      >
        <BrowserBookmarkEditor bookmarkId={bookmark.id} onSaved={() => (expandedId = null)} />
      </div>
    {/if}
    {#if dropTargetId === bookmark.id && dropPosition === 'after'}
      <span class="pointer-events-none absolute inset-x-1 bottom-0 h-0.5 rounded bg-primary"></span>
    {/if}
  </li>
{/snippet}

<div class="flex h-full min-h-0 flex-col" data-drop-region="browser-bookmarks">
  {#if creating}
    <div class="flex h-full min-h-0 flex-col">
      <div class="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
        <button
          type="button"
          class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-elevated hover:text-foreground"
          title="Back to bookmarks"
          aria-label="Back to bookmarks"
          onclick={closeCreatePage}
        >
          <ChevronLeft size={15} />
        </button>
        <p class="text-xs font-medium text-foreground">New group</p>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto p-3">
        <p class="mb-3 text-[0.625rem] leading-relaxed text-dimmed">
          A group folds related bookmarks under a name, a colour and an icon. Drop bookmarks onto
          its header afterwards to file them.
        </p>
        <BrowserBookmarkGroupEditor group={null} onSaved={onGroupCreated} />
      </div>
    </div>
  {:else}
    <div class="shrink-0 space-y-1.5 border-b border-border px-3 py-2">
      <div class="flex items-center gap-1.5 rounded-lg bg-elevated px-2.5">
        <Search size={13} class="shrink-0 text-dimmed" />
        <input
          type="text"
          class="h-7 min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-dimmed"
          placeholder="Search bookmarks"
          aria-label="Search bookmarks"
          spellcheck="false"
          autocomplete="off"
          bind:value={query}
        />
        {#if query !== ''}
          <button
            type="button"
            class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-dimmed transition-colors hover:bg-overlay hover:text-foreground"
            aria-label="Clear the bookmark search"
            title="Clear search"
            onclick={() => (query = '')}
          >
            <X size={13} />
          </button>
        {/if}
      </div>
      <button
        type="button"
        class="flex w-full items-center justify-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground"
        title="Create a group for bookmarks"
        aria-label="Create a group for bookmarks"
        onclick={() => openCreatePage()}
      >
        <FolderPlus size={13} />
        New group
      </button>
    </div>

    {#if browserBookmarks.bookmarks.length === 0 && groups.length === 0}
      <EmptyState
        icon={Bookmark}
        title="No bookmarks yet"
        description="Save a page from the star beside its address, and it appears here to return to at any time."
      />
    {:else if matching.length === 0 && trimmedQuery !== ''}
      <EmptyState
        icon={Search}
        title="No matching bookmarks"
        description="Nothing you saved matches that search."
      />
    {:else}
      <ul class="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
        {#each visibleGroups as group (group.id)}
          {@const groupIconUrl = browserBookmarkGroupIconUrl(
            group,
            browserBookmarks.iconUrl(group.id)
          )}
          {@const accent = browserBookmarkGroupAccent(group)}
          {@const collapsed = collapsedGroupIds.has(group.id)}
          <li class="mb-1">
            <div
              class="flex items-center gap-1 rounded-lg px-1.5 py-1 transition-colors {groupDropTargetId ===
              group.id
                ? 'ring-1 ring-info'
                : ''}"
              style="background-color: {accent}1a"
              draggable
              role="group"
              aria-label={`${group.name}, drop a bookmark here to move it into this group`}
              ondragstart={(event: DragEvent) => onGroupDragStart(event, group)}
              ondragover={(event: DragEvent) => onGroupDragOver(event, group.id)}
              ondragleave={() => {
                if (groupDropTargetId === group.id) groupDropTargetId = null
              }}
              ondrop={(event: DragEvent) => onGroupDrop(event, group)}
              ondragend={endDrag}
              class:opacity-50={draggingGroupId === group.id}
            >
              <button
                type="button"
                class="flex min-w-0 flex-1 items-center gap-2 px-1 py-0.5 text-left"
                title={collapsed ? `Expand ${group.name}` : `Collapse ${group.name}`}
                aria-label={collapsed ? `Expand ${group.name}` : `Collapse ${group.name}`}
                aria-expanded={!collapsed}
                onclick={() => toggleGroupCollapsed(group.id)}
              >
                <ChevronDown
                  size={12}
                  class="shrink-0 text-muted {collapsed ? '-rotate-90' : ''}"
                />
                {#if groupIconUrl}
                  <img
                    src={groupIconUrl}
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
                <span class="shrink-0 text-[0.625rem] text-dimmed">
                  {browserBookmarks.inGroup(group.id).length}
                </span>
              </button>
              <button
                type="button"
                class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-overlay hover:text-foreground"
                title={`Edit ${group.name}`}
                aria-label={`Edit ${group.name}`}
                onclick={() => toggleGroupEditor(group.id)}
              >
                <Pencil size={12} />
              </button>
            </div>
            {#if expandedGroupId === group.id}
              <div class="mb-1 rounded-lg border p-3">
                <BrowserBookmarkGroupEditor
                  {group}
                  onSaved={() => (expandedGroupId = null)}
                  onDeleted={() => (expandedGroupId = null)}
                />
              </div>
            {/if}
            {#if !collapsed}
              <ul class="mt-0.5 ml-2 space-y-0.5 border-l pl-1.5">
                {#each groupBookmarks(group.id) as bookmark (bookmark.id)}
                  {@render bookmarkRow(bookmark)}
                {/each}
                {#if groupBookmarks(group.id).length === 0}
                  <li class="px-2 py-1.5 text-[0.6875rem] text-dimmed">
                    {trimmedQuery === ''
                      ? 'No bookmarks in this group'
                      : 'No matches in this group'}
                  </li>
                {/if}
              </ul>
            {/if}
          </li>
        {/each}

        {#if showUngrouped}
          <li
            ondragover={(event: DragEvent) => onGroupDragOver(event, 'ungrouped')}
            ondragleave={() => {
              if (groupDropTargetId === 'ungrouped') groupDropTargetId = null
            }}
            ondrop={(event: DragEvent) => onGroupDrop(event, null)}
            ondragend={endDrag}
          >
            <p
              class="flex items-center gap-1 px-2 pt-1 pb-0.5 text-[0.625rem] font-semibold uppercase tracking-wide transition-colors {groupDropTargetId ===
              'ungrouped'
                ? 'text-info'
                : 'text-dimmed'}"
            >
              Ungrouped
            </p>
            <ul class="ml-2 space-y-0.5 border-l pl-1.5">
              {#each ungrouped as bookmark (bookmark.id)}
                {@render bookmarkRow(bookmark)}
              {/each}
            </ul>
          </li>
        {/if}

        {#if groups.length === 0}
          {#each matching as bookmark (bookmark.id)}
            {@render bookmarkRow(bookmark)}
          {/each}
        {/if}
      </ul>
      <p class="shrink-0 border-t border-border px-3 py-1.5 text-[0.625rem] text-dimmed">
        {matching.length}
        {matching.length === 1 ? 'saved page' : 'saved pages'}
        {#if groups.length > 0}
          · {groups.length}
          {groups.length === 1 ? 'group' : 'groups'}
        {/if}
      </p>
    {/if}
  {/if}
</div>

{#snippet BookmarkIcon({ bookmark }: { bookmark: BrowserBookmark })}
  {@const iconUrl = browserBookmarkIconUrl(bookmark, browserBookmarks.iconUrl(bookmark.id))}
  {#if iconUrl}
    <img src={iconUrl} alt="" class="h-4 w-4 rounded-sm object-contain" />
  {:else if bookmark.favicon}
    <img src={bookmark.favicon} alt="" class="h-4 w-4 rounded-sm object-contain" />
  {:else}
    <Globe size={12} class="text-dimmed" />
  {/if}
{/snippet}

<ConfirmDialog
  open={removingId !== null}
  title="Remove this bookmark?"
  confirmLabel="Remove bookmark"
  variant="danger"
  onConfirm={remove}
  onCancel={() => (removingId = null)}
>
  <p>The page leaves your bookmarks. You can still find it in your browsing history.</p>
</ConfirmDialog>
