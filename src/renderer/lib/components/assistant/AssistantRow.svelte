<script lang="ts">
  import AssistantIcon from '$lib/components/icons/cio/AssistantIcon.svelte'
  import CioAttention from '$lib/components/icons/cio/CioAttention.svelte'
  import CioCalendar from '$lib/components/icons/cio/CioCalendar.svelte'
  import CioEllipsis from '$lib/components/icons/cio/CioEllipsis.svelte'
  import CioForward from '$lib/components/icons/cio/CioForward.svelte'
  import CioPause from '$lib/components/icons/cio/CioPause.svelte'
  import CioPencil from '$lib/components/icons/cio/CioPencil.svelte'
  import CioPin from '$lib/components/icons/cio/CioPin.svelte'
  import CioPinOff from '$lib/components/icons/cio/CioPinOff.svelte'
  import CioPlus from '$lib/components/icons/cio/CioPlus.svelte'
  import CioSkipForward from '$lib/components/icons/cio/CioSkipForward.svelte'
  import CioTrash from '$lib/components/icons/cio/CioTrash.svelte'
  import { DropdownMenu, Portal } from 'bits-ui'
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte'
  import ThreadStateCounts from '$lib/components/shared/ThreadStateCounts.svelte'
  import { type ThreadStateCounts as ThreadStateCountsValue } from '$lib/thread-state-counts'
  import SidebarSearchControl from '$lib/components/workspace/SidebarSearchControl.svelte'
  import { AssistantDefaultIcon, getAssistantIcon } from '$lib/assistant-icons'
  import { assistantIsScheduled, type Assistant } from '$shared/types'
  import { assistantGap, assistantNextRunLine, assistantRunCountLabel } from './assistant-view'
  import {
    THREAD_HOVER_POPOVER_SURFACE_CLASS,
    threadHoverPopoverStyle
  } from '$lib/components/shared/thread-hover-popover-layout'
  import { createThreadHoverPopover } from '$lib/components/shared/thread-hover-popover.svelte'
  import AssistantHoverPopover from './AssistantHoverPopover.svelte'

  interface Props {
    assistant: Assistant
    expanded: boolean
    /**
     * How this assistant's threads break down   its tasks and their runs   by
     * working, attention, and error. This is the same indicator a project row
     * wears, so an assistant summarizes its work the same way.
     */
    stateCounts: ThreadStateCountsValue
    /** At least one task or run waits on the user or has failed. */
    attention: boolean
    /** Any task carries a pending missed run. */
    missed: boolean
    /** How many times this assistant has run: one row per execution. The assistant's
     *  Getting started host is not an execution, so it is never counted here. */
    runCount: number
    /** Custom icon data URL for this assistant, when it stores one. */
    iconUrl?: string | null
    /** Next intended fire for the assistant, or null when unscheduled. */
    nextRunAt: number | null
    /** Inline assistant-search state, driven from the sidebar. */
    searchOpen: boolean
    searchQuery: string
    onToggle: (assistant: Assistant) => void
    onSearchOpenChange: (assistant: Assistant, open: boolean) => void
    onSearchQueryChange: (assistant: Assistant, value: string) => void
    onCreateTask: (assistant: Assistant) => void
    onOpenKnowledge: (assistant: Assistant) => void
    onEdit: (assistant: Assistant) => void
    onHasAssistantRunsToday: (assistant: Assistant) => Promise<boolean>
    onSkipNextAssistantRun: (assistant: Assistant) => Promise<void>
    onSkipAssistantRunsToday: (assistant: Assistant) => Promise<void>
    onTogglePin: (assistant: Assistant) => void
    onDelete: (assistant: Assistant) => void
    /** Drag-to-reorder assistants; position is relative to this row. */
    onMoveAssistant: (draggedId: string, targetId: string, position: 'before' | 'after') => void
    /** A task (thread) drag was dropped onto this assistant. */
    onDropTask: (taskId: string, assistantId: string) => void
  }

  let {
    assistant,
    expanded,
    stateCounts,
    attention,
    missed,
    runCount,
    iconUrl = null,
    nextRunAt,
    searchOpen,
    searchQuery,
    onToggle,
    onSearchOpenChange,
    onSearchQueryChange,
    onCreateTask,
    onOpenKnowledge,
    onEdit,
    onHasAssistantRunsToday,
    onSkipNextAssistantRun,
    onSkipAssistantRunsToday,
    onTogglePin,
    onDelete,
    onMoveAssistant,
    onDropTask
  }: Props = $props()

  const TASK_DRAG_TYPE = 'application/x-assistant-task'

  const color = $derived(assistant.color ?? 'var(--color-muted)')
  // Custom image wins, then the SVG icon type tinted with the assistant colour;
  // without either the row draws the assistant default mark.
  const assistantIcon = $derived(getAssistantIcon(assistant, iconUrl))
  const incomplete = $derived(assistantGap(assistant) !== null)
  const working = $derived(stateCounts.working > 0)
  /** Line 2's next fire, beside the run count (see `assistantNextRunLine`). */
  const nextRunLabel = $derived(assistantNextRunLine(assistant, nextRunAt, Date.now()))
  const scheduled = $derived(assistantIsScheduled(assistant))
  const gapLabel = $derived(assistantGap(assistant) ?? '')
  const toggleTitle = $derived(`${expanded ? 'Collapse' : 'Expand'} assistant: ${assistant.name}`)

  let menuOpen = $state(false)
  let hasRunsToday = $state(false)
  let skipConfirm = $state<'next' | 'today' | null>(null)
  let skipBusy = $state(false)
  let dropIndicator = $state<'before' | 'after' | null>(null)
  let taskDropActive = $state(false)

  // ─── Hover popover ───────────────────────────────────────────────────────
  /** The assistant's info popover, shared with every surface that shows one. */
  const popover = createThreadHoverPopover({ isBlocked: () => menuOpen })
  let todayRunsCheck = 0

  const skipDialogTitle = $derived(
    skipConfirm === 'today' ? "Skip today's runs?" : 'Skip next run?'
  )
  const skipConfirmLabel = $derived(skipConfirm === 'today' ? 'Skip for today' : 'Skip next run')

  async function confirmSkip(): Promise<void> {
    const action = skipConfirm
    if (!action || skipBusy) return
    skipBusy = true
    try {
      if (action === 'next') await onSkipNextAssistantRun(assistant)
      else await onSkipAssistantRunsToday(assistant)
      skipConfirm = null
    } catch {
      // The workspace reports the error; keep the confirmation open for retry.
    } finally {
      skipBusy = false
    }
  }

  function onMenuOpenChange(open: boolean): void {
    menuOpen = open
    if (!open) {
      todayRunsCheck += 1
      hasRunsToday = false
      return
    }

    const check = ++todayRunsCheck
    hasRunsToday = false
    void onHasAssistantRunsToday(assistant)
      .then((hasRuns) => {
        if (menuOpen && check === todayRunsCheck) hasRunsToday = hasRuns
      })
      .catch(() => {
        if (check === todayRunsCheck) hasRunsToday = false
      })
  }

  function openContextMenu(event: MouseEvent): void {
    event.preventDefault()
    popover.hide()
    onMenuOpenChange(true)
  }

  function captureRowElement(element: HTMLElement): () => void {
    popover.setRow(element)
    return () => popover.setRow(undefined)
  }

  function capturePopoverElement(element: HTMLElement): () => void {
    popover.setPopover(element)
    return () => popover.setPopover(undefined)
  }

  // ─── Drag & drop ───────────────────────────────────────────────────────
  function setDragImage(event: DragEvent, label: string): void {
    const ghost = document.createElement('div')
    ghost.textContent = label
    ghost.style.cssText =
      'position:absolute;top:-1000px;left:-1000px;padding:3px 8px;background:var(--color-surface);border:1px solid var(--color-border);font-size:13px;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,0.15)'
    document.body.appendChild(ghost)
    event.dataTransfer?.setDragImage(ghost, 0, 0)
    requestAnimationFrame(() => document.body.removeChild(ghost))
  }

  function handleDragStart(event: DragEvent): void {
    if (!event.dataTransfer) return
    event.dataTransfer.setData('text/plain', assistant.id)
    event.dataTransfer.effectAllowed = 'move'
    setDragImage(event, assistant.name)
    popover.hide()
  }

  function handleDragOver(event: DragEvent): void {
    const types = event.dataTransfer?.types ?? []
    if (types.includes('Files')) return
    event.preventDefault()
    if (types.includes(TASK_DRAG_TYPE)) {
      taskDropActive = true
      dropIndicator = null
      return
    }
    if (!types.includes('text/plain')) return
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    dropIndicator = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
  }

  function handleDrop(event: DragEvent): void {
    const types = event.dataTransfer?.types ?? []
    if (types.includes('Files')) return
    event.preventDefault()
    const taskId = event.dataTransfer?.getData(TASK_DRAG_TYPE)
    if (taskId) {
      onDropTask(taskId, assistant.id)
      taskDropActive = false
      return
    }
    const draggedId = event.dataTransfer?.getData('text/plain')
    if (draggedId && draggedId !== assistant.id) {
      onMoveAssistant(draggedId, assistant.id, dropIndicator ?? 'after')
    }
    dropIndicator = null
  }

  function handleDragLeave(): void {
    dropIndicator = null
    taskDropActive = false
  }
