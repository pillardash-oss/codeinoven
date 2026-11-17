<script lang="ts">
  import CioClose from '@pdslng/cio-icon/CioClose.svelte'
  import CioEllipsis from '@pdslng/cio-icon/CioEllipsis.svelte'
  import CioPin from '@pdslng/cio-icon/CioPin.svelte'
  import CioPlus from '@pdslng/cio-icon/CioPlus.svelte'
  import { SvelteSet } from 'svelte/reactivity'
  import { tick } from 'svelte'
  import type { Attachment } from 'svelte/attachments'
  import { Portal } from 'bits-ui'
  import PickerMenuShell from '$lib/components/shared/PickerMenuShell.svelte'
  import ThreadDropdown from '$lib/components/shared/ThreadDropdown.svelte'
  import ThreadHoverPopover from '$lib/components/shared/ThreadHoverPopover.svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import ThreadDeleteConfirm from '$lib/components/ui/ThreadDeleteConfirm.svelte'
  import AssistantOptionsMenu from '$lib/components/assistant/AssistantOptionsMenu.svelte'
  import StatusBadge from '$lib/components/shared/StatusBadge.svelte'
  import { createThreadActionsMenu } from '$lib/components/shared/thread-actions-menu.svelte'
  import { createThreadHoverPopover } from '$lib/components/shared/thread-hover-popover.svelte'
  import {
    THREAD_HOVER_POPOVER_SURFACE_CLASS,
    threadHoverPopoverStyle
  } from '$lib/components/shared/thread-hover-popover-layout'
  import { isThreadLiveWorking, statusBadgeForThread } from '$lib/thread-status-badge'
  import {
    AssistantDefaultIcon,
    assistantAccentColor,
    getAssistantIcon
  } from '$lib/assistant-icons'
  import { assistantHeaderTabs } from '$lib/stores/assistant-header-tabs.svelte'
  import { assistantTabOrder, type AssistantTabGroup } from '$lib/stores/assistant-tab-order.svelte'
  import { assistants as assistantStore } from '$lib/stores/assistants.svelte'
  import { reportError } from '$lib/stores/app-errors.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import { relativeTimeClock } from '$lib/relative-time.svelte'
  import { formatCompactAge } from '$shared/date-time-format'
  import type { ThreadStatusTone } from '$shared/thread-status-policy'
  import { DON_ASSISTANT_ID, isAssistantSetupThread, type Thread } from '$shared/types'

  /**
   * The assistant view's header centre.
   *
   * It is the one page whose threads sit under the bar instead of in the sidebar.
   * The open assistant's mark, colour and name are fixed at the left, the plus
   * beside the name adds a task to that assistant, and its threads follow as tabs
   * on the right.
   *
   * Pinned threads keep their own group nearest the name, divided from the rest by
   * a rule: the two groups never mix, and each holds its newest few tabs with the
   * remainder behind a count. The thread on screen always keeps a tab of its own,
   * taking the free slot after its group's window when it is not among them, so a
   * thread picked from the count appears without pushing one of the few tabs the
   * group is allowed out of sight.
   *
   * Hovering a tab opens the same thread popover a row does, the assistant's mark
   * becomes an ellipsis under the pointer to say a menu is there, right-clicking a
   * tab opens that thread's actions, and right-clicking the name opens the
   * assistant's own menu. A tab is also the handle that rearranges the strip:
   * dragging one lands it beside another inside its own group, and the chosen
   * arrangement is remembered instead of falling back to recency.
   */

  /** Unpinned tabs shown before the rest fold behind the count. */
  const OPEN_TABS = 4
  /** Pinned tabs are the ones the user chose, so they get a shallower window. */
  const PINNED_TABS = 3
  /** Threads with no assistant still need a strip when one of them is open, so
   *  they gather under this name instead of vanishing with the sidebar rows. */
  const UNASSIGNED_LABEL = 'Tasks'
  /** The order key the assistant-less tasks use: they have no assistant id, but
   *  they are still one strip the user can arrange. */
  const UNASSIGNED_ORDER_KEY = 'unassigned'

  let selectedThread = $derived(workspaceState.selectedThread)
  let groupAssistant = $derived(
    selectedThread?.assistantId ? assistantStore.assistantForTask(selectedThread) : null
  )
  let groupLabel = $derived(
    selectedThread ? (groupAssistant?.name ?? UNASSIGNED_LABEL) : 'Assistant'
  )
  let groupIcon = $derived(
    groupAssistant
      ? getAssistantIcon(groupAssistant, assistantStore.iconUrls.get(groupAssistant.id) ?? null)
      : null
  )
  let groupColor = $derived(
    groupAssistant ? assistantAccentColor(groupAssistant) : 'var(--color-muted)'
  )
  /**
   * Don's conversations are tabs like any other assistant's threads: one per topic,
   * each with its own context and its own name. The mark, the plus and the strip
   * therefore behave exactly as they do for the rest of the roster.
   */
  let isDon = $derived(groupAssistant?.id === DON_ASSISTANT_ID)

  let assistantMenuOpen = $state(false)

  /**
   * The threads the strip draws: the open assistant's tasks and the runs of their
   * executions, most recently active first. With no assistant they are the
   * assistant-less tasks, which have no sidebar row any more.
   */
  let groupThreads = $derived.by(() => {
    if (!selectedThread) return [] as Thread[]
    const assistantId = groupAssistant?.id ?? null
    return assistantHeaderTabs.threads
      .filter((thread) => (assistantId ? thread.assistantId === assistantId : !thread.assistantId))
      .slice()
      .sort((a, b) => b.lastActivity - a.lastActivity)
  })

  /** Pinned threads are their own group: a pin is a choice, not a recency. */
  let pinnedGroup = $derived(groupThreads.filter((thread) => thread.pinned))
  let openGroup = $derived(groupThreads.filter((thread) => !thread.pinned))

  /**
   * The state the open assistant's mark reports, taken from its own threads.
   *
   * The assistant's colour is its identity; its state is not. The mark reads the
   * same badge every row and tab reads and wears that badge's own tone: the
   * thread working, parked on the user, holding a reviewable spec, or failed. The
   * most urgent state wins, because the mark stands for the whole assistant.
   */
  const ASSISTANT_STATE_PRIORITY: Record<ThreadStatusTone, number> = {
    error: 6,
    attention: 5,
    missed: 5,
    spec: 4,
    'working-paused': 3,
    working: 2,
    done: 1,
    todo: 0
  }

  let assistantState = $derived.by(
    (): { tone: ThreadStatusTone; label: string; working: boolean } | null => {
      let best: { tone: ThreadStatusTone; label: string; working: boolean } | null = null
      for (const thread of groupThreads) {
        const liveWorking = isThreadLiveWorking(thread)
        const badge = statusBadgeForThread(thread, liveWorking)
        const tone = badge.tone
        if (!tone || tone === 'todo' || tone === 'done') continue
        if (best && ASSISTANT_STATE_PRIORITY[tone] <= ASSISTANT_STATE_PRIORITY[best.tone]) continue
        best = { tone, label: badge.label, working: tone === 'working' && liveWorking }
      }
      return best
    }
  )

  /** Whose arrangement the strip remembers, per group. */
  let orderKey = $derived(groupAssistant?.id ?? UNASSIGNED_ORDER_KEY)

  /**
   * One group in the order the user dragged it into, with any thread that
   * arrangement has never seen ahead of the rest in recency order: a task just
   * created, or a thread just pinned, belongs at the head where it is found.
   */
  function arranged(list: readonly Thread[], stored: readonly string[]): Thread[] {
    if (stored.length === 0) return [...list]
    const known = new SvelteSet(stored)
    const placed: Thread[] = []
    for (const id of stored) {
      const thread = list.find((candidate) => candidate.id === id)
      if (thread) placed.push(thread)
    }
    return [...list.filter((thread) => !known.has(thread.id)), ...placed]
  }

  let orderedPinned = $derived(
    arranged(pinnedGroup, assistantTabOrder.orderFor(orderKey, 'pinned'))
  )
  let orderedOpen = $derived(arranged(openGroup, assistantTabOrder.orderFor(orderKey, 'open')))

  /** The few tabs one group may hold before the rest fold behind the count. */
  let windowPinned = $derived(orderedPinned.slice(0, PINNED_TABS))
  let windowOpen = $derived(orderedOpen.slice(0, OPEN_TABS))

  /**
   * The thread on screen always keeps a tab, taking the free slot after its
   * group's window when it is not among them. Picking another thread from the
   * count therefore replaces that one extra slot instead of evicting a tab the
   * user did not touch.
   */
  function withActiveSlot(all: readonly Thread[], base: readonly Thread[]): Thread[] {
    const active = selectedThread
    if (!active) return [...base]
    if (base.some((thread) => thread.id === active.id)) return [...base]
    const open = all.find((thread) => thread.id === active.id)
    return open ? [...base, open] : [...base]
  }

  function withoutShown(list: readonly Thread[], shown: readonly Thread[]): Thread[] {
    const ids = new SvelteSet(shown.map((thread) => thread.id))
    return list.filter((thread) => !ids.has(thread.id))
  }

  let visiblePinned = $derived(withActiveSlot(orderedPinned, windowPinned))
  let visibleOpen = $derived(withActiveSlot(orderedOpen, windowOpen))
  let hiddenPinned = $derived(withoutShown(orderedPinned, visiblePinned))
  let hiddenOpen = $derived(withoutShown(orderedOpen, visibleOpen))

  let activeId = $derived(selectedThread?.id ?? null)

  // ─── Overflow picker (one per group) ──────────────────────────────────────
  type OverflowKind = 'pinned' | 'open'

  let overflow = $state<OverflowKind | null>(null)
  let overflowQuery = $state('')
  let overflowAnchor: HTMLElement | null = null
  /**
   * The open menu itself. It lives in the browser's top layer, so it is not a
   * descendant of the count that opened it, and a press inside it has to be
   * recognised as the menu's own or the outside-press handler below would tear
   * the menu down on pointerdown and the click would land on nothing.
   */
  let overflowSurface = $state<HTMLDivElement | null>(null)

  let overflowThreads = $derived(
    overflow === 'pinned' ? hiddenPinned : overflow === 'open' ? hiddenOpen : []
  )

  let filteredOverflow = $derived.by(() => {
    const query = overflowQuery.trim().toLowerCase()
    return query
      ? overflowThreads.filter((thread) => thread.title.toLowerCase().includes(query))
      : overflowThreads
  })

  function toggleOverflow(kind: OverflowKind, event: MouseEvent): void {
    if (overflow === kind) {
      closeOverflow()
      return
    }
    overflowAnchor = event.currentTarget as HTMLElement
    overflowQuery = ''
    overflow = kind
  }

  function closeOverflow(): void {
    overflow = null
    overflowQuery = ''
    overflowAnchor = null
  }

  function pickOverflow(thread: Thread): void {
    closeOverflow()
    assistantHeaderTabs.openThread(thread)
  }

  function onOverflowKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeOverflow()
    } else if (event.key === 'Enter' && filteredOverflow[0]) {
      event.preventDefault()
      pickOverflow(filteredOverflow[0])
    }
  }

  function captureOverflowSurface(node: HTMLDivElement): () => void {
    overflowSurface = node
    return () => {
      if (overflowSurface === node) overflowSurface = null
    }
  }

  /**
   * Lift the menu into the browser's top layer. The header is its own stacking
   * context, so a z-index alone loses to the panels below it; a manual popover
   * escapes every stacking context and is anchored under the count that opened it.
   */
  function topLayer(node: HTMLDivElement): () => void {
    const anchor = overflowAnchor?.getBoundingClientRect()
    if (anchor) {
      node.style.top = `${anchor.bottom + 4}px`
      node.style.right = `${Math.max(0, window.innerWidth - anchor.right)}px`
    }
    node.showPopover()
    node.querySelector('input')?.focus()
    return () => {
      if (node.matches(':popover-open')) node.hidePopover()
    }
  }

  function onWindowPointerDown(event: PointerEvent): void {
    if (!overflow) return
    if (
      event.target instanceof Node &&
      (overflowAnchor?.contains(event.target) || overflowSurface?.contains(event.target))
    ) {
      return
    }
    closeOverflow()
  }

  // ─── Hovering a tab shows the thread's own popover ────────────────────────
  const hover = createThreadHoverPopover({ isBlocked: () => Boolean(overflow) || threadMenuOpen })
  let hoverThread = $state<Thread | null>(null)

  function tabEnter(event: PointerEvent, thread: Thread): void {
    hover.setRow(event.currentTarget as HTMLElement)
    hoverThread = thread
    hover.enter()
  }

  function tabLeave(): void {
    hover.leave()
    hoverThread = null
  }

  function captureHoverSurface(element: HTMLElement): () => void {
    hover.setPopover(element)
    return () => hover.setPopover(undefined)
  }

  // ─── The thread a right-click is about ────────────────────────────────────
  /**
   * The tab a context menu was opened on, and where that tab sits inside the
   * strip: the menu anchors to the tab itself, so it opens where the user
   * right-clicked rather than under the name.
   */
  let contextThread = $state<Thread | null>(null)
  let contextAnchor = $state<{ left: number; top: number; width: number; height: number } | null>(
    null
  )
  let threadMenuOpen = $state(false)
  let stripElement = $state<HTMLElement | null>(null)

  const actionsMenu = createThreadActionsMenu({
    getThread: () => contextThread,
    onRename: (thread, newName) => assistantHeaderTabs.renameThread(thread, newName),
    onTogglePin: (thread) => assistantHeaderTabs.togglePinThread(thread),
    onFork: (thread) => assistantHeaderTabs.forkThread(thread),
    onDelete: async (thread) => {
      await assistantHeaderTabs.deleteThread(thread)
      contextThread = null
      contextAnchor = null
    },
    onDeleteError: (error) => reportError(error, 'Could not delete thread'),
    onOpenNotes: (thread) => {
      assistantHeaderTabs.openThread(thread)
      assistantHeaderTabs.openThreadNotes(thread)
    },
    showChangeScope: () => false,
    showNotes: () => true,
    showCopyId: () => true,
    isKnowledgeThread: () => (contextThread ? isAssistantSetupThread(contextThread) : false),
    onHideKnowledge: (thread) => assistantHeaderTabs.hideKnowledgeThread(thread)
  })

  async function openThreadMenu(thread: Thread, element: HTMLElement): Promise<void> {
    hover.hide()
    const strip = stripElement?.getBoundingClientRect()
    const tab = element.getBoundingClientRect()
    contextAnchor = strip
      ? {
          left: tab.left - strip.left,
          top: tab.top - strip.top,
          width: tab.width,
          height: tab.height
        }
      : null
    contextThread = thread
    // The menu's anchor is mounted by this state, so it can only be opened once
    // that anchor exists.
    await tick()
    threadMenuOpen = true
  }

  function closeThreadMenu(): void {
    contextThread = null
    contextAnchor = null
  }

  // ─── Arranging the tabs ───────────────────────────────────────────────────
  /**
   * A tab is the strip's drag handle and its drop target. A drag only ever lands
   * inside the group it started in: pinning is the way a thread crosses the rule
   * between the two, so a drop can never silently pin or unpin anything.
   */
  let dragId = $state<string | null>(null)
  let dragGroup = $state<AssistantTabGroup | null>(null)
  let dropTarget = $state<{ id: string; edge: 'before' | 'after' } | null>(null)

  function setDragGhost(event: DragEvent, label: string): void {
    const ghost = document.createElement('div')
    ghost.textContent = label
    ghost.style.cssText =
      'position:absolute;top:-1000px;left:-1000px;padding:3px 8px;background:var(--color-surface);border:1px solid var(--color-border);font-size:13px;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,0.15)'
    document.body.appendChild(ghost)
    event.dataTransfer?.setDragImage(ghost, 0, 0)
    requestAnimationFrame(() => document.body.removeChild(ghost))
  }

  function startDrag(event: DragEvent, thread: Thread, group: AssistantTabGroup): void {
    hover.hide()
    dragId = thread.id
    dragGroup = group
    dropTarget = null
    if (!event.dataTransfer) return
    event.dataTransfer.effectAllowed = 'move'
    // A private type keeps a tab reorder out of every text and file drop handler
    // that watches the document; the id itself is read from component state.
    event.dataTransfer.setData('application/x-cio-assistant-tab', thread.id)
    setDragGhost(event, thread.title)
  }

  function overTab(event: DragEvent, thread: Thread, group: AssistantTabGroup): void {
    if (!dragId || dragId === thread.id || group !== dragGroup) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect()
    dropTarget = {
      id: thread.id,
      edge: event.clientX < box.left + box.width / 2 ? 'before' : 'after'
    }
  }

  function endDrag(): void {
    dragId = null
    dragGroup = null
    dropTarget = null
  }

  /**
   * Land the dragged tab beside the one it was dropped on, then remember the
   * whole group's arrangement, hidden tabs included, so nothing behind the count
   * changes place behind the user's back.
   */
  function dropTab(event: DragEvent, thread: Thread, group: AssistantTabGroup): void {
    const draggedId = dragId
    // A file or text drag the tab never accepted must keep falling through to the
    // handlers that do accept it.
    if (!draggedId) return
    event.preventDefault()
    const from = dragGroup
    const edge = dropTarget?.id === thread.id ? dropTarget.edge : 'after'
    endDrag()
    if (draggedId === thread.id || from !== group) return

    const shown = group === 'pinned' ? visiblePinned : visibleOpen
    const ids = shown.map((entry) => entry.id)
    const start = ids.indexOf(draggedId)
    const landing = ids.indexOf(thread.id)
    if (start === -1 || landing === -1 || start === landing) return
    ids.splice(start, 1)
    const target = ids.indexOf(thread.id)
    ids.splice(edge === 'before' ? target : target + 1, 0, draggedId)

    const hidden = group === 'pinned' ? hiddenPinned : hiddenOpen
    assistantTabOrder.place(orderKey, group, [...ids, ...hidden.map((entry) => entry.id)])
  }

  /**
   * Bring the open thread's tab into the strip's own viewport.
   *
   * The strip scrolls sideways and the open group sits at its right edge, so a
   * tab picked from the count can land outside the visible slice. The reveal
   * follows the tab, never the pointer, and only moves the strip when that tab
   * is not already fully in view.
   */
  function revealWhenActive(isActive: boolean): Attachment<HTMLElement> {
    return (node) => {
      if (!isActive) return
      const strip = node.closest<HTMLElement>('[data-tab-scroll]')
      if (!strip) return
      const box = node.getBoundingClientRect()
      const frame = strip.getBoundingClientRect()
      if (box.right > frame.right) strip.scrollLeft += box.right - frame.right
      else if (box.left < frame.left) strip.scrollLeft -= frame.left - box.left
    }
  }

  $effect(() => relativeTimeClock.hold())
