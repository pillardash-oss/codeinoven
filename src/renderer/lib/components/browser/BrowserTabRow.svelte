<script lang="ts">
  import {
    FolderInput,
    FolderMinus,
    FolderPlus,
    Globe,
    Loader2,
    Mic,
    Moon,
    Pencil,
    StickyNote,
    Volume2,
    VolumeX,
    X
  } from '@lucide/svelte'
  import { ContextMenu } from 'bits-ui'
  import { globalBrowser } from '$lib/stores/global-browser.svelte'
  import { BROWSER_TAB_CAPTURE_LABEL, browserTabMuteLabel } from '$lib/stores/browser-tab-status'
  import { tabHasNote, type GlobalBrowserTab } from '$lib/stores/global-browser-types'

  interface Props {
    tab: GlobalBrowserTab
    /** Open the group editor for a group id, or with null to create one. */
    onOpenGroupEditor: (groupId: string | null) => void
  }

  let { tab, onOpenGroupEditor }: Props = $props()

  /**
   * One row in the browser tab strip.
   *
   * It reads like a thread row: what the page is, whether it is still loading,
   * and whether it wants the user (audio or a live capture). The row's own
   * controls sit in an absolutely positioned cluster so they are never nested
   * inside the row's activation button, which is invalid markup and would also
   * make the mute toggle fire the row.
   *
   * The row is also the strip's drag handle and drop target: dragging it onto a
   * group header files it under that group, and dropping it beside another tab
   * reorders it and adopts that tab's group. Grouping is deliberately sourced
   * from the row (right-click and drag) rather than a toolbar button.
   */

  const runtime = $derived(globalBrowser.runtimeFor(tab.id))
  const active = $derived(globalBrowser.activeTabId === tab.id)
  const groups = $derived(globalBrowser.groups)
  const group = $derived(tab.groupId ? globalBrowser.groupById(tab.groupId) : null)
  /** True while a drag is over this row and would reorder here. */
  let dropTarget = $state(false)

  const itemClass =
    'flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 text-xs text-foreground outline-none data-[highlighted]:bg-elevated data-[disabled]:opacity-40'

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
</script>

<ContextMenu.Root>
  <ContextMenu.Trigger class="contents">
    <div
      class="group relative flex items-center rounded-md transition-colors {dropTarget
        ? 'bg-info/10'
        : ''}"
    >
      <button
        type="button"
        class="flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pr-2 pl-2 text-left transition-colors {active
          ? 'bg-elevated'
          : 'hover:bg-elevated'}"
        aria-current={active}
        title={tab.url || tab.title}
        draggable="true"
        ondragstart={onDragStart}
        ondragend={() => {
          dropTarget = false
          globalBrowser.endDrag()
        }}
        ondragover={onDragOver}
        ondragleave={() => (dropTarget = false)}
        ondrop={onDrop}
        onclick={() => globalBrowser.activate(tab.id)}
        onauxclick={(event: MouseEvent) => {
          if (event.button === 1) closeTab(event)
        }}
      >
        <span class="flex h-4 w-4 shrink-0 items-center justify-center">
          {#if runtime.loading}
            <Loader2 size={13} class="animate-spin text-muted" />
          {:else if tab.favicon}
            <img src={tab.favicon} alt="" class="h-4 w-4 rounded-sm object-contain" />
          {:else}
            <Globe size={12} class="text-dimmed" />
          {/if}
        </span>
        <span
          class="min-w-0 flex-1 truncate text-xs {tab.hibernated
            ? 'text-dimmed'
            : 'text-foreground'} {active ? 'font-medium' : ''}"
        >
          {tab.title}
        </span>
      </button>

      <div class="pointer-events-none absolute right-1 flex items-center gap-0.5">
        {#if tabHasNote(tab)}
          <span
            role="img"
            class="pointer-events-none flex h-6 w-6 items-center justify-center text-dimmed"
            title="This tab has a note"
            aria-label="Tab has a note"
          >
            <StickyNote size={12} />
          </span>
        {/if}
        {#if runtime.capturing}
          <span
            role="img"
            class="pointer-events-none flex h-6 w-6 items-center justify-center text-accent"
            title={BROWSER_TAB_CAPTURE_LABEL}
            aria-label={BROWSER_TAB_CAPTURE_LABEL}
          >
            <Mic size={12} />
          </span>
        {/if}
        {#if runtime.audible || runtime.muted}
          <button
            type="button"
            class="pointer-events-auto flex h-6 w-6 items-center justify-center rounded-md text-accent transition-colors hover:bg-overlay"
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
            class="pointer-events-none flex h-6 w-6 items-center justify-center text-dimmed"
            title="Hibernated to save memory. Open the tab to reload it."
            aria-label="Hibernated tab"
          >
            <Moon size={12} />
          </span>
        {/if}
        <button
          type="button"
          class="pointer-events-auto flex h-6 w-6 items-center justify-center rounded-md text-muted opacity-0 transition-colors group-hover:opacity-100 hover:bg-overlay hover:text-foreground focus-visible:opacity-100"
          aria-label={`Close ${tab.title}`}
          title={`Close ${tab.title}`}
          onclick={closeTab}
        >
          <X size={12} />
        </button>
      </div>
    </div>
  </ContextMenu.Trigger>

  <ContextMenu.Portal>
    <ContextMenu.Content
      avoidCollisions
      collisionPadding={12}
      updatePositionStrategy="always"
      class="z-50 max-h-[calc(100vh-1.5rem)] min-w-56 overflow-y-auto rounded-lg border border-border bg-surface p-1 shadow-lg"
    >
      <p
        class="truncate px-2.5 py-1 text-[0.5625rem] font-semibold uppercase tracking-wide text-dimmed"
      >
        {tab.title}
      </p>
      <ContextMenu.Item class={itemClass} onSelect={createGroupFromTab}>
        <FolderPlus size={13} class="shrink-0 text-muted" />
        New tab group
      </ContextMenu.Item>
      {#if group}
        <ContextMenu.Item class={itemClass} onSelect={() => onOpenGroupEditor(tab.groupId)}>
          <Pencil size={13} class="shrink-0 text-muted" />
          Edit {group.name}
        </ContextMenu.Item>
        <ContextMenu.Item
          class={itemClass}
          onSelect={() => globalBrowser.moveToGroup(tab.id, null)}
        >
          <FolderMinus size={13} class="shrink-0 text-muted" />
          Remove from group
        </ContextMenu.Item>
      {/if}

      {#if groups.some((candidate) => candidate.id !== tab.groupId)}
        <ContextMenu.Separator class="my-1 h-px bg-border" />
        {#each groups.filter((candidate) => candidate.id !== tab.groupId) as candidate (candidate.id)}
          <ContextMenu.Item
            class={itemClass}
            onSelect={() => globalBrowser.moveToGroup(tab.id, candidate.id)}
          >
            <FolderInput size={13} class="shrink-0 text-muted" />
            Move to {candidate.name}
          </ContextMenu.Item>
        {/each}
      {/if}

      <ContextMenu.Separator class="my-1 h-px bg-border" />
      <ContextMenu.Item
        class="{itemClass} text-danger data-[highlighted]:bg-danger/10"
        onSelect={() => globalBrowser.close(tab.id)}
      >
        <X size={13} class="shrink-0" />
        Close tab
      </ContextMenu.Item>
    </ContextMenu.Content>
  </ContextMenu.Portal>
</ContextMenu.Root>