</script>

<div
  class="group relative flex items-center gap-1 border-l-2 px-1.5 py-2 transition-colors {expanded
    ? 'bg-elevated/70'
    : taskDropActive
      ? 'bg-primary/10'
      : 'hover:bg-elevated'}"
  style="border-color: {assistant.color ?? 'var(--color-border-strong)'}"
  role="listitem"
  draggable="true"
  ondragstart={handleDragStart}
  ondragover={handleDragOver}
  ondrop={handleDrop}
  ondragleave={handleDragLeave}
  onpointerenter={() => popover.enter()}
  onpointerleave={() => popover.leave()}
  oncontextmenu={openContextMenu}
  {@attach captureRowElement}
>
  <!-- Stable drop indicator (assistant reorder) -->
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
    type="button"
    class="flex min-w-0 flex-1 items-center gap-1.5 text-left"
    aria-expanded={expanded}
    title={toggleTitle}
    onclick={() => onToggle(assistant)}
  >
    <!-- Assistant icon ↔ chevron swap on hover -->
    <span class="relative h-4 w-4 shrink-0">
      <span
        class="absolute inset-0 flex items-center justify-center transition-opacity duration-150 group-hover:opacity-0"
        aria-hidden="true"
      >
        {#if assistantIcon}
          <img src={assistantIcon} alt="" class="h-4 w-4 object-contain" draggable="false" />
        {:else}
          <AssistantDefaultIcon size={14} style="color: {color}" />
        {/if}
      </span>
      <span
        class="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-150 group-hover:opacity-100"
        aria-hidden="true"
      >
        <CioForward
          size={13}
          class="text-dimmed transition-transform duration-150 {expanded ? 'rotate-90' : ''}"
        />
      </span>
    </span>

    <span class="min-w-0 flex-1">
      <span class="flex items-center gap-1.5">
        {#if assistant.pinned}
          <CioPin size={11} class="shrink-0 text-accent" aria-hidden="true" />
        {/if}
        <span class="truncate text-[0.8125rem] text-foreground">{assistant.name}</span>
        <ThreadStateCounts counts={stateCounts} class="shrink-0" />
      </span>
      <span class="mt-0.5 flex items-center gap-1.5 text-[0.5625rem] text-dimmed">
        <span
          class="shrink-0 border border-border px-1.5 py-px text-[0.5rem] tracking-wide uppercase {scheduled
            ? 'bg-elevated text-dimmed'
            : 'bg-elevated text-accent'}"
          title={scheduled
            ? 'This assistant runs on a schedule'
            : 'This assistant runs only when you ask it to'}
        >
          {scheduled ? 'Scheduled' : 'Unscheduled'}
        </span>
        <span class="shrink-0">{assistantRunCountLabel(runCount)}</span>
        {#if nextRunLabel}
          <span class="shrink-0" aria-hidden="true">·</span>
          <span class="truncate">{nextRunLabel}</span>
        {/if}
        {#if assistant.paused}
          <span
            class="flex shrink-0 items-center"
            style="color: var(--color-warning)"
            role="img"
            aria-label="This assistant is paused"
            title="Paused: this assistant does not run until you resume it"
          >
            <CioPause size={11} />
          </span>
        {/if}
        {#if incomplete}
          <span
            class="flex shrink-0 items-center"
            style="color: var(--color-warning)"
            role="img"
            aria-label={gapLabel}
            title={gapLabel}
          >
            <CioAttention size={11} />
          </span>
        {/if}
        {#if missed}
          <span
            class="flex shrink-0 items-center"
            style="color: var(--color-missed)"
            role="img"
            aria-label="A scheduled run was missed"
            title="A scheduled run was missed"
          >
            <CioAttention size={11} />
          </span>
        {/if}
      </span>
    </span>
  </button>

  <!-- Hover actions float over the row (opaque `elevated`, matching the row's
       hover surface) instead of reserving space, so the title truncates at the
       full row width and only gets covered while the actions are visible. -->
  <span
    class="pointer-events-none absolute inset-y-1 right-1.5 z-10 flex items-center gap-0.5 bg-elevated px-0.5 opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
  >
    <SidebarSearchControl
      open={searchOpen}
      query={searchQuery}
      onOpenChange={(open) => onSearchOpenChange(assistant, open)}
      onQueryChange={(value) => onSearchQueryChange(assistant, value)}
      ariaLabel="Search tasks in {assistant.name}"
      title="Search tasks"
      placeholder="Search tasks in {assistant.name}…"
    />
    <button
      type="button"
      class="flex h-5 w-5 items-center justify-center text-dimmed transition-colors hover:bg-overlay hover:text-foreground"
      aria-label="New task in {assistant.name}"
      title="New task"
      onclick={() => onCreateTask(assistant)}
    >
      <CioPlus size={12} />
    </button>
    <DropdownMenu.Root bind:open={menuOpen} onOpenChange={onMenuOpenChange}>
      <DropdownMenu.Trigger
        class="flex h-5 w-5 items-center justify-center text-dimmed transition-colors hover:bg-overlay hover:text-foreground data-[state=open]:bg-elevated data-[state=open]:text-foreground"
        aria-label="Options for {assistant.name}"
        title="Assistant options"
        oncontextmenu={(event: MouseEvent) => event.preventDefault()}
      >
        <CioEllipsis size={12} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="bottom"
          align="end"
          sideOffset={4}
          collisionPadding={8}
          class="z-50 w-48 overflow-hidden border bg-surface p-1 shadow-lg"
        >
          <DropdownMenu.Item
            class="flex w-full items-center gap-2 px-2.5 py-2 text-sm text-foreground outline-none transition-colors hover:bg-elevated focus:bg-elevated"
            onSelect={() => onOpenKnowledge(assistant)}
          >
            <AssistantIcon mark="knowledge" size={14} class="text-muted" />
            What it knows
          </DropdownMenu.Item>
          <DropdownMenu.Item
            class="flex w-full items-center gap-2 px-2.5 py-2 text-sm text-foreground outline-none transition-colors hover:bg-elevated focus:bg-elevated"
            onSelect={() => onEdit(assistant)}
          >
            <CioPencil size={14} class="text-muted" />
            Edit assistant
          </DropdownMenu.Item>
          <DropdownMenu.Separator class="mx-2 my-1 h-px bg-border" />
          {#if scheduled}
            <DropdownMenu.Item
              class="flex w-full items-center gap-2 px-2.5 py-2 text-sm text-foreground outline-none transition-colors hover:bg-elevated focus:bg-elevated"
              onSelect={() => (skipConfirm = 'next')}
            >
              <CioSkipForward size={14} class="text-muted" />
              Skip next run
            </DropdownMenu.Item>
            {#if hasRunsToday}
              <DropdownMenu.Item
                class="flex w-full items-center gap-2 px-2.5 py-2 text-sm text-foreground outline-none transition-colors hover:bg-elevated focus:bg-elevated"
                onSelect={() => (skipConfirm = 'today')}
              >
                <CioCalendar size={14} class="text-muted" />
                Skip runs for today
              </DropdownMenu.Item>
            {/if}
          {/if}
          <DropdownMenu.Item
            class="flex w-full items-center gap-2 px-2.5 py-2 text-sm text-foreground outline-none transition-colors hover:bg-elevated focus:bg-elevated"
            onSelect={() => onTogglePin(assistant)}
          >
            {#if assistant.pinned}
              <CioPinOff size={14} class="text-muted" />
              Unpin Assistant
            {:else}
              <CioPin size={14} class="text-muted" />
              Pin Assistant
            {/if}
          </DropdownMenu.Item>
          <DropdownMenu.Separator class="mx-2 my-1 h-px bg-border" />
          <DropdownMenu.Item
            class="flex w-full items-center gap-2 px-2.5 py-2 text-sm text-danger outline-none transition-colors hover:bg-danger/10 focus:bg-danger/10"
            onSelect={() => onDelete(assistant)}
          >
            <CioTrash size={14} />
            Remove Assistant
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  </span>
</div>

<ConfirmDialog
  open={skipConfirm !== null}
  title={skipDialogTitle}
  confirmLabel={skipConfirmLabel}
  busy={skipBusy}
  variant="primary"
  onCancel={() => (skipConfirm = null)}
  onConfirm={confirmSkip}
>
  {#if skipConfirm === 'today'}
    <p>
      Skip all remaining scheduled runs for <strong class="text-foreground">{assistant.name}</strong
      >
      today? The assistant will resume at its next scheduled time after today.
    </p>
  {:else}
    <p>
      Skip the closest scheduled run for <strong class="text-foreground">{assistant.name}</strong>?
      The next run after that will stay scheduled.
    </p>
  {/if}
</ConfirmDialog>

{#if popover.visible}
  <Portal>
    <div
      {@attach capturePopoverElement}
      class={THREAD_HOVER_POPOVER_SURFACE_CLASS}
      style={threadHoverPopoverStyle(popover.position.x, popover.position.y)}
    >
      <AssistantHoverPopover {assistant} {runCount} {working} {missed} {nextRunAt} {attention} />
    </div>
  </Portal>
{/if}
