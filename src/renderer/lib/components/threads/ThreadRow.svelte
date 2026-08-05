<script lang="ts">
  import { tick } from 'svelte'
  import type { Attachment } from 'svelte/attachments'
  import { Check, Pin, PinOff, Pencil, Trash2, GitFork, Kanban } from '@lucide/svelte'
  import { Portal } from 'bits-ui'
  import Modal from '$lib/components/ui/Modal.svelte'
  import ChangeScopeModal from '$lib/components/threads/ChangeScopeModal.svelte'
  import ThreadDropdown from '$lib/components/shared/ThreadDropdown.svelte'
  import type { MenuItem } from '$lib/components/shared/ThreadDropdown.svelte'
  import StatusBadge from '$lib/components/shared/StatusBadge.svelte'
  import { scopeState } from '$lib/stores/scope.svelte'
  import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
  import { agentRuns } from '$lib/stores/agent-runs.svelte'
  import { reportError } from '$lib/stores/app-errors.svelte'
  import { getIconSvgDataUrl, generateInitialsIconSvg } from '$lib/project-svg-icons'
  import { pickColorForSeed } from '$lib/project-colors'
  import { projectIdentityTitle, remoteOriginLabel } from '$lib/project-location'
  import { projectRemotes } from '$lib/stores/project-remotes.svelte'
  import { DEFAULT_SCOPE_BUCKET_ID, type ScopeBucket } from '$shared/types'
  import type { Thread } from '$shared/types'

  interface Props {
    thread: Thread
    selected?: boolean
    /** Compact rendering for the pinned section. */
    compact?: boolean
    /** Presentation-only row for searchable thread pickers. */
    picker?: boolean
    /** Project icon URL to show before the status indicator. */
    projectIconUrl?: string | null
    /** Override the displayed pin state (e.g. for timeline pins). */
    pinnedOverride?: boolean
    /** Whether "Change Scope" appears in the actions menu. */
    showChangeScope?: boolean
    onOpen?: (t: Thread) => void
    onRename?: (t: Thread, newName: string) => Promise<void>
    onTogglePin?: (t: Thread) => void
    onDelete?: (t: Thread) => Promise<void>
    onFork?: (t: Thread) => void
    /** Optional callback fired when the rename input changes (for move-on-edit behaviour). */
    onRenameInputChange?: (t: Thread) => void
    /** Callback for drag-to-reorder within the same list; position is relative to this item. */
    onMoveThread?: (id: string, targetId: string, position: 'before' | 'after') => void
  }

  let {
    thread,
    selected = false,
    compact = false,
    picker = false,
    projectIconUrl = null,
    pinnedOverride = undefined,
    showChangeScope = true,
    onOpen = () => {},
    onRename = async () => {},
    onTogglePin = () => {},
    onDelete = async () => {},
    onFork = () => {},
    onRenameInputChange,
    onMoveThread
  }: Props = $props()

  const componentId = $props.id()
  let renameThreadFormId = $derived(`${componentId}-thread-${thread.id}-rename-form`)

  /** How long the "todo" dot is held after a draft is cleared on send, so the
   *  badge does not flash to the thread's stale status before the harness
   *  confirms the new working state. */
  const DRAFT_GRACE_MS = 2000

  let effectivePinned = $derived(pinnedOverride ?? thread.pinned)

  let dropIndicator = $state<'before' | 'after' | null>(null)

  function setDragImage(e: DragEvent, label: string): void {
    const ghost = document.createElement('div')
    ghost.textContent = label
    ghost.style.cssText =
      'position:absolute;top:-1000px;left:-1000px;padding:3px 8px;background:var(--color-surface);border:1px solid var(--color-border);border-radius:6px;font-size:13px;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,0.15)'
    document.body.appendChild(ghost)
    e.dataTransfer!.setDragImage(ghost, 0, 0)
    requestAnimationFrame(() => document.body.removeChild(ghost))
  }

  function handleDragStart(e: DragEvent): void {
    e.dataTransfer!.setData('text/plain', thread.id)
    e.dataTransfer!.effectAllowed = 'move'
    setDragImage(e, thread.title)
  }

  function handleDragOver(e: DragEvent): void {
    e.preventDefault()
    if (!onMoveThread) return
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    dropIndicator = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
  }

  function handleDrop(e: DragEvent): void {
    e.preventDefault()
    const draggedId = e.dataTransfer!.getData('text/plain')
    if (draggedId && draggedId !== thread.id && onMoveThread) {
      onMoveThread(draggedId, thread.id, dropIndicator ?? 'after')
    }
    dropIndicator = null
  }

  function handleDragLeave(): void {
    dropIndicator = null
  }

  let hovered = $state(false)
  let showMenu = $state(false)
  let showPopover = $state(false)
  let rowEl = $state<HTMLDivElement>()
  let popoverEl = $state<HTMLDivElement>()
  let popoverPos = $state({ x: 0, y: 0 })
  let popoverTimer: ReturnType<typeof setTimeout> | undefined

  const captureRowElement: Attachment<HTMLDivElement> = (element) => {
    rowEl = element
    return () => {
      if (rowEl === element) rowEl = undefined
    }
  }

  const capturePopoverElement: Attachment<HTMLDivElement> = (element) => {
    popoverEl = element
    return () => {
      if (popoverEl === element) popoverEl = undefined
    }
  }

  let showRenameModal = $state(false)
  let renameValue = $state('')
  let showDeleteModal = $state(false)
  let showChangeScopeModal = $state(false)
  let actionError = $state<string | null>(null)

  let menuItems = $derived<MenuItem[]>([
    {
      label: 'Rename',
      icon: Pencil,
      onClick: () => {
        renameValue = thread.title
        showRenameModal = true
      }
    },
    {
      label: effectivePinned ? 'Unpin' : 'Pin',
      icon: effectivePinned ? PinOff : Pin,
      onClick: () => onTogglePin(thread)
    },
    {
      label: 'Fork',
      icon: GitFork,
      onClick: () => onFork(thread)
    },
    ...(showChangeScope
      ? [
          {
            label: 'Change Scope',
            icon: Kanban,
            onClick: () => {
              void scopeState.ensureBoardLoaded(thread.projectId)
              showChangeScopeModal = true
            }
          }
        ]
      : []),
    { label: '', divider: true },
    {
      label: 'Delete',
      icon: Trash2,
      onClick: () => {
        showDeleteModal = true
      },
      danger: true
    }
  ] as MenuItem[])

  const POPOVER_WIDTH = 256
  const POPOVER_ESTIMATED_HEIGHT = 230
  const POPOVER_GAP = 8
  const VIEWPORT_MARGIN = 8

  // ─── Status vs Stage ──────────────────────────────────────────────────────
  //
  //   Status  = overall thread state for the dot indicator
  //             working | unread | error | completed | approval | read
  //   Stage   = what the agent is currently DOING (only when working)
  //             planning | executing
  //   Stage appears only in the hover popover, never on the row itself.
  //
  //   Badge dot conventions: todo = filled gray, done/read = transparent ring.

  type ThreadState = 'unread' | 'read' | 'todo' | 'completed' | 'working' | 'approval' | 'error'

  /** Threads with any unsent composer content read as "todo" (filled gray dot). */
  let isDraft = $derived(rendererRecovery.hasDraftContent(thread.projectId, thread.id))

  /** Whether the harness is processing a turn for this thread right now. */
  let isBusy = $derived(agentRuns.isBusy(thread.projectId, thread.id))

  /**
   * Sending clears the draft, which would otherwise flash the badge back to the
   * thread's stale status before the harness confirms the working state. Hold
   * the todo dot for a short grace after the draft clears so the transition
   * reads as draft → (briefly todo) → working instead of draft → default.
   */
  let holdingDraft = $state(false)

  function holdDraftDot(): void {
    holdingDraft = true
  }

  function releaseDraftDot(): void {
    holdingDraft = false
  }

  $effect(() => {
    if (isDraft) {
      holdDraftDot()
      return
    }
    if (!holdingDraft) return
    const timer = setTimeout(releaseDraftDot, DRAFT_GRACE_MS)
    return () => clearTimeout(timer)
  })

  let threadState = $derived.by((): ThreadState => {
    if (thread.status === 'failed') return 'error'
    if (thread.status === 'awaiting_approval') return 'approval'
    // Drafting (or the brief post-send grace) shows the todo dot.
    if (holdingDraft) return 'todo'
    if (isDraft) return 'todo'
    if (thread.status === 'planning' || thread.status === 'executing') return 'working'
    // The confirmed terminal state wins over the busy flag so a finished turn
    // flips straight to done/unread instead of lingering on the spinner.
    if (!thread.read) return 'unread'
    if (thread.status === 'completed') return 'completed'
    if (isBusy) return 'working'
    if (thread.status === 'created') return 'todo'
    return 'read'
  })

  /** Whether the agent is actively working — controls the pulsing row border. */
  let isWorking = $derived(thread.status === 'planning' || thread.status === 'executing')

  /** Human-readable stage label, only meaningful when isWorking is true. */
  let stageLabel = $derived.by((): string => {
    switch (thread.status) {
      case 'planning':
        return 'Planning'
      case 'executing':
        return 'Working'
      default:
        return ''
    }
  })

  let scopeBucket = $derived.by((): ScopeBucket | null => {
    const bucketId = scopeState.bucketForThread(thread)
    if (bucketId === DEFAULT_SCOPE_BUCKET_ID) return null
    return scopeState.bucketFor(thread.projectId, bucketId)
  })

  /** Project (repo) that owns this thread, resolved for the hover popover. */
  let project = $derived(
    scopeState.projectRecords.find((candidate) => candidate.id === thread.projectId) ?? null
  )

  /** Git remote origin URL for the thread's project, resolved lazily on hover. */
  let remoteOriginUrl = $derived(projectRemotes.get(thread.projectId) ?? null)

  let scopeColor = $derived(
    scopeBucket ? (scopeBucket.color ?? pickColorForSeed(scopeBucket.id)) : ''
  )

  let scopeIconUrl = $derived.by((): string | null => {
    if (!scopeBucket) return null
    if (scopeBucket.iconType) return getIconSvgDataUrl(scopeBucket.iconType, scopeColor)
    if (scopeBucket.color) return generateInitialsIconSvg(scopeBucket.name, scopeColor)
    return null
  })

  /** Status remains visible for pinned threads; hover temporarily reveals the pin action. */
  let pinVisible = $derived(hovered)

  /** Maps ThreadState to StatusBadge props — all colours flow through the
   *  canonical StatusBadge component so every indicator stays consistent. */
  let badgeProps = $derived.by(
    (): {
      stage?: 'todo' | 'working' | 'issue' | 'unread' | 'done' | 'pinned'
      kind?: 'completed' | 'attention' | 'error'
      variant?: 'dot' | 'spinner'
      animated?: boolean
    } | null => {
      switch (threadState) {
        case 'unread':
          return { stage: 'unread' }
        case 'todo':
          return { stage: 'todo' }
        case 'working':
          return { variant: 'spinner', stage: 'working' }
        case 'approval':
          return { kind: 'attention', animated: true }
        case 'error':
          return { kind: 'error' }
        default:
          // completed / read → transparent ring
          return null
      }
    }
  )

  // ─── Relative time ───────────────────────────────────────────────────────

  function relativeTime(ts: number): string {
    const diff = Date.now() - ts
    const minutes = Math.floor(diff / 60_000)
    if (minutes < 1) return 'Now'
    if (minutes < 60) return `${minutes}m`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h`
    const days = Math.floor(hours / 24)
    if (days < 7) return `${days}d`
    const weeks = Math.floor(days / 7)
    if (weeks < 5) return `${weeks}w`
    const months = Math.floor(days / 30)
    if (months < 12) return `${months}mo`
    const years = Math.floor(days / 365)
    return `${years}y`
  }

  function formatDate(ts: number): string {
    return new Date(ts).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short'
    })
  }

  // ─── Hover interactions ──────────────────────────────────────────────────

  function calculatePopoverPosition(
    anchor: DOMRect,
    width: number,
    height: number
  ): { x: number; y: number } {
    const availableRight = window.innerWidth - anchor.right - VIEWPORT_MARGIN
    const availableLeft = anchor.left - VIEWPORT_MARGIN
    const placeRight = availableRight >= width || availableRight >= availableLeft
    const preferredX = placeRight ? anchor.right + POPOVER_GAP : anchor.left - POPOVER_GAP - width
    const maxX = Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN)
    const maxY = Math.max(VIEWPORT_MARGIN, window.innerHeight - height - VIEWPORT_MARGIN)

    return {
      x: Math.max(VIEWPORT_MARGIN, Math.min(preferredX, maxX)),
      y: Math.max(VIEWPORT_MARGIN, Math.min(anchor.top, maxY))
    }
  }

  async function revealPopover(): Promise<void> {
    if (!rowEl || showMenu || !hovered) return

    popoverPos = calculatePopoverPosition(
      rowEl.getBoundingClientRect(),
      POPOVER_WIDTH,
      POPOVER_ESTIMATED_HEIGHT
    )
    showPopover = true
    await tick()

    if (!rowEl || !popoverEl || showMenu || !hovered) return
    const popoverRect = popoverEl.getBoundingClientRect()
    popoverPos = calculatePopoverPosition(
      rowEl.getBoundingClientRect(),
      popoverRect.width,
      popoverRect.height
    )
  }

  function onRowEnter(): void {
    hovered = true
    clearTimeout(popoverTimer)
    if (project) void projectRemotes.ensure(thread.projectId, project.path)
    popoverTimer = setTimeout(() => {
      void revealPopover()
    }, 550)
  }

  function onRowLeave(): void {
    hovered = false
    clearTimeout(popoverTimer)
    showPopover = false
  }

  /** Right-click anywhere on the row opens the actions menu. */
  function openContextMenu(e: MouseEvent): void {
    e.preventDefault()
    e.stopPropagation()
    showPopover = false
    clearTimeout(popoverTimer)
    showMenu = true
  }

  function errorMessage(error: unknown, fallback: string): string {
    return error instanceof Error ? error.message : fallback
  }

  async function confirmRename(): Promise<void> {
    if (!renameValue.trim()) return
    try {
      actionError = null
      await onRename(thread, renameValue.trim())
      showRenameModal = false
    } catch (error) {
      actionError = errorMessage(error, 'Could not rename thread')
    }
  }

  async function confirmDelete(): Promise<void> {
    try {
      actionError = null
      await onDelete(thread)
      showDeleteModal = false
    } catch (error) {
      reportError(error, 'Could not delete thread', {
        projectId: thread.projectId,
        threadId: thread.id
      })
    }
  }
</script>

{#if picker}
  <div
    class="flex min-h-11 w-full items-center gap-2 border-l-2 px-2.5 py-2 text-left transition-colors {selected
      ? 'border-foreground bg-elevated'
      : isWorking
        ? 'border-thread-working bg-thread-working/5'
        : 'border-transparent'}"
    title={thread.title}
  >
    {#if projectIconUrl}
      <img src={projectIconUrl} alt="" class="h-4 w-4 shrink-0 rounded object-contain" />
    {/if}
    <span class="flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden="true">
      {#if badgeProps}
        <StatusBadge
          stage={badgeProps.stage}
          kind={badgeProps.kind}
          variant={badgeProps.variant ?? 'dot'}
          animated={badgeProps.animated}
          size="md"
          title={isWorking ? stageLabel : threadState}
        />
      {:else}
        <span class="h-2 w-2 rounded-full border border-border-strong bg-transparent"></span>
      {/if}
    </span>
    <span class="min-w-0 flex-1">
      <span
        class="block truncate text-[13px] {threadState === 'approval' || threadState === 'unread'
          ? 'font-medium text-foreground'
          : 'text-foreground'}"
      >
        {threadState === 'approval' ? 'Needs Attention' : thread.title}
      </span>
      {#if thread.branch}
        <span class="mt-0.5 block truncate font-mono text-[10px] text-dimmed">
          {thread.branch}
        </span>
      {/if}
    </span>
    <span class="shrink-0 whitespace-nowrap text-[10px] text-dimmed">
      {relativeTime(thread.createdAt)}
    </span>
    {#if selected}
      <Check size={13} class="shrink-0 text-primary" />
    {/if}
  </div>
{/if}

<div
  {@attach captureRowElement}
  class="relative {picker ? 'hidden' : ''}"
  role="listitem"
  data-thread-row={thread.id}
  aria-hidden={picker}
  draggable={!picker}
  ondragstart={handleDragStart}
  ondragover={handleDragOver}
  ondrop={handleDrop}
  ondragleave={handleDragLeave}
  onmouseenter={onRowEnter}
  onmouseleave={onRowLeave}
>
  <!-- Stable drop indicator — always rendered, opacity toggled to avoid layout shift -->
  <div
    class="pointer-events-none absolute left-0 right-0 top-0 h-[2px] transition-opacity duration-100 {dropIndicator ===
    'before'
      ? 'bg-primary opacity-100'
      : 'opacity-0'}"
  ></div>
  <div
    class="pointer-events-none absolute bottom-0 left-0 right-0 h-[2px] transition-opacity duration-100 {dropIndicator ===
    'after'
      ? 'bg-primary opacity-100'
      : 'opacity-0'}"
  ></div>
  <button
    class="flex w-full items-center gap-2 border-l-2 text-left transition-colors {compact
      ? 'px-2 py-1'
      : 'px-2 py-1.5'} {selected
      ? 'border-foreground bg-elevated'
      : isWorking
        ? 'animate-pulse border-thread-working bg-thread-working/5 hover:bg-elevated'
        : 'border-transparent hover:border-border-strong hover:bg-elevated'}"
    title={thread.title}
    onclick={() => {
      showPopover = false
      clearTimeout(popoverTimer)
      onOpen(thread)
    }}
    oncontextmenu={openContextMenu}
  >
    <!-- Project icon -->
    {#if projectIconUrl}
      <img src={projectIconUrl} alt="" class="h-3.5 w-3.5 shrink-0 rounded object-contain" />
    {/if}

    <!-- State indicator / pin toggle — fixed slot, opacity crossfade, zero layout shift -->
    <span class="relative h-4 w-4 shrink-0">
      <span
        class="absolute inset-0 flex items-center justify-center transition-opacity duration-150 {pinVisible
          ? 'opacity-0'
          : 'opacity-100'}"
        aria-hidden={pinVisible}
      >
        {#if badgeProps}
          <StatusBadge
            stage={badgeProps.stage}
            kind={badgeProps.kind}
            variant={badgeProps.variant ?? 'dot'}
            animated={badgeProps.animated}
            size="md"
            title={isWorking ? stageLabel : threadState}
          />
        {:else}
          <span
            class="h-2 w-2 rounded-full border border-border-strong bg-transparent"
            aria-label={threadState}
            title={threadState}
          ></span>
        {/if}
      </span>
      <span
        role="button"
        tabindex={-1}
        class="absolute inset-0 flex items-center justify-center rounded transition-opacity duration-150 hover:bg-overlay {pinVisible
          ? 'opacity-100'
          : 'pointer-events-none opacity-0'}"
        aria-label={effectivePinned ? 'Unpin thread' : 'Pin thread'}
        aria-hidden={!pinVisible}
        title={effectivePinned ? 'Unpin' : 'Pin'}
        onclick={(e: MouseEvent) => {
          e.stopPropagation()
          onTogglePin(thread)
        }}
        onkeydown={(e: KeyboardEvent) => {
          if (e.key === 'Enter') {
            e.stopPropagation()
            onTogglePin(thread)
          }
        }}
      >
        <Pin size={11} class={effectivePinned ? 'text-accent' : 'text-dimmed'} />
      </span>
    </span>

    <!-- Title -->
    <span
      class="min-w-0 flex-1 truncate text-[13px] {threadState === 'approval'
        ? 'font-medium text-warning'
        : threadState === 'unread'
          ? 'font-medium text-foreground'
          : 'text-foreground'}"
    >
      {threadState === 'approval' ? 'Needs Attention' : thread.title}
    </span>

    <!-- Time ↔ ellipsis — auto-width slot, time never wraps, opacity crossfade -->
    <span class="relative flex h-5 min-w-6 shrink-0 items-center justify-end">
      <span
        class="whitespace-nowrap text-[10px] text-dimmed transition-opacity duration-150 {hovered
          ? 'opacity-0'
          : 'opacity-100'}"
        aria-hidden={hovered}
      >
        {relativeTime(thread.createdAt)}
      </span>
      <span
        class="absolute inset-0 flex items-center justify-end transition-opacity duration-150 {hovered
          ? 'opacity-100'
          : 'pointer-events-none opacity-0'}"
        aria-hidden={!hovered}
      >
        <ThreadDropdown
          bind:open={showMenu}
          items={menuItems}
          onOpen={() => {
            showPopover = false
            clearTimeout(popoverTimer)
          }}
        />
      </span>
    </span>
  </button>

  <!-- Hover popover with thread info -->
  {#if showPopover}
    <Portal>
      <div
        {@attach capturePopoverElement}
        class="fixed z-60 max-h-[calc(100vh-1rem)] w-64 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-xl border bg-surface p-3 shadow-lg"
        style="left: {popoverPos.x}px; top: {popoverPos.y}px"
      >
        <p class="mb-2 break-words text-sm font-medium text-foreground">{thread.title}</p>
        <dl class="space-y-1.5 text-[11px]">
          <div class="flex gap-2">
            <dt class="w-16 shrink-0 text-dimmed">Repo</dt>
            <dd
              class="truncate text-muted"
              title={remoteOriginUrl ?? (project ? projectIdentityTitle(project) : undefined)}
            >
              {remoteOriginUrl ? remoteOriginLabel(remoteOriginUrl) : (project?.name ?? '—')}
            </dd>
          </div>
          <div class="flex gap-2">
            <dt class="w-16 shrink-0 text-dimmed">Branch</dt>
            <dd class="truncate text-muted">{thread.branch ?? '—'}</dd>
          </div>
          {#if scopeBucket}
            <div class="flex gap-2">
              <dt class="w-16 shrink-0 text-dimmed">Scope</dt>
              <dd class="flex items-center gap-1 truncate text-muted">
                {#if scopeIconUrl}
                  <img
                    src={scopeIconUrl}
                    alt=""
                    class="h-3 w-3 shrink-0 object-contain"
                    draggable="false"
                  />
                {/if}
                <span>{scopeBucket.name}</span>
              </dd>
            </div>
          {/if}
          <div class="flex gap-2">
            <dt class="w-16 shrink-0 text-dimmed">Created</dt>
            <dd class="text-muted">{formatDate(thread.createdAt)}</dd>
          </div>
          <div class="flex gap-2">
            <dt class="w-16 shrink-0 text-dimmed">Updated</dt>
            <dd class="text-muted">{formatDate(thread.updatedAt)}</dd>
          </div>
          {#if isWorking}
            <div class="flex gap-2">
              <dt class="w-16 shrink-0 text-dimmed">Stage</dt>
              <dd class="flex items-center gap-1 text-muted">
                <StatusBadge stage="working" animated size="sm" title={stageLabel} />
                {stageLabel}
              </dd>
            </div>
          {/if}
          {#if threadState === 'approval'}
            <div class="flex gap-2">
              <dt class="w-16 shrink-0 text-dimmed">Stage</dt>
              <dd class="flex items-center gap-1 text-warning">
                <StatusBadge kind="attention" animated size="sm" title="Needs Attention" />
                Needs Attention
              </dd>
            </div>
          {/if}
        </dl>
      </div>
    </Portal>
  {/if}
</div>

{#if actionError}
  <div
    class="fixed bottom-4 right-4 z-60 rounded-lg bg-danger px-4 py-2 text-sm text-white shadow-lg"
  >
    {actionError}
  </div>
{/if}

<Modal open={showRenameModal} title="Rename Thread" onClose={() => (showRenameModal = false)}>
  <form
    id={renameThreadFormId}
    class="space-y-4"
    onsubmit={(e: SubmitEvent) => {
      e.preventDefault()
      void confirmRename()
    }}
  >
    <div>
      <label class="mb-1 block text-xs font-medium text-muted" for="thread-rename-input"
        >Title</label
      >
      <input
        id="thread-rename-input"
        type="text"
        class="w-full rounded-lg border bg-elevated px-3 py-2 text-sm text-foreground placeholder:text-dimmed"
        bind:value={renameValue}
        oninput={() => onRenameInputChange?.(thread)}
      />
    </div>
  </form>

  {#snippet footer()}
    <button
      type="button"
      class="rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:bg-elevated"
      onclick={() => (showRenameModal = false)}
    >
      Cancel
    </button>
    <button
      type="submit"
      form={renameThreadFormId}
      class="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-on-primary transition-colors hover:bg-primary-hover"
      disabled={!renameValue.trim()}
    >
      Save
    </button>
  {/snippet}
</Modal>

<Modal open={showDeleteModal} title="Delete Thread" onClose={() => (showDeleteModal = false)}>
  <p class="text-sm leading-relaxed text-muted">
    This will permanently delete
    <span class="font-medium text-foreground">{thread.title}</span>
    and all of its history. This action cannot be undone.
  </p>

  {#snippet footer()}
    <button
      type="button"
      class="rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:bg-elevated"
      onclick={() => (showDeleteModal = false)}
    >
      Cancel
    </button>
    <button
      type="button"
      class="rounded-lg bg-danger px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-danger/90"
      onclick={() => void confirmDelete()}
    >
      Delete
    </button>
  {/snippet}
</Modal>

{#if showChangeScopeModal && !picker}
  <ChangeScopeModal
    open={showChangeScopeModal}
    onClose={() => (showChangeScopeModal = false)}
    threadId={thread.id}
    projectId={thread.projectId}
    currentBucketId={thread.scopeBucketId ?? DEFAULT_SCOPE_BUCKET_ID}
  />
{/if}
