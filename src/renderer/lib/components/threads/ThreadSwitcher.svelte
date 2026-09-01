<script lang="ts">
  import { Dialog } from 'bits-ui'
  import { onMount, tick } from 'svelte'
  import { SvelteMap } from 'svelte/reactivity'
  import { getProjectIcon } from '$lib/project-icons'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import ThreadRow from './ThreadRow.svelte'
  import { threadMessages } from '$lib/stores/thread-messages.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import type { NativeSwitcherPayload } from '$shared/ipc-contract'
  import type { Project, Thread } from '$shared/types'

  interface Props {
    threads: readonly Thread[]
    projects: readonly Project[]
    projectIconUrls: ReadonlyMap<string, string>
    selectedThreadId: string | null
    /** When true, Ctrl+Tab opens the native overlay instead of the DOM dialog —
     *  required whenever the browser's native WebContentsView is on screen,
     *  because a native view stacks above all renderer DOM. */
    nativeAvailable?: boolean
    onSelect: (thread: Thread) => void | Promise<void>
    onPreview?: (thread: Thread) => void
    onPreviewEnd?: (thread: Thread) => void
  }

  let {
    threads,
    projects,
    projectIconUrls,
    selectedThreadId,
    nativeAvailable = false,
    onSelect,
    onPreview = () => {},
    onPreviewEnd = () => {}
  }: Props = $props()

  let open = $state(false)
  /** True while the native overlay session is active. The overlay owns its own
   *  keyboard handling, so the DOM dialog and the renderer's window handlers
   *  must step aside while it is focused. */
  let nativeSessionActive = $state(false)
  let nativePreviewThreadId: string | null = null
  let domPreviewThreadId: string | null = null
  let highlightedIndex = $state(0)
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

  function projectIcon(thread: Thread): string | null {
    const project = projectsById.get(thread.projectId)
    if (!project) return null
    return getProjectIcon(project, projectIconUrls.get(project.id))
  }

  function focusHighlightedThread(): void {
    void tick().then(() => {
      contentElement
        ?.querySelector<HTMLElement>(`[data-thread-index="${highlightedIndex}"]`)
        ?.focus()
    })
  }

  /** Preview changes are driven by keyboard and pointer events. Running the
   *  parent cache mutation inside an effect would make that effect subscribe
   *  to the cache it updates and create a reactive update cycle. */
  function previewDomThread(thread: Thread): void {
    if (domPreviewThreadId === thread.id) return
    const previous = threads.find((candidate) => candidate.id === domPreviewThreadId)
    if (previous) onPreviewEnd(previous)
    domPreviewThreadId = thread.id
    onPreview(thread)
    if (!threadMessages.loaded(thread.projectId, thread.id)) {
      void threadMessages.preload(thread.projectId, thread.id)
    }
  }

  function cancelDomPreview(): void {
    const previewed = threads.find((thread) => thread.id === domPreviewThreadId)
    if (previewed) onPreviewEnd(previewed)
    domPreviewThreadId = null
  }

  function cycle(direction: 1 | -1): void {
    if (threads.length === 0) return

    if (!open) {
      previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
      restoreFocusOnClose = true
      pointerAtOpen = lastPointer
      const selectedIndex = threads.findIndex((thread) => thread.id === selectedThreadId)
      const startingIndex = selectedIndex >= 0 ? selectedIndex : direction === 1 ? -1 : 0
      highlightedIndex = (startingIndex + direction + threads.length) % threads.length
      open = true
    } else {
      highlightedIndex = (highlightedIndex + direction + threads.length) % threads.length
    }

    const highlighted = threads[highlightedIndex]
    if (highlighted) previewDomThread(highlighted)
    focusHighlightedThread()
  }

  function cancel(): void {
    if (!open) return
    restoreFocusOnClose = true
    cancelDomPreview()
    open = false
  }

  async function selectThread(thread: Thread): Promise<void> {
    restoreFocusOnClose = false
    domPreviewThreadId = null
    open = false
    await onSelect(thread)
    // Focus the new thread's composer editor in place after the dialog is fully
    // closed — the mount-time autofocus alone loses the race with the closing
    // focus scope. Focuses directly; it never remounts the composer.
    workspaceState.requestFocusComposerEditor()
  }

  function nativePayload(direction: 1 | -1): NativeSwitcherPayload {
    const selectedIndex = threads.findIndex((thread) => thread.id === selectedThreadId)
    const startingIndex = selectedIndex >= 0 ? selectedIndex : direction === 1 ? -1 : 0
    const initialIndex = (startingIndex + direction + threads.length) % threads.length
    return {
      threads: threads.map((thread) => ({
        id: thread.id,
        title: thread.title,
        projectId: thread.projectId,
        icon: projectIcon(thread),
        selected: thread.id === selectedThreadId
      })),
      // Matches the DOM dialog's first-press jump: the very first Ctrl+Tab (or
      // Shift+Ctrl+Tab) already moves the highlight to the next (previous)
      // thread, so releasing early still lands on a neighbour.
      highlightedThreadId: threads[initialIndex]?.id ?? null,
      theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
      windowHeight: window.innerHeight
    }
  }

  function openNative(direction: 1 | -1): void {
    if (threads.length === 0 || nativeSessionActive) return
    nativeSessionActive = true
    const payload = nativePayload(direction)
    void invoke('switcher:open', payload).catch(() => {
      nativeSessionActive = false
    })
    const highlightedThreadId = payload.highlightedThreadId
    if (highlightedThreadId) {
      const thread = threads.find((candidate) => candidate.id === highlightedThreadId)
      if (thread) {
        nativePreviewThreadId = thread.id
        onPreview(thread)
      }
      if (thread && !threadMessages.loaded(thread.projectId, thread.id)) {
        void threadMessages.preload(thread.projectId, thread.id)
      }
    }
  }

  function closeNative(): void {
    if (!nativeSessionActive) return
    nativeSessionActive = false
    const highlighted = threads.find((thread) => thread.id === nativePreviewThreadId)
    if (highlighted) onPreviewEnd(highlighted)
    nativePreviewThreadId = null
    void invoke('switcher:close').catch(() => {})
  }

  async function handleNativeSelect(threadId: string): Promise<void> {
    if (!nativeSessionActive) return
    nativeSessionActive = false
    nativePreviewThreadId = null
    void invoke('switcher:close').catch(() => {})
    const thread = threads.find((candidate) => candidate.id === threadId)
    if (!thread) return
    await onSelect(thread)
    workspaceState.requestFocusComposerEditor()
  }

  function handleNativeHighlight(threadId: string): void {
    const thread = threads.find((candidate) => candidate.id === threadId)
    if (!thread) return
    nativePreviewThreadId = thread.id
    onPreview(thread)
    if (!threadMessages.loaded(thread.projectId, thread.id)) {
      void threadMessages.preload(thread.projectId, thread.id)
    }
  }

  // While a native session is active the overlay owns the keyboard, so the
  // DOM state machine must stay dormant. If the browser view disappears (the
  // reason the native overlay exists) the overlay closes and the next Ctrl+Tab
  // falls back to the DOM dialog.
  $effect(() => {
    if (nativeSessionActive && (!nativeAvailable || threads.length === 0)) closeNative()
  })

  onMount(() => {
    const unsubscribeSelect = subscribe('switcher:select', (threadId) => {
      void handleNativeSelect(threadId)
    })
    const unsubscribeHighlight = subscribe('switcher:highlight', (threadId) => {
      handleNativeHighlight(threadId)
    })
    const unsubscribeClosed = subscribe('switcher:closed', () => {
      nativeSessionActive = false
      const previewed = threads.find((thread) => thread.id === nativePreviewThreadId)
      if (previewed) onPreviewEnd(previewed)
      nativePreviewThreadId = null
    })
    return () => {
      unsubscribeSelect()
      unsubscribeHighlight()
      unsubscribeClosed()
    }
  })

  function handleWindowKeydown(event: KeyboardEvent): void {
    if (event.key === 'Tab' && event.ctrlKey) {
      if (threads.length === 0) return
      event.preventDefault()
      event.stopPropagation()
      if (nativeAvailable) {
        if (!nativeSessionActive) openNative(event.shiftKey ? -1 : 1)
        return
      }
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
    if (nativeSessionActive) return
    if (!open || event.key !== 'Control') return
    event.preventDefault()
    const thread = threads[highlightedIndex]
    if (thread) void selectThread(thread)
    else cancel()
  }

  function handleWindowBlur(): void {
    // The native overlay owns its own blur dismissal (it may blur the renderer
    // window when the overlay itself takes focus), so only the DOM dialog is
    // cancelled here.
    cancel()
  }
</script>

<svelte:window
  onkeydown={handleWindowKeydown}
  onkeyup={handleWindowKeyup}
  onpointermove={handleWindowPointerMove}
  onblur={handleWindowBlur}
/>

<Dialog.Root
  {open}
  onOpenChange={(nextOpen) => {
    if (!nextOpen) cancel()
  }}
>
  <Dialog.Portal>
    <Dialog.Overlay class="fixed inset-0 z-40 bg-app/50" />
    <Dialog.Content
      bind:ref={contentElement}
      class="fixed left-1/2 top-[18%] z-50 w-[min(32rem,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-2xl border border-border bg-surface shadow-xl"
      onOpenAutoFocus={(event) => {
        event.preventDefault()
        focusHighlightedThread()
      }}
      onCloseAutoFocus={(event) => {
        event.preventDefault()
        if (restoreFocusOnClose) previousFocus?.focus()
        previousFocus = null
        restoreFocusOnClose = false
      }}
    >
      <Dialog.Title class="sr-only">Switch thread</Dialog.Title>
      <Dialog.Description class="sr-only">
        Choose from the ten most recently active threads.
      </Dialog.Description>

      <header class="border-b border-border px-4 py-3">
        <p class="text-sm font-semibold text-foreground">Switch thread</p>
        <p class="mt-0.5 text-[11px] text-dimmed">Release Control to open the highlighted thread</p>
      </header>

      <div
        class="max-h-[min(28rem,65vh)] overflow-y-auto p-1.5"
        role="listbox"
        aria-label="Recent threads"
      >
        {#each threads as thread, index (thread.id)}
          {@const resolvedProjectIcon = projectIcon(thread)}
          <button
            type="button"
            role="option"
            aria-selected={index === highlightedIndex}
            data-thread-index={index}
            class="w-full overflow-hidden rounded-lg text-left outline-none transition-colors hover:bg-elevated focus-visible:ring-2 focus-visible:ring-primary"
            title="Open {thread.title}"
            onpointerenter={(event) => {
              if (!pointerMovedSinceOpen(event)) return
              highlightedIndex = index
              previewDomThread(thread)
            }}
            onclick={() => void selectThread(thread)}
          >
            <ThreadRow
              {thread}
              picker
              selected={index === highlightedIndex}
              projectIconUrl={resolvedProjectIcon}
            />
          </button>
        {/each}
      </div>

      <footer
        class="flex h-8 items-center justify-between border-t border-border bg-raised px-3 text-[10px] text-dimmed"
      >
        <span class="tabular-nums">{threads.length} recent threads</span>
        <span>Ctrl+Tab next · Shift+Ctrl+Tab previous</span>
      </footer>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
