<script lang="ts">
  import { AlertTriangle, BotMessageSquare } from '@lucide/svelte'
  import { Portal } from 'bits-ui'
  import { tick } from 'svelte'
  import { createSubscriber } from 'svelte/reactivity'
  import Modal from '$lib/components/ui/Modal.svelte'
  import ThreadDeleteConfirm from '$lib/components/ui/ThreadDeleteConfirm.svelte'
  import StatusBadge from '$lib/components/shared/StatusBadge.svelte'
  import ThreadDropdown from '$lib/components/shared/ThreadDropdown.svelte'
  import ThreadHoverPopover from '$lib/components/shared/ThreadHoverPopover.svelte'
  import { createThreadActionsMenu } from '$lib/components/shared/thread-actions-menu.svelte'
  import AssistantHandoffModals from './AssistantHandoffModals.svelte'
  import { createAssistantHandoff } from './assistant-handoff.svelte'
  import {
    THREAD_HOVER_POPOVER_SURFACE_CLASS,
    calculateThreadHoverPopoverPosition,
    resolveThreadHoverPopoverSize,
    threadHoverPopoverStyle
  } from '$lib/components/shared/thread-hover-popover-layout'
  import { longPress } from '$lib/long-press.svelte'
  import { getIconSvgDataUrl } from '$lib/project-svg-icons'
  import { agentRuns } from '$lib/stores/agent-runs.svelte'
  import { reportError } from '$lib/stores/app-errors.svelte'
  import { foreignRuns } from '$lib/stores/foreign-runs.svelte'
  import { isThreadWorking, type Thread } from '$shared/types'
  import { threadStatusPolicy } from '$shared/thread-status-policy'
  import { taskPopoverState, taskRunLine } from './assistant-view'

  interface Props {
    task: Thread
    active: boolean
    /** Routine accent colour, used for the icon fallback tint. */
    color?: string
    /** Pending missed fires on this task. */
    missed: boolean
    /** Next intended fire (epoch ms) when the task is scheduled, else null. */
    nextRunAt: number | null
    /** Human-readable schedule label (schedule override or owning routine). */
    scheduleLabel?: string | null
    onSelect: (task: Thread) => void
    /** The full thread action set, so a task behaves exactly like a thread row. */
    onRename: (task: Thread, newName: string) => Promise<void>
    onTogglePin: (task: Thread) => void
    onDelete: (task: Thread) => Promise<void>
    onFork: (task: Thread) => void
    onOpenNotes: (task: Thread) => void
    /** Hand this task off to a project, forking it and seeding a summary. */
    onHandedOff: (forked: Thread) => void
  }

  let {
    task,
    active,
    color,
    missed,
    nextRunAt,
    scheduleLabel = null,
    onSelect,
    onRename,
    onTogglePin,
    onDelete,
    onFork,
    onOpenNotes,
    onHandedOff
  }: Props = $props()

  const TASK_DRAG_TYPE = 'application/x-assistant-task'

  const componentId = $props.id()
  const renameFormId = $derived(`${componentId}-task-${task.id}-rename-form`)
  const renameInputId = $derived(`${componentId}-task-${task.id}-rename-input`)

  /** Coarse clock so relative run lines stay current without a render storm. */
  const subscribeMinute = createSubscriber((update) => {
    const timer = window.setInterval(update, 60_000)
    return () => window.clearInterval(timer)
  })

  const taskIcon = $derived(
    task.assistantIconType ? getIconSvgDataUrl(task.assistantIconType, color ?? '#8b95a5') : null
  )

  /** Line 2: next-run time for scheduled tasks, last-run time for unscheduled. */
  const runLine = $derived.by(() => {
    subscribeMinute()
    return taskRunLine(task, nextRunAt, Date.now())
  })

  const statusTone = $derived(threadStatusPolicy(task.status).tone)
  const title = $derived(`Open task: ${task.title}`)

  /** Live-work flags, settled by the same run state the thread rows use so a
   *  stale persisted status cannot keep a spinner alive after the turn ended. */
  const isWorking = $derived(
    agentRuns.hasSettled(task.projectId, task.id)
      ? agentRuns.isBusy(task.projectId, task.id)
      : Boolean(task.sessionId) && isThreadWorking(task)
  )
  const isRetryPaused = $derived(task.status === 'working-paused')
  const isForeignRun = $derived(foreignRuns.isForeign(task.projectId, task.id))
  const stageLabel = $derived(threadStatusPolicy(task.status).label)

  const handoff = createAssistantHandoff({
    getTask: () => task,
    onHandedOff: (forked) => onHandedOff(forked)
  })

  const actionsMenu = createThreadActionsMenu({
    getThread: () => task,
    onRename: (t, newName) => onRename(t, newName),
    onTogglePin: (t) => onTogglePin(t),
    onFork: (t) => onFork(t),
    onDelete: (t) => onDelete(t),
    onDeleteError: (error) =>
      reportError(error, 'Could not delete task', {
        projectId: task.projectId,
        threadId: task.id
      }),
    onOpenNotes: (t) => onOpenNotes(t),
    // Assistant tasks live in the hidden assistant container: there is no scope
    // to change, but notes and copy-id are exactly as useful as on a thread.
    showChangeScope: () => false,
    showNotes: () => true,
    showCopyId: () => true,
    // Hand-off belongs to the task's own menu, never to the panel.
    onHandoff: () => handoff.open(),
    showHandoff: () => true
  })

  // ─── Hover popover ───────────────────────────────────────────────────────
  let rowEl: HTMLElement | undefined = $state(undefined)
  let popoverEl: HTMLElement | undefined = $state(undefined)
  let hovered = $state(false)
  let showPopover = $state(false)
  let showMenu = $state(false)
  let popoverTimer: ReturnType<typeof setTimeout> | undefined
  let popoverPos = $state({ x: 0, y: 0 })

  async function revealPopover(): Promise<void> {
    if (!rowEl || showMenu || !hovered) return
    const size = resolveThreadHoverPopoverSize()
    popoverPos = calculateThreadHoverPopoverPosition(
      rowEl.getBoundingClientRect(),
      size.width,
      size.height
    )
    showPopover = true
    await tick()
    if (!rowEl || !popoverEl || showMenu || !hovered) return
    const rect = popoverEl.getBoundingClientRect()
    popoverPos = calculateThreadHoverPopoverPosition(
      rowEl.getBoundingClientRect(),
      rect.width,
      rect.height
    )
  }

  function onRowEnter(): void {
    hovered = true
    clearTimeout(popoverTimer)
    popoverTimer = setTimeout(() => void revealPopover(), 550)
  }

  function onRowLeave(): void {
    hovered = false
    clearTimeout(popoverTimer)
    showPopover = false
  }

  /** Touch has no hover or right click, so a long press opens the same menu. */
  function openActionsByTouch(): void {
    hovered = true
    showPopover = false
    clearTimeout(popoverTimer)
    showMenu = true
  }

  /** Right-click anywhere on the row opens the thread actions menu. */
  function openContextMenu(event: MouseEvent): void {
    event.preventDefault()
    event.stopPropagation()
    showPopover = false
    clearTimeout(popoverTimer)
    showMenu = true
  }

  function capturePopoverElement(element: HTMLElement): void {
    popoverEl = element
  }

  function handleDragStart(event: DragEvent): void {
    if (!event.dataTransfer) return
    event.dataTransfer.setData(TASK_DRAG_TYPE, task.id)
    event.dataTransfer.setData('text/plain', task.id)
    event.dataTransfer.effectAllowed = 'move'
    const ghost = document.createElement('div')
    ghost.textContent = task.title
    ghost.style.cssText =
      'position:absolute;top:-1000px;left:-1000px;padding:3px 8px;background:var(--color-surface);border:1px solid var(--color-border);border-radius:6px;font-size:13px;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,0.15)'
    document.body.appendChild(ghost)
    event.dataTransfer.setDragImage(ghost, 0, 0)
    requestAnimationFrame(() => document.body.removeChild(ghost))
    showPopover = false
    clearTimeout(popoverTimer)
  }
