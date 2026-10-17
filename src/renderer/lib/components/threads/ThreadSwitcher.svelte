<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { on } from 'svelte/events'
  import { SvelteMap } from 'svelte/reactivity'
  import { getProjectIcon } from '$lib/project-icons'
  import { contentThreadFamily } from '$lib/content-view-threads'
  import { contentFamilyIcon } from '$lib/content-view-icons'
  import ThreadRow from './ThreadRow.svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import { threadMessages } from '$lib/stores/thread-messages.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import { keymapState } from '$lib/keymap/keymap-state.svelte'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { ensureStoredBrowserTabs, isBrowserLoaded } from '$lib/stores/browser-access.svelte'
  import { threadSwitcherRequest } from '$lib/stores/thread-switcher-request.svelte'
  import { browserTabLabel } from '$lib/stores/global-browser-types'
  import type { Project } from '$shared/types'
  import type { Component } from 'svelte'
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

  function entryType(entry: ThreadSwitcherEntry): string {
    if (entry.kind === 'browser') return 'browser'
    if (entry.kind === 'panel') return `panel:${entry.tab.kind}`
    return contentThreadFamily(entry.thread)
  }

  const showTypeBadges = $derived.by(() => {
    const firstEntry = entries[0]
    return (
      firstEntry !== undefined &&
      entries.some((entry) => entryType(entry) !== entryType(firstEntry))
    )
  })

  let open = $state(false)
  let nativeReady = $state(false)
  let nativeFailed = $state(false)
  let keyboardAt = 0
  /**
   * Bumped by every close path, and by a commit attempt before it arms its
   * fallback. A fallback can then tell whether its own selection is still the
   * one in flight rather than one that already resolved.
   */
  let commitToken = 0
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

  /** The owning project's icon for a panel entry, drawn beside the panel's own
   *  icon so a terminal or file tab is identified with the project it belongs
   *  to. */
  function panelProjectIcon(entry: ThreadSwitcherEntry): string | null {
    if (entry.kind !== 'panel') return null
    const project = projectsById.get(entry.tab.projectId)
    if (!project) return null
    return getProjectIcon(project, projectIconUrls.get(project.id))
  }

  /** The container glyph for a panel tab whose project is a hidden container
   *  (Chats, Assistant), which has no project icon of its own. */
  function panelProjectGlyph(entry: ThreadSwitcherEntry): Component | null {
    if (entry.kind !== 'panel') return null
    return contentFamilyIcon({ projectId: entry.tab.projectId })
  }

  /** The hover tooltip for one entry, phrased for the kind of surface it is. */
  function entryTitle(entry: ThreadSwitcherEntry): string {
    if (entry.kind === 'browser') return `Switch to ${browserTabLabel(entry.tab)}`
    if (entry.kind === 'panel') return `Switch to ${entry.tab.title}`
    return `Open ${entry.thread.title}`
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
  /**
   * Focus the highlighted row right now. Returns whether it landed.
   *
   * Rows can lag the highlight: the panel mounts a frame after opening and
   * browser rows arrive through a dynamic import, so a single attempt leaves
   * focus where it was (the browser's back button) until the next cycle.
   * Callers retry on animation frames instead.
   */
  function focusRowNow(key: string): boolean {
    const index = entries.findIndex((entry) => threadSwitcherEntryKey(entry) === key)
    if (index < 0) return false
    const row = contentElement?.querySelector<HTMLElement>(`[data-entry-index="${index}"]`)
    if (!row) return false
    if (nativeReady && !nativeFailed) {
      // The native window owns focus. Focusing its hidden source row would
      // activate the parent again and dismiss the native modal on hover.
      scrollRowIntoList(row)
    } else {
      row.focus({ preventScroll: true })
      scrollRowIntoList(row)
    }
    return true
  }

  /** Scroll only the list, never the panel or the source document behind the overlay. */
  function scrollRowIntoList(row: HTMLElement): void {
    const list = row.parentElement
    if (!list) return
    const bounds = list.getBoundingClientRect()
    const item = row.getBoundingClientRect()
    if (item.top < bounds.top) list.scrollTop += item.top - bounds.top
    else if (item.bottom > bounds.bottom) list.scrollTop += item.bottom - bounds.bottom
  }

  function focusHighlightedEntry(key: string | null, attempts = 8): void {
    if (key === null) return
    void tick().then(() => {
      if (!open || highlightedKey !== key) return
      if (focusRowNow(key)) return
      if (attempts <= 0) {
        // Rows still missing (a slow dynamic import): hold focus inside the
        // panel so it cannot fall back to the browser chrome behind it.
        contentElement?.focus()
        return
      }
      requestAnimationFrame(() => focusHighlightedEntry(key, attempts - 1))
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
    keyboardAt = performance.timeOrigin + performance.now()
    // The stored tab list is read before the empty check, because this read is
    // the only thing that can fill an empty list: a session with no live thread
    // and a browser runtime this launch never loaded has nothing to show yet,
    // and asking after the early return would leave Ctrl+Tab doing nothing.
    if (!isBrowserLoaded()) ensureStoredBrowserTabs()
    if (entries.length === 0) return

    if (!open) {
      nativeFailed = false
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
    commitToken += 1
    restoreFocusOnClose = true
    open = false
  }

  /**
   * Open the list for pointer picking (logo click). The highlight starts on
   * the current surface so mouse users see where they are, and an empty list
   * stays closed instead of flashing an empty dialog.
   */
  function openForPointer(): void {
    if (open) return
    keyboardAt = performance.timeOrigin + performance.now()
    // Same stored-tab read as the keyboard cycle: the only fill for a list
    // that is empty only because the browser runtime never loaded.
    if (!isBrowserLoaded()) ensureStoredBrowserTabs()
    if (entries.length === 0) return
    nativeFailed = false
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    restoreFocusOnClose = true
    pointerAtOpen = lastPointer
    const selectedIndex = entries.findIndex(
      (entry) => threadSwitcherEntryKey(entry) === selectedKey
    )
    const first = selectedIndex >= 0 ? entries[selectedIndex] : entries[0]
    highlightedKey = first ? threadSwitcherEntryKey(first) : null
    open = true
  }

  let seenPointerRequest = 0
  $effect(() => {
    const id = threadSwitcherRequest.requestId
    if (id === 0 || id === seenPointerRequest) return
    seenPointerRequest = id
    openForPointer()
  })

  async function selectEntry(entry: ThreadSwitcherEntry): Promise<void> {
    commitToken += 1
    restoreFocusOnClose = false
    open = false
    await onSelect(entry)
    if (entry.kind !== 'thread') return
    // Focus the new thread's composer editor in place after the dialog is fully
    // closed   the mount-time autofocus alone loses the race with the closing
    // focus scope. Focuses directly; it never remounts the composer.
    workspaceState.requestFocusComposerEditor()
  }

  /** Resolve the highlighted row. Every close path ends here. */
  function resolveHighlighted(): void {
    const entry = highlightedIndex >= 0 ? entries[highlightedIndex] : undefined
    if (entry) void selectEntry(entry)
    else cancel()
  }

  /** The entry a key release would open: the highlighted one. */
  async function commitHighlighted(): Promise<void> {
    // Mouse events and Control release arrive in different renderers. Let the
    // window drawing the rows settle its latest hover before selecting a row.
    if (nativeReady) {
      const accepted = await invoke('browser:commitDockOverlay', {
        id: 'thread-switcher',
        selectedKey: highlightedKey,
        keyboardAt
      }).catch(() => false)
      if (accepted) {
        // The overlay answers the commit through its own renderer. A lost answer
        // must not leave the switcher covering the window, so a fallback resolves
        // the highlighted row once the answer is overdue. Whichever lands first
        // closes the switcher and bumps the token, and the other becomes a no-op.
        const token = ++commitToken
        setTimeout(() => {
          if (token !== commitToken || !open) return
          commitToken += 1
          resolveHighlighted()
        }, 300)
        return
      }
      if (!open) return
    }
    resolveHighlighted()
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
    if (keymapState.matches('thread-switcher', event) || (open && event.key === 'Tab')) {
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
    void commitHighlighted()
  }

  function handleWindowBlur(): void {
    // Native presentation owns keyboard focus until it closes. Its own blur
    // report dismisses the switcher when the user leaves the application.
    if (nativeReady && !nativeFailed) return
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
  nativeOverlay="thread-switcher"
  bind:nativeReady
  bind:nativeFailed
  onNativeHover={(control) => {
    const entry = entries[Number(control.dataset.entryIndex)]
    if (entry) highlightedKey = threadSwitcherEntryKey(entry)
  }}
  onNativeCommit={(key) => {
    // The overlay's answer to a commit. Ignore one that arrives after the
    // fallback already closed the switcher, so the gesture never selects twice.
    commitToken += 1
    if (!open) return
    const entry = entries.find((candidate) => threadSwitcherEntryKey(candidate) === key)
    if (entry) void selectEntry(entry)
    else cancel()
  }}
  panelWidth="max-w-lg"
  chrome={false}
  bind:panelEl={contentElement}
  claimInitialFocus={(panel) => {
    // Rows may not exist yet on the opening frame, so park focus inside the
    // panel first and let the retry above land it on the row once rendered.
    if (highlightedKey !== null && focusRowNow(highlightedKey)) return true
    panel.focus()
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
      Release Control to open the highlighted thread, browser tab or panel tab
    </p>
  </header>

  <div
    class="max-h-[calc(80vh-7rem)] min-h-0 overflow-y-auto overscroll-contain p-1.5"
    role="listbox"
    aria-label="Recent threads, browser tabs and panel tabs"
  >
    {#each entries as entry, index (threadSwitcherEntryKey(entry))}
      {@const entryKey = threadSwitcherEntryKey(entry)}
      {@const resolvedProjectIcon = projectIcon(entry)}
      <button
        type="button"
        role="option"
        aria-selected={entryKey === highlightedKey}
        data-entry-index={index}
        data-native-dock-key={entryKey}
        class="w-full cursor-pointer overflow-hidden text-left transition-colors hover:bg-elevated focus-visible:outline-none!"
        title={entryTitle(entry)}
        onpointerenter={(event) => {
          // Native presentation owns pointer selection. Only a failed native
          // presentation uses the source document's pointer events.
          if (nativeFailed && pointerMovedSinceOpen(event)) highlightedKey = entryKey
        }}
        onclick={() => void selectEntry(entry)}
      >
        {#if entry.kind === 'browser'}
          <!-- A browser row is a dynamic import: the switcher is mounted long
               before any browser is, and this is the only place it knows about
               one, so importing the row statically would carry the browser's
               model into the first-paint chunk for a row that cannot appear. -->
          {#await import('./SwitcherBrowserRow.svelte') then { default: SwitcherBrowserRow }}
            <SwitcherBrowserRow
              tab={entry.tab}
              selected={entryKey === highlightedKey}
              showBadge={showTypeBadges}
            />
          {/await}
        {:else if entry.kind === 'panel'}
          <!-- A panel row is a dynamic import for the same reason the browser row
               is: the switcher mounts before any panel tab can, and the row only
               ever appears in a list that already holds one. -->
          {#await import('./SwitcherPanelRow.svelte') then { default: SwitcherPanelRow }}
            <SwitcherPanelRow
              tab={entry.tab}
              selected={entryKey === highlightedKey}
              showBadge={showTypeBadges}
              projectIconUrl={panelProjectIcon(entry)}
              projectGlyph={panelProjectGlyph(entry)}
            />
          {/await}
        {:else}
          <ThreadRow
            thread={entry.thread}
            picker
            compact
            pickerBadge={!showTypeBadges
              ? undefined
              : contentThreadFamily(entry.thread) === 'chats'
                ? 'Chat'
                : contentThreadFamily(entry.thread) === 'assistant'
                  ? 'Assistant'
                  : 'Project'}
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
