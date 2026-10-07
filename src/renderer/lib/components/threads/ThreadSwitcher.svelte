<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { on } from 'svelte/events'
  import { SvelteMap } from 'svelte/reactivity'
  import { getProjectIcon } from '$lib/project-icons'
  import { contentFamilyIcon } from '$lib/content-view-icons'
  import ThreadRow from './ThreadRow.svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import { threadMessages } from '$lib/stores/thread-messages.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import { keymapState } from '$lib/keymap/keymap-state.svelte'
  import { subscribe } from '$lib/ipc.svelte'
  import { ensureStoredBrowserTabs, isBrowserLoaded } from '$lib/stores/browser-access.svelte'
  import { browserTabLabel } from '$lib/stores/global-browser-types'
  import type { Project } from '$shared/types'
  import { threadSwitcherEntryKey, type ThreadSwitcherEntry } from './thread-switcher-entries'

  interface Props {
    entries: readonly ThreadSwitcherEntry[]
    projects: readonly Project[]
    projectIconUrls: ReadonlyMap<string, string>
    /** The visit key of the entry the user is currently on, so the switcher can
     *  start cycling from it. */
    selectedKey: string | null
    onSelect: (entry: ThreadSwitcherEntry) => void | Promise<void>
  }

  let { entries, projects, projectIconUrls, selectedKey, onSelect }: Props = $props()

  let open = $state(false)
  /**
   * The highlighted row, held by entry key rather than by index.
   *
   * The durable tab-list read can land while the switcher is open and insert
   * rows above the cursor, so an index would then point at a different row than
   * the one on screen and releasing Control would open something the user never
   * chose. The index the renderer needs is derived from this key.
   */
  let highlightedKey = $state<string | null>(null)
  let contentElement = $state<HTMLElement | null>(null)
  let previousFocus: HTMLElement | null = null
  let restoreFocusOnClose = false

  let lastPointer = { x: 0, y: 0 }
  let pointerAtOpen = { x: 0, y: 0 }

  function handleWindowPointerMove(event: PointerEvent): void {
    lastPointer = { x: event.clientX, y: event.clientY }
  }

  /** Hover only steals the highlight once the user has actually moved the
   *  pointer after opening the switcher with Ctrl+Tab. A resting cursor that
   *  happens to sit over the dialog must not capture the keyboard selection. */
  function pointerMovedSinceOpen(event: PointerEvent): boolean {
    const dx = event.clientX - pointerAtOpen.x
    const dy = event.clientY - pointerAtOpen.y
    return dx * dx + dy * dy > 16
  }

  let projectsById = $derived.by(() => {
    const result = new SvelteMap<string, Project>()
    for (const project of projects) result.set(project.id, project)
    return result
  })

  /** Where the highlighted row is in the list the switcher is showing now, or -1
   *  while the row it names is not in the list. */
  let highlightedIndex = $derived.by(() => {
    if (highlightedKey === null) return -1
    return entries.findIndex((entry) => threadSwitcherEntryKey(entry) === highlightedKey)
  })

  function projectIcon(entry: ThreadSwitcherEntry): string | null {
    if (entry.kind !== 'thread') return null
    const project = projectsById.get(entry.thread.projectId)
    if (!project) return null
    return getProjectIcon(project, projectIconUrls.get(project.id))
  }

  /** The hover tooltip for one entry, phrased for the kind of surface it is. */
  function entryTitle(entry: ThreadSwitcherEntry): string {
    return entry.kind === 'browser'
      ? `Switch to ${browserTabLabel(entry.tab)}`
      : `Open ${entry.thread.title}`
  }

  /**
   * Focus the highlighted row, looking its position up again once the DOM has
   * caught up.
   *
   * Resolving by key rather than by the position the row had when focus was
   * asked for is what stops a list that moved in the meantime (the stored tab
   * read landing, an entry leaving) from putting focus on a row that is no
   * longer the highlighted one.
   */
  function focusHighlightedEntry(key: string | null): void {
    if (key === null) return
    void tick().then(() => {
      if (!open || highlightedKey !== key) return
      const index = entries.findIndex((entry) => threadSwitcherEntryKey(entry) === key)
      if (index < 0) return
      contentElement?.querySelector<HTMLElement>(`[data-entry-index="${index}"]`)?.focus()
    })
  }

  /**
   * Keep the focused row on the highlighted one.
   *
   * The list can grow while the switcher is open: the stored tab read lands just
   * after the first open, and the rows it inserts shift the highlight. Reading
   * the resolved position here is what makes this effect re-run on that shift,
   * which is what keeps the ring on the row a Control release will open.
   */
  $effect(() => {
    if (!open || highlightedIndex < 0) return
    focusHighlightedEntry(highlightedKey)
  })

  /** The next row in the cycle, wrapping in both directions. */
  function nextIndex(from: number, direction: 1 | -1): number {
    return (from + direction + entries.length) % entries.length
  }

  function cycle(direction: 1 | -1): void {
    // The stored tab list is read before the empty check, because this read is
    // the only thing that can fill an empty list: a session with no live thread
    // and a browser runtime this launch never loaded has nothing to show yet,
    // and asking after the early return would leave Ctrl+Tab doing nothing.
    if (!isBrowserLoaded()) ensureStoredBrowserTabs()
    if (entries.length === 0) return

    if (!open) {
      previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
      restoreFocusOnClose = true
      pointerAtOpen = lastPointer
      const selectedIndex = entries.findIndex(
        (entry) => threadSwitcherEntryKey(entry) === selectedKey
      )
      const startingIndex = selectedIndex >= 0 ? selectedIndex : direction === 1 ? -1 : 0
      const first = entries[nextIndex(startingIndex, direction)]
      highlightedKey = first ? threadSwitcherEntryKey(first) : null
      open = true
    } else {
      // A row the list no longer holds (a tab closed mid-gesture) drops the
      // highlight off the list, so the cycle restarts from its head, or from its
      // tail when it is running backward.
      const from = highlightedIndex >= 0 ? highlightedIndex : direction === 1 ? -1 : 0
      const next = entries[nextIndex(from, direction)]
      highlightedKey = next ? threadSwitcherEntryKey(next) : null
    }
  }

  function cancel(): void {
    if (!open) return
    restoreFocusOnClose = true
    open = false
  }

  async function selectEntry(entry: ThreadSwitcherEntry): Promise<void> {
    restoreFocusOnClose = false
    open = false
    await onSelect(entry)
    if (entry.kind !== 'thread') return
    // Focus the new thread's composer editor in place after the dialog is fully
    // closed   the mount-time autofocus alone loses the race with the closing
    // focus scope. Focuses directly; it never remounts the composer.
    workspaceState.requestFocusComposerEditor()
  }

  /** The entry a key release would open: the highlighted one. */
  function commitHighlighted(): void {
    const entry = highlightedIndex >= 0 ? entries[highlightedIndex] : undefined
    if (entry) void selectEntry(entry)
    else cancel()
  }

  /** Warm the highlighted thread's message cache so releasing Ctrl (or
   *  clicking) opens it without the loading spinner. */
  $effect(() => {
    if (!open) return
    const entry = entries[highlightedIndex]
    if (!entry || entry.kind !== 'thread') return
    const { thread } = entry
    if (threadMessages.loaded(thread.projectId, thread.id)) return
    void threadMessages.preload(thread.projectId, thread.id)
  })

  /**
   * A key pressed while a native browser page holds the keyboard never reaches
   * `svelte:window`. Main claims the switcher chord there, hands this renderer
   * the keyboard and forwards the gesture, so the switcher opens from inside a
   * page exactly as it does from the app's own chrome. From here on the real
   * Control release reaches the DOM and commits the highlight like any other.
   */
  onMount(() => {
    const unsubscribe = subscribe('browser:switcherKey', ({ backward }) => {
      cycle(backward ? -1 : 1)
    })
    // Claim the chord before dialog focus scopes interpret Tab as focus traversal.
    const removeKeydown = on(window, 'keydown', handleWindowKeydown, { capture: true })
    return () => {
      unsubscribe()
      removeKeydown()
    }
  })

  function handleWindowKeydown(event: KeyboardEvent): void {
    if (keymapState.matches('thread-switcher', event)) {
      // No "nothing to show" guard before the cycle: an empty list is exactly the
      // state the cycle's own stored-list read is there to fill, so returning
      // here would leave Ctrl+Tab doing nothing in that session.
      event.preventDefault()
      event.stopPropagation()
      cycle(event.shiftKey ? -1 : 1)
      return
    }

    if (open && event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      cancel()
    }
  }

  function handleWindowKeyup(event: KeyboardEvent): void {
    if (!open || event.key !== 'Control') return
    event.preventDefault()
    commitHighlighted()
  }

  function handleWindowBlur(): void {
    cancel()
  }
