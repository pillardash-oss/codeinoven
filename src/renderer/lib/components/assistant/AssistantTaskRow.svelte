<script lang="ts">
  import { AlertTriangle, BotMessageSquare } from '@lucide/svelte'
  import { createSubscriber } from 'svelte/reactivity'
  import StatusBadge from '$lib/components/shared/StatusBadge.svelte'
  import { getIconSvgDataUrl } from '$lib/project-svg-icons'
  import { threadStatusPolicy } from '$shared/thread-status-policy'
  import type { Thread } from '$shared/types'
  import { taskRunLine } from './assistant-view'

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
  }

  let { task, active, color, missed, nextRunAt, scheduleLabel = null, onSelect }: Props = $props()

  const TASK_DRAG_TYPE = 'application/x-assistant-task'

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
  }
</script>

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
  onclick={() => onSelect(task)}
>
  <span class="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
    {#if taskIcon}
      <img src={taskIcon} alt="" class="h-4 w-4 object-contain" draggable="false" />
    {:else}
      <BotMessageSquare size={14} strokeWidth={1.8} style="color: {color ?? 'var(--color-muted)'}" />
    {/if}
  </span>

  <span class="min-w-0 flex-1">
    <span class="flex items-center gap-1.5">
      <span class="truncate text-[0.75rem] leading-tight {active ? 'text-foreground' : 'text-muted'}">
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
</button>
