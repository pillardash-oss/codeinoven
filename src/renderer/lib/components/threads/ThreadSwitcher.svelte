<script lang="ts">
  import { Dialog } from 'bits-ui'
  import { tick } from 'svelte'
  import { SvelteMap } from 'svelte/reactivity'
  import { getProjectIcon } from '$lib/project-icons'
  import ThreadRow from './ThreadRow.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import type { Project, Thread } from '$shared/types'

  interface Props {
    threads: readonly Thread[]
    projects: readonly Project[]
    projectIconUrls: ReadonlyMap<string, string>
    selectedThreadId: string | null
    onSelect: (thread: Thread) => void | Promise<void>
  }

  let { threads, projects, projectIconUrls, selectedThreadId, onSelect }: Props = $props()

  let open = $state(false)
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

    focusHighlightedThread()
  }

  function cancel(): void {
    if (!open) return
    restoreFocusOnClose = true
    open = false
  }

  async function selectThread(thread: Thread): Promise<void> {
    restoreFocusOnClose = false
    open = false
    await onSelect(thread)
    // Focus the new thread's composer editor in place after the dialog is fully
    // closed — the mount-time autofocus alone loses the race with the closing
    // focus scope. Focuses directly; it never remounts the composer.
    workspaceState.requestFocusComposerEditor()
  }

  function handleWindowKeydown(event: KeyboardEvent): void {
    if (event.key === 'Tab' && event.ctrlKey) {
      if (threads.length === 0) return
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
    const thread = threads[highlightedIndex]
    if (thread) void selectThread(thread)
    else cancel()
  }

  function handleWindowBlur(): void {
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
              if (pointerMovedSinceOpen(event)) highlightedIndex = index
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
