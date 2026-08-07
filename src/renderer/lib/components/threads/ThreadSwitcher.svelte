<script lang="ts">
  import { Dialog } from 'bits-ui'
  import { FolderKanban, MessageSquare } from '@lucide/svelte'
  import { tick } from 'svelte'
  import { SvelteMap } from 'svelte/reactivity'
  import { getProjectIcon, projectIconOnError } from '$lib/project-icons'
  import { pickColorForSeed } from '$lib/project-colors'
  import StatusBadge from '$lib/components/shared/StatusBadge.svelte'
  import { agentRuns } from '$lib/stores/agent-runs.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import { scopeState, type ThreadStage } from '$lib/stores/scope.svelte'
  import {
    DEFAULT_SCOPE_BUCKET_ID,
    INBOX_PROJECT_ID,
    type Project,
    type Thread
  } from '$shared/types'

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

  let projectsById = $derived.by(() => {
    const result = new SvelteMap<string, Project>()
    for (const project of projects) result.set(project.id, project)
    return result
  })

  function projectFor(thread: Thread): Project | null {
    return projectsById.get(thread.projectId) ?? null
  }

  function projectColor(thread: Thread): string | undefined {
    const project = projectsById.get(thread.projectId)
    if (!project) return undefined
    return project.color ?? pickColorForSeed(project.id)
  }

  function projectIcon(thread: Thread): string | null {
    const project = projectsById.get(thread.projectId)
    if (!project) return null
    return getProjectIcon(project, projectIconUrls.get(project.id))
  }

  function projectLabel(thread: Thread): string {
    if (thread.projectId === INBOX_PROJECT_ID) return 'Chats'
    return projectsById.get(thread.projectId)?.name ?? 'Unknown project'
  }

  function scopeLabel(thread: Thread): string {
    if (thread.projectId === INBOX_PROJECT_ID) return 'General'
    const bucketId = thread.scopeBucketId ?? DEFAULT_SCOPE_BUCKET_ID
    return scopeState.bucketFor(thread.projectId, bucketId)?.name ?? 'Default'
  }

  interface StatusPresentation {
    label: string
    stage?: ThreadStage
    kind?: 'completed' | 'attention' | 'error'
    variant?: 'dot' | 'spinner'
    animated?: boolean
  }

  function statusFor(thread: Thread): StatusPresentation {
    // Live activity only overrides statuses that are not waiting on the user.
    // A finished brainstorm/spec (awaiting_approval) must always read as
    // "Needs attention", never as a stale "Working" spinner.
    if (thread.status !== 'awaiting_approval' && agentRuns.isBusy(thread.projectId, thread.id)) {
      return { label: 'Working', stage: 'working', variant: 'spinner' }
    }
    switch (thread.status) {
      case 'created':
        return { label: 'Ready', stage: 'todo' }
      case 'planning':
        return { label: 'Planning', stage: 'working', variant: 'spinner' }
      case 'executing':
        return { label: 'Working', stage: 'working', variant: 'spinner' }
      case 'awaiting_approval':
        return { label: 'Needs attention', kind: 'attention', animated: true }
      case 'interrupted':
        return { label: 'Interrupted' }
      case 'completed':
        return { label: 'Completed', kind: 'completed' }
      case 'failed':
        return { label: 'Failed', kind: 'error' }
    }
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
          {@const rowProject = projectFor(thread)}
          {@const rowStatus = statusFor(thread)}
          <button
            type="button"
            role="option"
            aria-selected={index === highlightedIndex}
            data-thread-index={index}
            class={[
              'flex min-h-12 w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary',
              index === highlightedIndex
                ? 'bg-overlay text-foreground'
                : 'text-muted hover:bg-elevated hover:text-foreground'
            ]}
            title="Open {thread.title}"
            onpointerenter={() => {
              highlightedIndex = index
            }}
            onclick={() => void selectThread(thread)}
          >
            <span
              class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-border bg-raised text-dimmed"
              style:border-color={thread.projectId === INBOX_PROJECT_ID
                ? undefined
                : projectColor(thread)}
              aria-hidden="true"
            >
              {#if thread.projectId === INBOX_PROJECT_ID}
                <MessageSquare size={14} />
              {:else if resolvedProjectIcon}
                <img
                  src={resolvedProjectIcon}
                  alt=""
                  class="h-4 w-4 shrink-0 rounded object-contain"
                  onerror={rowProject ? projectIconOnError(rowProject) : undefined}
                />
              {:else}
                <FolderKanban size={14} />
              {/if}
            </span>
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm font-medium">{thread.title}</span>
              <span class="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-dimmed">
                <span class="max-w-36 truncate">{projectLabel(thread)}</span>
                <span aria-hidden="true">·</span>
                <span class="max-w-28 truncate">{scopeLabel(thread)}</span>
                <span aria-hidden="true">·</span>
                <span class="flex shrink-0 items-center gap-1 text-muted">
                  <StatusBadge
                    stage={rowStatus.stage}
                    kind={rowStatus.kind}
                    variant={rowStatus.variant ?? 'dot'}
                    animated={rowStatus.animated}
                    title={rowStatus.label}
                  />
                  {rowStatus.label}
                </span>
              </span>
            </span>
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
