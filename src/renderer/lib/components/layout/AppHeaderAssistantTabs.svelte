<script lang="ts">
  import CioClose from '@pdslng/cio-icon/CioClose.svelte'
  import CioForward from '@pdslng/cio-icon/CioForward.svelte'
  import CioPlus from '@pdslng/cio-icon/CioPlus.svelte'
  import { SvelteSet } from 'svelte/reactivity'
  import { tick } from 'svelte'
  import PickerMenuShell from '$lib/components/shared/PickerMenuShell.svelte'
  import ThreadDropdown from '$lib/components/shared/ThreadDropdown.svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import ThreadDeleteConfirm from '$lib/components/ui/ThreadDeleteConfirm.svelte'
  import AssistantOptionsMenu from '$lib/components/assistant/AssistantOptionsMenu.svelte'
  import { createThreadActionsMenu } from '$lib/components/shared/thread-actions-menu.svelte'
  import {
    AssistantDefaultIcon,
    assistantAccentColor,
    getAssistantIcon
  } from '$lib/assistant-icons'
  import { assistantHeaderTabs } from '$lib/stores/assistant-header-tabs.svelte'
  import { assistants as assistantStore } from '$lib/stores/assistants.svelte'
  import { reportError } from '$lib/stores/app-errors.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import { relativeTimeClock } from '$lib/relative-time.svelte'
  import { formatCompactAge } from '$shared/date-time-format'
  import {
    DON_ASSISTANT_ID,
    isAssistantSetupThread,
    isThreadWorking,
    type Thread
  } from '$shared/types'

  /**
   * The assistant view's header centre.
   *
   * It is the one page whose threads sit under the bar instead of in the sidebar:
   * the open assistant's mark, colour and name are fixed at the left, the plus
   * beside the name adds a task to that assistant, and its most recently worked
   * threads follow as tabs. A tab is a plain title and a close button   the
   * assistant already names itself once, so repeating its mark on every tab would
   * say nothing. The rest of the threads wait behind a count with a filter.
   *
   * The assistant's mark becomes a chevron under the pointer, and either mouse
   * button on it opens the assistant's own menu. Right-clicking a tab opens that
   * thread's actions.
   */

  /** Tabs shown before the rest fold behind the count. */
  const MAX_TABS = 4
  /** Threads with no assistant still need a strip when one of them is open, so
   *  they gather under this name instead of vanishing with the sidebar rows. */
  const UNASSIGNED_LABEL = 'Tasks'

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
   * Don holds one thread for its whole life, so tabs, a count and a per-thread
   * close would say nothing its name does not.
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

  /** The latest threads keep a tab, and the open thread always does, taking the
   *  last slot when it is not among them. */
  let visibleThreads = $derived.by(() => {
    const latest = groupThreads.slice(0, MAX_TABS)
    const active = selectedThread
    if (active && !latest.some((thread) => thread.id === active.id)) {
      const open = groupThreads.find((thread) => thread.id === active.id)
      if (open) latest.splice(Math.max(0, MAX_TABS - 1), latest.length, open)
    }
    return latest
  })

  let hiddenThreads = $derived.by(() => {
    const shown = new SvelteSet(visibleThreads.map((thread) => thread.id))
    return groupThreads.filter((thread) => !shown.has(thread.id))
  })

  let activeId = $derived(selectedThread?.id ?? null)

  // ─── Overflow picker ──────────────────────────────────────────────────────
  let overflowOpen = $state(false)
  let overflowQuery = $state('')
  let overflowRoot: HTMLDivElement | undefined

  function captureOverflowRoot(node: HTMLDivElement): () => void {
    overflowRoot = node
    return () => {
      if (overflowRoot === node) overflowRoot = undefined
    }
  }

  let filteredHidden = $derived.by(() => {
    const query = overflowQuery.trim().toLowerCase()
    return query
      ? hiddenThreads.filter((thread) => thread.title.toLowerCase().includes(query))
      : hiddenThreads
  })

  function closeOverflow(): void {
    overflowOpen = false
    overflowQuery = ''
  }

  function pickOverflow(thread: Thread): void {
    closeOverflow()
    assistantHeaderTabs.openThread(thread)
  }

  function onOverflowKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeOverflow()
    } else if (event.key === 'Enter' && filteredHidden[0]) {
      event.preventDefault()
      pickOverflow(filteredHidden[0])
    }
  }

  /**
   * Lift the menu into the browser's top layer. The header is its own stacking
   * context, so a z-index alone loses to the panels below it; a manual popover
   * escapes every stacking context and is anchored under the trigger by its own
   * rect.
   */
  function topLayer(node: HTMLDivElement): () => void {
    const anchor = overflowRoot?.getBoundingClientRect()
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
    if (!overflowOpen || !overflowRoot) return
    if (event.target instanceof Node && overflowRoot.contains(event.target)) return
    closeOverflow()
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

  $effect(() => relativeTimeClock.hold())
</script>

<svelte:window onpointerdown={onWindowPointerDown} />

<div
  bind:this={stripElement}
  class="titlebar-no-drag relative flex min-w-0 flex-1 items-center self-stretch pl-3"
>
  <div class="mr-2 h-5 w-px shrink-0 bg-border/50" aria-hidden="true"></div>

  <!-- The assistant's name never scrolls away with its tabs: it is the fixed
       label the row of tabs belongs to. -->
  <span
    class="group/label mr-1 flex min-w-0 shrink-0 items-center gap-1.5 px-1 text-[0.6875rem] font-semibold text-foreground"
    title={groupAssistant ? `${groupLabel}'s threads` : groupLabel}
  >
    {#if groupAssistant}
      <AssistantOptionsMenu assistant={groupAssistant} bind:open={assistantMenuOpen}>
        <!-- The mark becomes the chevron that says the click opens a menu, the
               same swap every list row uses. -->
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
            <CioForward size={11} class="rotate-90 text-muted" />
          </span>
        </span>
      </AssistantOptionsMenu>
    {:else}
      <span class="flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
        <AssistantDefaultIcon size={14} style="color: {groupColor}" />
      </span>
    {/if}
    <span class="max-w-40 truncate">{groupLabel}</span>
    {#if groupAssistant}
      <!-- New task belongs to the assistant named right beside it, so it lives
           here instead of with the view's other actions. -->
      <button
        type="button"
        class="flex size-5 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
        aria-label="New task in {groupLabel}"
        title="New task"
        onclick={() => {
          if (groupAssistant) assistantHeaderTabs.createTask(groupAssistant)
        }}
      >
        <CioPlus size={12} />
      </button>
    {/if}
  </span>

  {#if !isDon}
    <div
      class="min-w-0 flex-1 overflow-x-auto overscroll-x-contain"
      aria-label="{groupLabel} threads"
    >
      <!-- Right-aligned: the strip grows towards the name, so the tabs sit at the
           bar's right end and the newest work is the nearest thing to reach. -->
      <div class="ml-auto flex h-full w-max max-w-full items-center gap-0.5">
        {#each visibleThreads as thread (thread.id)}
          {@const active = thread.id === activeId}
          {@const working = isThreadWorking(thread)}
          <div
            role="group"
            aria-label={thread.title}
            class="relative flex min-h-8 min-w-[4rem] max-w-44 items-center gap-1 overflow-hidden pl-2 pr-0.5 text-[0.6875rem] transition-colors {active
              ? 'bg-selected text-foreground'
              : 'text-muted hover:bg-elevated hover:text-foreground'}"
            oncontextmenu={(event: MouseEvent) => {
              event.preventDefault()
              void openThreadMenu(thread, event.currentTarget as HTMLElement)
            }}
          >
            <button
              type="button"
              class="min-w-0 flex-1 truncate text-left"
              title={thread.title}
              aria-current={active ? 'page' : undefined}
              onclick={() => assistantHeaderTabs.openThread(thread)}
            >
              {thread.title}
            </button>
            {#if working}
              <span
                class="block size-1 shrink-0 rounded-full bg-info"
                title="Working"
                aria-label="Working"
              ></span>
            {/if}
            <button
              type="button"
              class="flex size-5 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-overlay hover:text-foreground"
              aria-label="Delete thread {thread.title}"
              title="Delete thread"
              onclick={() => {
                contextThread = thread
                actionsMenu.startDelete()
              }}
            >
              <CioClose size={10} />
            </button>
            {#if active}
              <span
                class="pointer-events-none absolute inset-x-0 bottom-0 h-0.5 bg-foreground"
                aria-hidden="true"
              ></span>
            {/if}
          </div>
        {/each}
      </div>
    </div>

    {#if hiddenThreads.length > 0}
      <div class="relative ml-0.5 shrink-0" {@attach captureOverflowRoot}>
        <button
          type="button"
          class="flex min-h-8 items-center px-2 text-[0.6875rem] font-medium tabular-nums transition-colors {overflowOpen
            ? 'bg-selected text-foreground'
            : 'text-muted hover:bg-elevated hover:text-foreground'}"
          aria-haspopup="menu"
          aria-expanded={overflowOpen}
          aria-label="Show {hiddenThreads.length} more threads"
          title="Show {hiddenThreads.length} more threads"
          onclick={() => (overflowOpen ? closeOverflow() : (overflowOpen = true))}
        >
          +{hiddenThreads.length}
        </button>
        {#if overflowOpen}
          <div
            popover="manual"
            class="fixed bottom-auto left-auto m-0 overflow-visible border-0 bg-transparent p-0"
            {@attach topLayer}
          >
            <PickerMenuShell
              bind:query={overflowQuery}
              label="More threads"
              placeholder="Filter threads"
              autofocusSearch
              onSearchInput={() => {}}
              onSearchKeydown={onOverflowKeydown}
            >
              {#each filteredHidden as thread (thread.id)}
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
      </div>
    {/if}
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
