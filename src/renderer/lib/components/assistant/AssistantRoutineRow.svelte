<script lang="ts">
  import { ChevronRight, Workflow, PanelRightOpen } from '@lucide/svelte'
  import { getIconSvgDataUrl } from '$lib/project-svg-icons'
  import { routineHowToComplete, type Routine } from '$shared/types'

  interface Props {
    routine: Routine
    expanded: boolean
    active: boolean
    /** Any child task has a pending missed run. */
    missed: boolean
    taskCount: number
    onToggle: (routine: Routine) => void
    onOpenHowTo: (routine: Routine) => void
  }

  let { routine, expanded, active, missed, taskCount, onToggle, onOpenHowTo }: Props = $props()

  const color = $derived(routine.color ?? 'var(--color-muted)')
  const routineIcon = $derived(
    routine.iconType ? getIconSvgDataUrl(routine.iconType, routine.color ?? '#8b95a5') : null
  )
  const incomplete = $derived(!routineHowToComplete(routine))
  const toggleTitle = $derived(`${expanded ? 'Collapse' : 'Expand'} routine: ${routine.name}`)
</script>

<div
  class="group relative flex items-center gap-1 border-l-2 px-1.5 py-2 transition-colors {active
    ? 'bg-elevated/70'
    : 'hover:bg-elevated'}"
  style="border-color: {routine.color ?? 'var(--color-border-strong)'}"
  role="listitem"
>
  <button
    type="button"
    class="flex min-w-0 flex-1 items-center gap-1.5 text-left"
    aria-expanded={expanded}
    title={toggleTitle}
    aria-label={toggleTitle}
    onclick={() => onToggle(routine)}
  >
    <span class="relative h-4 w-4 shrink-0">
      <span class="absolute inset-0 flex items-center justify-center" aria-hidden="true">
        {#if routineIcon}
          <img src={routineIcon} alt="" class="h-4 w-4 object-contain" draggable="false" />
        {:else}
          <Workflow size={14} strokeWidth={1.8} style="color: {color}" />
        {/if}
      </span>
    </span>

    <span class="min-w-0 flex-1">
      <span class="flex items-center gap-1.5">
        <span class="truncate text-[0.8125rem] text-foreground">{routine.name}</span>
        <ChevronRight
          size={12}
          class="shrink-0 text-dimmed transition-transform {expanded ? 'rotate-90' : ''}"
        />
        {#if incomplete}
          <span
            class="shrink-0 rounded px-1 py-px text-[0.5625rem] font-medium"
            style="color: var(--color-warning); background: color-mix(in srgb, var(--color-warning) 16%, transparent)"
            title="This routine has no how-to yet"
            aria-label="This routine has no how-to yet"
          >
            Incomplete
          </span>
        {/if}
        {#if missed}
          <span
            class="shrink-0 rounded px-1 py-px text-[0.5625rem] font-medium"
            style="color: var(--color-missed); background: color-mix(in srgb, var(--color-missed) 16%, transparent)"
            title="A scheduled run was missed"
            aria-label="A scheduled run was missed"
          >
            Missed
          </span>
        {/if}
      </span>
      <span class="mt-0.5 block truncate text-[0.5625rem] text-dimmed">
        {taskCount === 1 ? '1 task' : `${taskCount} tasks`}
      </span>
    </span>
  </button>

  <button
    type="button"
    class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted opacity-0 transition-opacity group-hover:opacity-100 hover:bg-overlay hover:text-foreground focus-visible:opacity-100"
    title="Open how-to for {routine.name}"
    aria-label="Open how-to for {routine.name}"
    onclick={() => onOpenHowTo(routine)}
  >
    <PanelRightOpen size={14} strokeWidth={1.8} />
  </button>
</div>
