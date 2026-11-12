<script lang="ts">
  import MediaActivityTrail from '$lib/components/speech/MediaActivityTrail.svelte'
  import type { MediaActivity } from '$shared/media-activity'
  import CioAttention from '@pdslng/cio-icon/CioAttention.svelte'
  import CioPause from '@pdslng/cio-icon/CioPause.svelte'
  import CioPin from '@pdslng/cio-icon/CioPin.svelte'
  import { Portal } from 'bits-ui'
  import ThreadStateCounts from '$lib/components/shared/ThreadStateCounts.svelte'
  import { type ThreadStateCounts as ThreadStateCountsValue } from '$lib/thread-state-counts'
  import { AssistantDefaultIcon, getAssistantIcon } from '$lib/assistant-icons'
  import { assistantGap } from './assistant-view'
  import type { Assistant } from '$shared/types'
  import { formatCompactAge } from '$shared/date-time-format'
  import { relativeTimeClock } from '$lib/relative-time.svelte'
  import {
    THREAD_HOVER_POPOVER_SURFACE_CLASS,
    threadHoverPopoverStyle
  } from '$lib/components/shared/thread-hover-popover-layout'
  import { createThreadHoverPopover } from '$lib/components/shared/thread-hover-popover.svelte'
  import AssistantHoverPopover from './AssistantHoverPopover.svelte'
  import AssistantOptionsMenu from './AssistantOptionsMenu.svelte'

  /**
   * One assistant in the assistant view's sidebar.
   *
   * The row is a place, not a container: it names the assistant, the last thing
   * said in its most recent conversation, and when that was. Its threads are the
   * header's tabs, so nothing here opens, nests or manages them. The only controls
   * are the ones a list row needs   the row itself opens the assistant, a drag
   * reorders or receives a task, and the context menu is gone with the threads.
   */
  interface Props {
    media?: readonly MediaActivity[]
    assistant: Assistant
    /**
     * How this assistant's threads break down   its tasks and their runs   by
     * working, attention, and error, so a row summarizes its work the same way a
     * project row does.
     */
    stateCounts: ThreadStateCountsValue
    /** At least one task or run needs the user: parked on a card, failed, or
     *  waiting on a provider retry. */
    attention: boolean
    /** Any task carries a pending missed run. */
    missed: boolean
    /** How many threads this assistant holds: its tasks and their runs. */
    threadCount: number
    /** Custom icon data URL for this assistant, when it stores one. */
    iconUrl?: string | null
    /** Next intended fire for the assistant, or null when unscheduled. */
    nextRunAt: number | null
    /** The last line of this assistant's most recent conversation. */
    preview?: string | null
    /** When that conversation last moved, so the row says how long it has been. */
    lastWorkedAt?: number | null
    /** The open thread belongs to this assistant. */
    selected: boolean
    /** Open this assistant: its latest thread, or its setup when it has none. */
    onOpen: (assistant: Assistant) => void
    /** Drag-to-reorder assistants; position is relative to this row. */
    onMoveAssistant: (draggedId: string, targetId: string, position: 'before' | 'after') => void
    /** A task (thread) drag was dropped onto this assistant. */
    onDropTask: (taskId: string, assistantId: string) => void
  }

  let {
    assistant,
    media = [],
    stateCounts,
    attention,
    missed,
    threadCount,
    iconUrl = null,
    nextRunAt,
    preview = null,
    lastWorkedAt = null,
    selected,
    onOpen,
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
  const gapLabel = $derived(assistantGap(assistant) ?? '')
  const lastWorkedLabel = $derived(
    lastWorkedAt ? formatCompactAge(lastWorkedAt, relativeTimeClock.now) : ''
  )

  let dropIndicator = $state<'before' | 'after' | null>(null)
  let taskDropActive = $state(false)
  /** The assistant's menu, opened by right-clicking the row. */
  let menuOpen = $state(false)

  // ─── Hover popover ───────────────────────────────────────────────────────
  /** The assistant's info popover, shared with every surface that shows one. */
  const popover = createThreadHoverPopover({ isBlocked: () => menuOpen })

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

  /**
   * Right-click anywhere on the row opens the assistant's own menu   the same one
   * the header opens from its mark   so an assistant is configurable from the
   * place that lists it, not only from the thread strip.
   */
  function openContextMenu(event: MouseEvent): void {
    event.preventDefault()
    popover.hide()
    menuOpen = true
  }

  $effect(() => relativeTimeClock.hold())
</script>

<div
  class="group relative mb-0.5 flex items-center px-1.5 py-2 transition-colors {selected
    ? 'bg-selected'
    : taskDropActive
      ? 'bg-primary/10'
      : 'hover:bg-elevated'}"
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
    class="flex min-w-0 flex-1 items-center gap-2 text-left"
    title="Open {assistant.name}"
    aria-current={selected ? 'page' : undefined}
    onclick={() => onOpen(assistant)}
  >
    <span class="relative flex size-8 shrink-0 items-center justify-center">
      {#if assistantIcon}
        <img src={assistantIcon} alt="" class="size-7 object-contain" draggable="false" />
      {:else}
        <AssistantDefaultIcon size={28} style="color: {color}" />
      {/if}
      <!-- The row's state cluster rides the icon's bottom centre instead of the
           name line: the name keeps its width, and the indicator reads as part of
           the assistant it belongs to. -->
      <span
        class="pointer-events-none absolute bottom-0 left-1/2 flex -translate-x-1/2 translate-y-1/3 items-center justify-center bg-elevated px-0.5"
      >
        <ThreadStateCounts counts={stateCounts} />
      </span>
    </span>

    <span class="min-w-0 flex-1">
      <span class="flex items-center gap-1.5">
        {#if assistant.pinned}
          <CioPin size={11} class="shrink-0 text-accent" aria-hidden="true" />
        {/if}
        <span class="min-w-0 truncate text-sm font-medium text-foreground">{assistant.name}</span>
        <MediaActivityTrail activities={media} label={assistant.name} />
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
        {#if lastWorkedLabel}
          <span class="ml-auto shrink-0 text-[0.625rem] tabular-nums text-dimmed"
            >{lastWorkedLabel}</span
          >
        {/if}
      </span>
      <span class="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted">
        <span class="truncate" title={preview ?? undefined}>
          {preview ?? 'No conversation yet'}
        </span>
      </span>
    </span>
  </button>

  <!-- Right-click opens the same assistant menu the header's mark does; the
       trigger is an invisible anchor, so the row keeps its flat shape. -->
  <AssistantOptionsMenu {assistant} bind:open={menuOpen} anchorOnly />
</div>

{#if popover.visible}
  <Portal>
    <div
      {@attach capturePopoverElement}
      class={THREAD_HOVER_POPOVER_SURFACE_CLASS}
      style={threadHoverPopoverStyle(popover.position.x, popover.position.y)}
    >
      <AssistantHoverPopover {assistant} {threadCount} {working} {missed} {nextRunAt} {attention} />
    </div>
  </Portal>
{/if}