</script>

<div
  class="relative"
  role="listitem"
  bind:this={rowEl}
  {@attach longPress({ onLongPress: openActionsByTouch })}
  onpointerenter={onRowEnter}
  onpointerleave={onRowLeave}
>
  <button
    type="button"
    data-thread-row={task.id}
    class="group relative flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors {active
      ? 'bg-selected'
      : 'hover:bg-elevated'}"
    {title}
    draggable="true"
    ondragstart={handleDragStart}
    aria-current={active ? 'true' : undefined}
    onclick={() => {
      showPopover = false
      clearTimeout(popoverTimer)
      onSelect(task)
    }}
    oncontextmenu={openContextMenu}
  >
    <span class="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
      {#if taskIcon}
        <img src={taskIcon} alt="" class="h-4 w-4 object-contain" draggable="false" />
      {:else}
        <BotMessageSquare
          size={14}
          strokeWidth={1.8}
          style="color: {color ?? 'var(--color-muted)'}"
        />
      {/if}
    </span>

    <span class="min-w-0 flex-1">
      <span class="flex items-center gap-1.5">
        <span
          class="truncate text-[0.75rem] leading-tight {active ? 'text-foreground' : 'text-muted'}"
        >
          {task.title}
        </span>
        {#if missed}
          <span
            class="flex shrink-0 items-center"
            style="color: var(--color-missed)"
            role="img"
            aria-label="A scheduled run was missed"
            title="A scheduled run was missed"
          >
            <AlertTriangle size={12} />
          </span>
        {/if}
      </span>
      <span class="mt-0.5 flex items-center gap-1.5">
        <StatusBadge
          tone={missed ? 'missed' : statusTone}
          size="sm"
          title={missed ? 'Missed run' : task.status}
        />
        <span class="truncate text-[0.625rem] text-dimmed" title={scheduleLabel ?? undefined}>
          {runLine}
        </span>
      </span>
    </span>

    <!-- Hover actions float over the row (opaque surface matching the row's
         hover background) instead of reserving width, so the title truncates at
         the full row width and is only covered while the actions are visible. -->
    <span
      class="pointer-events-none absolute inset-y-1 right-1 z-10 flex items-center rounded-md px-0.5 opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 {active
        ? 'bg-selected'
        : 'bg-elevated'}"
    >
      <ThreadDropdown
        bind:open={showMenu}
        items={actionsMenu.items}
        vertical
        title="Task actions"
        ariaLabel="Actions for {task.title}"
        onOpen={() => {
          showPopover = false
          clearTimeout(popoverTimer)
        }}
      />
    </span>
  </button>
</div>

{#if showPopover}
  <Portal>
    <div
      {@attach capturePopoverElement}
      class={THREAD_HOVER_POPOVER_SURFACE_CLASS}
      style={threadHoverPopoverStyle(popoverPos.x, popoverPos.y)}
    >
      <ThreadHoverPopover
        thread={task}
        {isWorking}
        {isRetryPaused}
        {isForeignRun}
        {stageLabel}
        threadState={taskPopoverState(task)}
        hideProject
      />
    </div>
  </Portal>
{/if}

<Modal open={actionsMenu.showRenameModal} title="Rename Task" onClose={actionsMenu.cancelRename}>
  <form
    id={renameFormId}
    class="space-y-4"
    onsubmit={(event: SubmitEvent) => {
      event.preventDefault()
      void actionsMenu.confirmRename()
    }}
  >
    <div>
      <label class="mb-1 block text-xs font-medium text-muted" for={renameInputId}>Title</label>
      <input
        id={renameInputId}
        type="text"
        class="w-full rounded-lg border bg-elevated px-3 py-2 text-sm text-foreground placeholder:text-dimmed"
        bind:value={actionsMenu.renameValue}
      />
    </div>
  </form>

  {#snippet footer()}
    <button
      type="button"
      class="rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:bg-elevated"
      onclick={actionsMenu.cancelRename}
    >
      Cancel
    </button>
    <button
      type="submit"
      form={renameFormId}
      class="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-on-primary transition-colors hover:bg-primary-hover"
      disabled={!actionsMenu.renameValue.trim()}
    >
      Save
    </button>
  {/snippet}
</Modal>

<ThreadDeleteConfirm
  open={actionsMenu.showDeleteModal}
  threadTitle={task.title}
  onClose={actionsMenu.cancelDelete}
  onConfirm={actionsMenu.confirmDelete}
/>

<AssistantHandoffModals controller={handoff} />
