<script lang="ts">
  import {
    AlertTriangle,
    ChevronRight,
    Ellipsis,
    Hammer,
    Pause,
    Pencil,
    Pin,
    PinOff,
    Plus,
    Trash2
  } from '@lucide/svelte'
  import { DropdownMenu, Portal } from 'bits-ui'
  import SidebarSearchControl from '$lib/components/workspace/SidebarSearchControl.svelte'
  import { RoutineDefaultIcon, getRoutineIcon } from '$lib/routine-icons'
  import type { Routine } from '$shared/types'
  import { routineGap } from './assistant-view'
  import {
    THREAD_HOVER_POPOVER_SURFACE_CLASS,
    calculateThreadHoverPopoverPosition,
    resolveThreadHoverPopoverSize,
    threadHoverPopoverStyle
  } from '$lib/components/shared/thread-hover-popover-layout'
  import { tick } from 'svelte'
  import AssistantRoutineHoverPopover from './AssistantRoutineHoverPopover.svelte'

  interface Props {
    routine: Routine
    expanded: boolean
    /** True while any task in the routine is running. */
    working: boolean
    /** Any task carries a pending missed run. */
    missed: boolean
    /** How many times this routine has run: one row per execution. The routine's
     *  Getting started host is not an execution, so it is never counted here. */
    runCount: number
    /** Custom icon data URL for this routine, when it stores one. */
    iconUrl?: string | null
    /** Next intended fire for the routine, or null when unscheduled. */
    nextRunAt: number | null
    /** Inline routine-search state, driven from the sidebar. */
    searchOpen: boolean
    searchQuery: string
    onToggle: (routine: Routine) => void
    onSearchOpenChange: (routine: Routine, open: boolean) => void
    onSearchQueryChange: (routine: Routine, value: string) => void
    onCreateTask: (routine: Routine) => void
    onOpenHowTo: (routine: Routine) => void
    onEdit: (routine: Routine) => void
    onTogglePin: (routine: Routine) => void
    onDelete: (routine: Routine) => void
    /** Drag-to-reorder routines; position is relative to this row. */
    onMoveRoutine: (draggedId: string, targetId: string, position: 'before' | 'after') => void
    /** A task (thread) drag was dropped onto this routine. */
    onDropTask: (taskId: string, routineId: string) => void
  }

  let {
    routine,
    expanded,
    working,
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
    onOpenHowTo,
    onEdit,
    onTogglePin,
    onDelete,
    onMoveRoutine,
    onDropTask
  }: Props = $props()

  const TASK_DRAG_TYPE = 'application/x-assistant-task'

  const color = $derived(routine.color ?? 'var(--color-muted)')
  // Custom image wins, then the SVG icon type tinted with the routine colour;
  // without either the row draws the routine default mark.
  const routineIcon = $derived(getRoutineIcon(routine, iconUrl))
  const incomplete = $derived(routineGap(routine) !== null)
  const gapLabel = $derived(routineGap(routine) ?? '')
  const toggleTitle = $derived(`${expanded ? 'Collapse' : 'Expand'} routine: ${routine.name}`)

  let menuOpen = $state(false)
  let dropIndicator = $state<'before' | 'after' | null>(null)
  let taskDropActive = $state(false)

  // ─── Hover popover ───────────────────────────────────────────────────────
  let rowEl: HTMLElement | undefined = $state(undefined)
  let popoverEl: HTMLElement | undefined = $state(undefined)
  let hovered = $state(false)
  let showPopover = $state(false)
  let popoverTimer: ReturnType<typeof setTimeout> | undefined
  let popoverPos = $state({ x: 0, y: 0 })

  async function revealPopover(): Promise<void> {
    if (!rowEl || menuOpen || !hovered) return
    const size = resolveThreadHoverPopoverSize()
    popoverPos = calculateThreadHoverPopoverPosition(
      rowEl.getBoundingClientRect(),
      size.width,
      size.height
    )
    showPopover = true
    await tick()
    if (!rowEl || !popoverEl || menuOpen || !hovered) return
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

  function openContextMenu(event: MouseEvent): void {
    event.preventDefault()
    showPopover = false
    clearTimeout(popoverTimer)
    menuOpen = true
  }

  function capturePopoverElement(element: HTMLElement): void {
    popoverEl = element
  }

  // ─── Drag & drop ───────────────────────────────────────────────────────
  function setDragImage(event: DragEvent, label: string): void {
    const ghost = document.createElement('div')
    ghost.textContent = label
    ghost.style.cssText =
      'position:absolute;top:-1000px;left:-1000px;padding:3px 8px;background:var(--color-surface);border:1px solid var(--color-border);border-radius:6px;font-size:13px;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,0.15)'
    document.body.appendChild(ghost)
    event.dataTransfer?.setDragImage(ghost, 0, 0)
    requestAnimationFrame(() => document.body.removeChild(ghost))
  }

  function handleDragStart(event: DragEvent): void {
    if (!event.dataTransfer) return
    event.dataTransfer.setData('text/plain', routine.id)
    event.dataTransfer.effectAllowed = 'move'
    setDragImage(event, routine.name)
    showPopover = false
    clearTimeout(popoverTimer)
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
      onDropTask(taskId, routine.id)
      taskDropActive = false
      return
    }
    const draggedId = event.dataTransfer?.getData('text/plain')
    if (draggedId && draggedId !== routine.id) {
      onMoveRoutine(draggedId, routine.id, dropIndicator ?? 'after')
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
  style="border-color: {routine.color ?? 'var(--color-border-strong)'}"
  role="listitem"
  draggable="true"
  ondragstart={handleDragStart}
  ondragover={handleDragOver}
  ondrop={handleDrop}
  ondragleave={handleDragLeave}
  onpointerenter={onRowEnter}
  onpointerleave={onRowLeave}
  oncontextmenu={openContextMenu}
  bind:this={rowEl}
>
  <!-- Stable drop indicator (routine reorder) -->
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
    onclick={() => onToggle(routine)}
  >
    <!-- Routine icon ↔ chevron swap on hover -->
    <span class="relative h-4 w-4 shrink-0">
      <span
        class="absolute inset-0 flex items-center justify-center transition-opacity duration-150 group-hover:opacity-0"
        aria-hidden="true"
      >
        {#if routineIcon}
          <img src={routineIcon} alt="" class="h-4 w-4 object-contain" draggable="false" />
        {:else}
          <RoutineDefaultIcon size={14} strokeWidth={1.8} style="color: {color}" />
        {/if}
      </span>
      <span
        class="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-150 group-hover:opacity-100"
        aria-hidden="true"
      >
        <ChevronRight
          size={13}
          class="text-dimmed transition-transform duration-150 {expanded ? 'rotate-90' : ''}"
        />
      </span>
    </span>

    <span class="min-w-0 flex-1">
      <span class="flex items-center gap-1.5">
        {#if routine.pinned}
          <Pin size={11} class="shrink-0 text-accent" aria-hidden="true" />
        {/if}
        <span class="truncate text-[0.8125rem] text-foreground">{routine.name}</span>
      </span>
      <span class="mt-0.5 flex items-center gap-1.5 text-[0.5625rem] text-dimmed">
        <span class="truncate">{runCount === 1 ? '1 run' : `${runCount} runs`}</span>
        {#if routine.paused}
          <span
            class="flex shrink-0 items-center"
            style="color: var(--color-warning)"
            role="img"
            aria-label="This routine is paused"
            title="Paused: this routine does not run until you resume it"
          >
            <Pause size={11} />
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
            <AlertTriangle size={11} />
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
            <AlertTriangle size={11} />
          </span>
        {/if}
      </span>
    </span>
  </button>

  <!-- Hover actions float over the row (opaque `elevated`, matching the row's
       hover surface) instead of reserving space, so the title truncates at the
       full row width and only gets covered while the actions are visible. -->
  <span
    class="pointer-events-none absolute inset-y-1 right-1.5 z-10 flex items-center gap-0.5 rounded-md bg-elevated px-0.5 opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100"
  >
    <SidebarSearchControl
      open={searchOpen}
      query={searchQuery}
      onOpenChange={(open) => onSearchOpenChange(routine, open)}
      onQueryChange={(value) => onSearchQueryChange(routine, value)}
      ariaLabel="Search tasks in {routine.name}"
      title="Search tasks"
      placeholder="Search tasks in {routine.name}…"
    />
    <button
      type="button"
      class="flex h-5 w-5 items-center justify-center rounded text-dimmed transition-colors hover:bg-overlay hover:text-foreground"
      aria-label="New task in {routine.name}"
      title="New task"
      onclick={() => onCreateTask(routine)}
    >
      <Plus size={12} />
    </button>
    <DropdownMenu.Root bind:open={menuOpen}>
      <DropdownMenu.Trigger
        class="flex h-5 w-5 items-center justify-center rounded text-dimmed transition-colors hover:bg-overlay hover:text-foreground data-[state=open]:bg-elevated data-[state=open]:text-foreground"
        aria-label="Options for {routine.name}"
        title="Routine options"
        oncontextmenu={(event: MouseEvent) => event.preventDefault()}
      >
        <Ellipsis size={12} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="bottom"
          align="end"
          sideOffset={4}
          collisionPadding={8}
          class="z-50 w-48 overflow-hidden rounded-xl border bg-surface p-1 shadow-lg"
        >
          <DropdownMenu.Item
            class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-foreground outline-none transition-colors hover:bg-elevated focus:bg-elevated"
            onSelect={() => onOpenHowTo(routine)}
          >
            <Hammer size={14} class="text-muted" />
            How to
          </DropdownMenu.Item>
          <DropdownMenu.Item
            class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-foreground outline-none transition-colors hover:bg-elevated focus:bg-elevated"
            onSelect={() => onEdit(routine)}
          >
            <Pencil size={14} class="text-muted" />
            Edit routine
          </DropdownMenu.Item>
          <DropdownMenu.Item
            class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-foreground outline-none transition-colors hover:bg-elevated focus:bg-elevated"
            onSelect={() => onTogglePin(routine)}
          >
            {#if routine.pinned}
              <PinOff size={14} class="text-muted" />
              Unpin Routine
            {:else}
              <Pin size={14} class="text-muted" />
              Pin Routine
            {/if}
          </DropdownMenu.Item>
          <DropdownMenu.Separator class="mx-2 my-1 h-px bg-border" />
          <DropdownMenu.Item
            class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-danger outline-none transition-colors hover:bg-danger/10 focus:bg-danger/10"
            onSelect={() => onDelete(routine)}
          >
            <Trash2 size={14} />
            Remove Routine
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  </span>
  {#if working}
    <span
      class="pointer-events-none flex h-5 w-5 shrink-0 items-center justify-center opacity-100 transition-opacity duration-150 group-hover:opacity-0 group-focus-within:opacity-0"
    >
      <span class="h-1.5 w-1.5 animate-pulse rounded-full" style="background: {color}"></span>
    </span>
  {/if}
</div>

{#if showPopover}
  <Portal>
    <div
      {@attach capturePopoverElement}
      class={THREAD_HOVER_POPOVER_SURFACE_CLASS}
      style={threadHoverPopoverStyle(popoverPos.x, popoverPos.y)}
    >
      <AssistantRoutineHoverPopover {routine} {runCount} {working} {missed} {nextRunAt} />
    </div>
  </Portal>
{/if}