</script>

<svelte:window onpointerdown={onWindowPointerDown} />

<div
  bind:this={stripElement}
  class="titlebar-no-drag relative flex min-w-0 flex-1 items-center self-stretch"
>
  <!-- The assistant's name never scrolls away with its tabs: it is the fixed
       label the row of tabs belongs to, sitting flush against the panel edge it
       hugs once the sidebar is open. -->
  <span
    class="group/label mr-1 flex min-w-0 shrink-0 items-center gap-1.5 px-1 text-[0.6875rem] font-semibold text-foreground"
    title={groupAssistant ? `${groupLabel}'s threads` : groupLabel}
  >
    {#if groupAssistant}
      <AssistantOptionsMenu assistant={groupAssistant} bind:open={assistantMenuOpen}>
        <!-- The mark becomes the menu ellipsis under the pointer, the same swap a
             row's icon uses to say a click opens something. -->
        <span class="relative flex size-4 items-center justify-center">
          <span
            class="flex items-center justify-center transition-opacity duration-150 group-hover/label:opacity-0"
          >
            {#if groupIcon}
              <img src={groupIcon} alt="" class="size-4 object-contain" />
            {:else}
              <AssistantDefaultIcon size={14} style="color: {groupColor}" />
            {/if}
          </span>
          <span
            class="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-150 group-hover/label:opacity-100"
          >
            <CioEllipsis size={11} class="text-muted" />
          </span>
          <!-- Its state belongs on the mark itself: under the pointer the mark
               turns into the menu ellipsis, so the badge sits at its foot and
               stays visible either way. -->
          {#if assistantState}
            <span
              class="pointer-events-none absolute -right-1.5 -bottom-1.5 flex items-center justify-center"
            >
              <StatusBadge
                tone={assistantState.tone}
                variant={assistantState.working ? 'spinner' : 'dot'}
                size="sm"
                title={assistantState.label}
                class="rounded-full"
              />
            </span>
          {/if}
        </span>
      </AssistantOptionsMenu>
    {:else}
      <span class="flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
        <AssistantDefaultIcon size={14} style="color: {groupColor}" />
      </span>
    {/if}
    <span class="max-w-40 truncate">{groupLabel}</span>
    {#if groupAssistant}
      <!-- New work belongs to the assistant named right beside it, so it lives
           here instead of with the view's other actions. For Don the thing to
           create is another conversation, not a task: a task is a scheduled job
           of an assistant, and Don's job is the conversation itself. -->
      <button
        type="button"
        class="flex size-5 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
        aria-label={isDon ? `New conversation with ${groupLabel}` : `New task in ${groupLabel}`}
        title={isDon ? 'New conversation' : 'New task'}
        onclick={() => {
          if (!groupAssistant) return
          if (isDon) assistantHeaderTabs.createDonConversation(groupAssistant)
          else assistantHeaderTabs.createTask(groupAssistant)
        }}
      >
        <CioPlus size={12} />
      </button>
    {/if}
  </span>

  <div
    data-tab-scroll
    class="min-w-0 flex-1 overflow-x-auto overscroll-x-contain"
    aria-label="{groupLabel} threads"
  >
    <!-- Pinned threads hold the left edge, right beside the assistant they
           belong to, and the open group keeps the right: the spacer between them
           is what keeps the two apart when both are narrow. -->
    <div class="flex h-full w-full max-w-full items-center gap-0.5">
      <div class="flex shrink-0 items-center gap-0.5">
        {#each visiblePinned as thread (thread.id)}
          {@render threadTab(thread, true)}
        {/each}

        {#if hiddenPinned.length > 0}
          <button
            type="button"
            class="flex min-h-8 shrink-0 items-center px-2 text-[0.6875rem] font-medium tabular-nums transition-colors {overflow ===
            'pinned'
              ? 'bg-selected text-foreground'
              : 'text-muted hover:bg-elevated hover:text-foreground'}"
            aria-haspopup="menu"
            aria-expanded={overflow === 'pinned'}
            aria-label="Show {hiddenPinned.length} more pinned threads"
            title="Show {hiddenPinned.length} more pinned threads"
            onclick={(event: MouseEvent) => toggleOverflow('pinned', event)}
          >
            +{hiddenPinned.length}
          </button>
        {/if}
      </div>

      {#if pinnedGroup.length > 0 && openGroup.length > 0}
        <!-- The two groups never mix: the rule is the boundary a tab crosses
               when it is pinned or unpinned. -->
        <div class="mx-1 h-5 w-px shrink-0 bg-border" aria-hidden="true"></div>
      {/if}

      <div class="flex-1"></div>

      <div class="flex shrink-0 items-center gap-0.5">
        {#each visibleOpen as thread (thread.id)}
          {@render threadTab(thread, false)}
        {/each}

        {#if hiddenOpen.length > 0}
          <button
            type="button"
            class="flex min-h-8 shrink-0 items-center px-2 text-[0.6875rem] font-medium tabular-nums transition-colors {overflow ===
            'open'
              ? 'bg-selected text-foreground'
              : 'text-muted hover:bg-elevated hover:text-foreground'}"
            aria-haspopup="menu"
            aria-expanded={overflow === 'open'}
            aria-label="Show {hiddenOpen.length} more threads"
            title="Show {hiddenOpen.length} more threads"
            onclick={(event: MouseEvent) => toggleOverflow('open', event)}
          >
            +{hiddenOpen.length}
          </button>
        {/if}
      </div>
    </div>
  </div>

  {#if overflow}
    <div
      popover="manual"
      class="fixed bottom-auto left-auto m-0 overflow-visible border-0 bg-transparent p-0"
      {@attach captureOverflowSurface}
      {@attach topLayer}
    >
      <PickerMenuShell
        bind:query={overflowQuery}
        label={overflow === 'pinned' ? 'More pinned threads' : 'More threads'}
        placeholder="Filter threads"
        autofocusSearch
        onSearchInput={() => {}}
        onSearchKeydown={onOverflowKeydown}
      >
        {#each filteredOverflow as thread (thread.id)}
          <button
            type="button"
            role="menuitem"
            class="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs text-foreground hover:bg-elevated"
            title={thread.title}
            onclick={() => pickOverflow(thread)}
          >
            <span class="min-w-0 flex-1 truncate">{thread.title}</span>
            <span class="shrink-0 text-[0.625rem] tabular-nums text-dimmed"
              >{formatCompactAge(thread.lastActivity, relativeTimeClock.now)}</span
            >
          </button>
        {:else}
          <p class="px-2 py-1.5 text-xs text-dimmed">No thread matches</p>
        {/each}
      </PickerMenuShell>
    </div>
  {/if}

  <!-- The right-clicked tab's own actions, anchored exactly where that tab is. -->
  {#if contextThread && contextAnchor}
    <div
      class="pointer-events-none absolute"
      style:left="{contextAnchor.left}px"
      style:top="{contextAnchor.top}px"
      style:width="{contextAnchor.width}px"
      style:height="{contextAnchor.height}px"
    >
      <ThreadDropdown
        anchorOnly
        bind:open={threadMenuOpen}
        items={actionsMenu.items}
        onClose={closeThreadMenu}
      />
    </div>
  {/if}
</div>

{#if hover.visible && hoverThread}
  <Portal>
    <div
      {@attach captureHoverSurface}
      class={THREAD_HOVER_POPOVER_SURFACE_CLASS}
      style={threadHoverPopoverStyle(hover.position.x, hover.position.y)}
    >
      <ThreadHoverPopover
        thread={hoverThread}
        isWorking={isThreadLiveWorking(hoverThread)}
        hideProject
      />
    </div>
  </Portal>
{/if}

{#snippet threadTab(thread: Thread, pinned: boolean)}
  {@const active = thread.id === activeId}
  {@const group: AssistantTabGroup = pinned ? 'pinned' : 'open'}
  {@const status = statusBadgeForThread(thread, isThreadLiveWorking(thread))}
  {@const edge = dropTarget?.id === thread.id ? dropTarget.edge : null}
  {@const dragging = dragId === thread.id}
  <div
    role="group"
    aria-label={thread.title}
    draggable="true"
    ondragstart={(event: DragEvent) => startDrag(event, thread, group)}
    ondragover={(event: DragEvent) => overTab(event, thread, group)}
    ondragleave={() => {
      if (dropTarget?.id === thread.id) dropTarget = null
    }}
    ondrop={(event: DragEvent) => dropTab(event, thread, group)}
    ondragend={endDrag}
    {@attach revealWhenActive(active)}
    class="relative flex min-h-8 min-w-[3rem] items-center gap-1 overflow-hidden pl-1 pr-0.5 text-[0.6875rem] transition-colors {pinned
      ? 'max-w-28'
      : 'max-w-44'} {active
      ? 'bg-selected text-foreground'
      : 'text-muted hover:bg-elevated hover:text-foreground'} {dragging ? 'opacity-50' : ''}"
    onpointerenter={(event: PointerEvent) => tabEnter(event, thread)}
    onpointerleave={tabLeave}
    oncontextmenu={(event: MouseEvent) => {
      event.preventDefault()
      void openThreadMenu(thread, event.currentTarget as HTMLElement)
    }}
  >
    {#if edge === 'before'}
      <!-- Where the dragged tab would land: the tab's own leading edge. -->
      <span
        class="pointer-events-none absolute inset-y-0 left-0 w-0.5 bg-primary"
        aria-hidden="true"
      ></span>
    {/if}
    {#if pinned}
      <!-- A pinned tab says so at its left edge, and the pin is the way back:
           clicking it unpins the thread and the tab leaves this group. -->
      <button
        type="button"
        class="flex size-4 shrink-0 items-center justify-center text-accent transition-colors hover:text-foreground"
        aria-label="Unpin thread {thread.title}"
        title="Unpin thread"
        onclick={() => assistantHeaderTabs.togglePinThread(thread)}
      >
        <CioPin size={10} />
      </button>
    {/if}
    <!-- The state slot: a thin square that fills with the state's colour while
         work is live or waiting on the user, and keeps only its outline once the
         thread is done. -->
    <StatusBadge
      stage={status.stage}
      tone={status.tone}
      kind={status.kind}
      variant="square"
      hollow={status.stage === 'done'}
      title={status.label}
      class="shrink-0"
    />
    <button
      type="button"
      class="min-w-0 flex-1 truncate text-left"
      title={thread.title}
      aria-current={active ? 'page' : undefined}
      onclick={() => assistantHeaderTabs.openThread(thread)}
    >
      {thread.title}
    </button>
    <button
      type="button"
      class="flex size-5 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-overlay hover:text-foreground"
      aria-label="Delete thread {thread.title}"
      title="Delete thread"
      onclick={() => {
        hover.hide()
        contextThread = thread
        actionsMenu.startDelete()
      }}
    >
      <CioClose size={10} />
    </button>
    {#if edge === 'after'}
      <span
        class="pointer-events-none absolute inset-y-0 right-0 w-0.5 bg-primary"
        aria-hidden="true"
      ></span>
    {/if}
    {#if active}
      <span
        class="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-foreground"
        aria-hidden="true"
      ></span>
    {/if}
  </div>
{/snippet}

<!-- Rename Thread -->
<Modal open={actionsMenu.showRenameModal} title="Rename Thread" onClose={actionsMenu.cancelRename}>
  <form
    id="assistant-tab-rename-form"
    class="space-y-4"
    onsubmit={(event: SubmitEvent) => {
      event.preventDefault()
      void actionsMenu.confirmRename()
    }}
  >
    <div>
      <label class="mb-1 block text-xs font-medium text-muted" for="assistant-tab-rename-input"
        >Title</label
      >
      <input
        id="assistant-tab-rename-input"
        type="text"
        class="w-full border bg-elevated px-3 py-2 text-sm text-foreground placeholder:text-dimmed"
        bind:value={actionsMenu.renameValue}
      />
    </div>
  </form>

  {#snippet footer()}
    <button
      type="button"
      class="px-3 py-2 text-sm text-muted transition-colors hover:bg-elevated"
      title="Cancel"
      onclick={actionsMenu.cancelRename}
    >
      Cancel
    </button>
    <button
      type="submit"
      form="assistant-tab-rename-form"
      class="bg-primary px-4 py-2 text-sm font-medium text-on-primary transition-colors hover:bg-primary-hover"
      disabled={!actionsMenu.renameValue.trim()}
      title="Save the new title"
    >
      Save
    </button>
  {/snippet}
</Modal>

{#if contextThread}
  <ThreadDeleteConfirm
    open={actionsMenu.showDeleteModal}
    threadTitle={contextThread.title}
    onClose={actionsMenu.cancelDelete}
    onConfirm={actionsMenu.confirmDelete}
  />
{/if}
