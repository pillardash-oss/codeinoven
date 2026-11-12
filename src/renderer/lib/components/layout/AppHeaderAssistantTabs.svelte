<script lang="ts">
  import CioClose from '@pdslng/cio-icon/CioClose.svelte'
  import { SvelteSet } from 'svelte/reactivity'
  import PickerMenuShell from '$lib/components/shared/PickerMenuShell.svelte'
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte'
  import AssistantOptionsMenu from '$lib/components/assistant/AssistantOptionsMenu.svelte'
  import {
    AssistantDefaultIcon,
    assistantAccentColor,
    getAssistantIcon
  } from '$lib/assistant-icons'
  import { assistants as assistantStore } from '$lib/stores/assistants.svelte'
  import { assistantHeaderTabs } from '$lib/stores/assistant-header-tabs.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import { relativeTimeClock } from '$lib/relative-time.svelte'
  import { formatCompactAge } from '$shared/date-time-format'
  import { DON_ASSISTANT_ID, isThreadWorking, type Thread } from '$shared/types'

  /**
   * The assistant view's header centre.
   *
   * It is the one page whose threads sit under the bar instead of in the sidebar:
   * the open assistant's name is fixed at the left, its most recently worked
   * threads follow as tabs, and the rest wait behind a count that opens a
   * searchable list. A tab is browser-shaped   the assistant's icon opens the
   * assistant's own menu, the title opens the thread, and the close button at the
   * right end deletes the thread behind a confirmation.
   */

  /** Tabs shown before the rest fold behind the count. Beyond this the titles
   *  shrink to a few words and stop identifying anything. */
  const MAX_TABS = 5
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
   * Don holds one thread for its whole life, so a strip of tabs, a count and a
   * per-thread close button would say nothing the name does not. The built-in
   * orchestrator is named in the bar and opened from the sidebar.
   */
  let isDon = $derived(groupAssistant?.id === DON_ASSISTANT_ID)

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

  // ─── Close a tab = delete its thread ──────────────────────────────────────
  let deleteTarget = $state<Thread | null>(null)
  let deleteBusy = $state(false)

  async function confirmDelete(): Promise<void> {
    const target = deleteTarget
    if (!target || deleteBusy) return
    deleteBusy = true
    try {
      await assistantHeaderTabs.deleteThread(target)
      deleteTarget = null
    } finally {
      deleteBusy = false
    }
  }

  $effect(() => relativeTimeClock.hold())
</script>

<svelte:window onpointerdown={onWindowPointerDown} />

<div class="titlebar-no-drag flex min-w-0 flex-1 items-center self-stretch pl-3">
  <div class="mr-2 h-5 w-px shrink-0 bg-border/50" aria-hidden="true"></div>

  <!-- The assistant's name never scrolls away with its tabs: it is the fixed
       label the row of tabs belongs to. -->
  <span
    class="mr-1.5 flex min-w-0 shrink-0 items-center gap-1.5 px-1 text-[0.6875rem] font-semibold text-foreground"
    title={groupAssistant ? `${groupLabel}'s threads` : groupLabel}
  >
    <!-- The assistant's own mark, in its own colour: the bar names the place by
         the same identity its sidebar row wears, not by a repeated glyph. -->
    <span class="flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
      {#if groupIcon}
        <img src={groupIcon} alt="" class="size-4 object-contain" />
      {:else}
        <AssistantDefaultIcon size={14} style="color: {groupColor}" />
      {/if}
    </span>
    <span class="max-w-40 truncate">{groupLabel}</span>
  </span>

  {#if !isDon}
    <div
      class="min-w-0 flex-1 overflow-x-auto overscroll-x-contain"
      aria-label="{groupLabel} threads"
    >
      <div class="flex h-full w-max max-w-full items-center gap-0.5">
        {#each visibleThreads as thread (thread.id)}
          {@const active = thread.id === activeId}
          {@const working = isThreadWorking(thread)}
          <!-- min-w is the icon-only floor: 1rem icon + the title's first letters +
             1.5rem close. `overflow-hidden` keeps the active underline inside. -->
          <div
            class="relative flex min-h-8 min-w-[5rem] items-center gap-1 overflow-hidden pl-1 pr-0.5 text-[0.6875rem] transition-colors {active
              ? 'bg-selected text-foreground'
              : 'text-muted hover:bg-elevated hover:text-foreground'}"
          >
            {#if groupAssistant}
              <AssistantOptionsMenu
                assistant={groupAssistant}
                iconUrl={assistantStore.iconUrls.get(groupAssistant.id) ?? null}
              />
            {:else}
              <span class="flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
                <AssistantDefaultIcon size={13} style="color: var(--color-muted)" />
              </span>
            {/if}
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
              onclick={() => (deleteTarget = thread)}
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
  {/if}

  {#if !isDon && hiddenThreads.length > 0}
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
</div>

<ConfirmDialog
  open={deleteTarget !== null}
  title="Delete thread"
  confirmLabel="Delete thread"
  busy={deleteBusy}
  note="This cannot be undone."
  onCancel={() => (deleteTarget = null)}
  onConfirm={confirmDelete}
>
  <p>
    Delete <strong class="text-foreground">{deleteTarget?.title ?? ''}</strong>? Its conversation
    and everything it produced are deleted with it.
  </p>
</ConfirmDialog>