</script>

<svelte:window
  onkeyup={handleWindowKeyup}
  onpointermove={handleWindowPointerMove}
  onblur={handleWindowBlur}
/>

<Modal
  {open}
  title="Switch to"
  onClose={cancel}
  placement="palette"
  abovePage
  panelWidth="max-w-lg"
  chrome={false}
  bind:panelEl={contentElement}
  claimInitialFocus={() => {
    focusHighlightedEntry(highlightedKey)
    return true
  }}
  onCloseAutoFocus={(event) => {
    event.preventDefault()
    if (restoreFocusOnClose) previousFocus?.focus()
    previousFocus = null
    restoreFocusOnClose = false
  }}
>
  <header class="border-b border-border px-4 py-3">
    <p class="text-sm font-semibold text-foreground">Switch to</p>
    <p class="mt-0.5 text-[0.6875rem] text-dimmed">
      Release Control to open the highlighted thread or browser tab
    </p>
  </header>

  <div
    class="max-h-[min(28rem,65vh)] overflow-y-auto p-1.5"
    role="listbox"
    aria-label="Recent threads and browser tabs"
  >
    {#each entries as entry, index (threadSwitcherEntryKey(entry))}
      {@const entryKey = threadSwitcherEntryKey(entry)}
      {@const resolvedProjectIcon = projectIcon(entry)}
      <button
        type="button"
        role="option"
        aria-selected={entryKey === highlightedKey}
        data-entry-index={index}
        class="w-full overflow-hidden rounded-lg text-left outline-none transition-colors hover:bg-elevated focus-visible:ring-2 focus-visible:ring-primary"
        title={entryTitle(entry)}
        onpointerenter={(event) => {
          if (pointerMovedSinceOpen(event)) highlightedKey = entryKey
        }}
        onclick={() => void selectEntry(entry)}
      >
        {#if entry.kind === 'browser'}
          <!-- A browser row is a dynamic import: the switcher is mounted long
               before any browser is, and this is the only place it knows about
               one, so importing the row statically would carry the browser's
               model into the first-paint chunk for a row that cannot appear. -->
          {#await import('./SwitcherBrowserRow.svelte') then { default: SwitcherBrowserRow }}
            <SwitcherBrowserRow tab={entry.tab} selected={entryKey === highlightedKey} />
          {/await}
        {:else}
          <ThreadRow
            thread={entry.thread}
            picker
            selected={entryKey === highlightedKey}
            projectIconUrl={resolvedProjectIcon}
            projectIconGlyph={contentFamilyIcon(entry.thread)}
          />
        {/if}
      </button>
    {/each}
  </div>

  <footer
    class="flex h-8 items-center justify-between border-t border-border bg-raised px-3 text-[0.625rem] text-dimmed"
  >
    <span class="tabular-nums">{entries.length} recent items</span>
    <span>Ctrl+Tab next · Shift+Ctrl+Tab previous</span>
  </footer>
</Modal>
