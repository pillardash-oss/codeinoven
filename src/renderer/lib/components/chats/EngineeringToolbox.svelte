<script lang="ts">
  import { tick } from 'svelte'
  import { Toolbox } from '@lucide/svelte'
  import Switch from '../ui/Switch.svelte'
  import { hasSelectedStage } from '$shared/engines/engineering-lifecycle-engine'
  import type { EngineeringLifecycleState } from '$shared/types'
  import type { EngineeringLifecycleSelectionInput, EngineeringLifecycleStage } from '$shared/types'

  interface Props {
    lifecycleState: EngineeringLifecycleState | null
    /** Whether any Engineering lifecycle stage is active for the thread —
     *  either staged (intent-only) or persisted via an inherited selection. */
    active?: boolean
    disabled?: boolean
    onselect: (input: EngineeringLifecycleSelectionInput) => void | Promise<void>
  }

  let { lifecycleState, active = false, disabled = false, onselect }: Props = $props()
  let open = $state(false)
  let panel: HTMLDivElement | undefined = $state(undefined)
  /** Index into [rows, autopilot] currently outlined by arrow-key navigation —
   *  -1 when the toolbox was opened via pointer (mouse-driven highlighting). */
  let highlightIndex = $state(-1)

  const rows: ReadonlyArray<{
    stage: EngineeringLifecycleStage
    label: string
    description: string
  }> = [
    {
      stage: 'brainstorm',
      label: 'Brainstorm',
      description: 'Research, prototype and align your vision.'
    },
    {
      stage: 'prd',
      label: 'PRD',
      description: 'Define product requirements, usecase and outcomes.'
    },
    { stage: 'spec', label: 'Spec', description: 'Create an implementation-ready contract.' },
    {
      stage: 'assignment',
      label: 'Assignment',
      description: 'Breakup your tasks & assign to worker agents.'
    },
    {
      stage: 'achievement',
      label: 'Achievement',
      description: 'Spec, Implement, Audit and rework until complete.'
    }
  ]

  const autopilot = $derived(lifecycleState?.autopilot === true)

  /** Total navigable rows: the lifecycle stages plus the trailing Auto Pilot row. */
  const rowCount = rows.length + 1
  const filled = $derived(
    active ||
      (lifecycleState?.selection ?? 'none') !== 'none' ||
      lifecycleState?.startedAt !== undefined
  )

  async function choose(stage: EngineeringLifecycleStage, enabled: boolean): Promise<void> {
    if (autopilot) return
    const current: EngineeringLifecycleStage[] = lifecycleState?.selectedStages ?? []
    const next = enabled ? [...current, stage] : current.filter((candidate) => candidate !== stage)
    await onselect({ stages: next, autopilot: false })
  }

  async function chooseAutopilot(enabled: boolean): Promise<void> {
    const nextSet = enabled ? [] : (lifecycleState?.selectedStages ?? [])
    await onselect({ stages: nextSet, autopilot: enabled })
  }

  async function focusPanel(): Promise<void> {
    await tick()
    panel?.focus()
  }

  /** Shortcut entry point — toggles visibility and starts arrow-key navigation. */
  export async function openAndFocus(): Promise<void> {
    if (disabled) return
    open = !open
    if (!open) {
      highlightIndex = -1
      return
    }
    highlightIndex = 0
    await focusPanel()
  }

  async function toggle(): Promise<void> {
    open = !open
    highlightIndex = -1
  }

  function moveHighlight(direction: 1 | -1): void {
    highlightIndex =
      (highlightIndex < 0 ? 0 : highlightIndex + direction + rowCount) % rowCount
  }

  function handleKeydown(event: KeyboardEvent): void {
    // Cmd/Ctrl+E is the toolbox toggle — the panel owns focus while open, so
    // the composer shortcut can't fire; handle closing here instead.
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'e') {
      event.preventDefault()
      open = false
      highlightIndex = -1
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      open = false
      highlightIndex = -1
      return
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      moveHighlight(1)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      moveHighlight(-1)
      return
    }
    if (event.key === 'Enter' && highlightIndex >= 0) {
      event.preventDefault()
      if (highlightIndex < rows.length) {
        const row = rows[highlightIndex]
        void choose(row.stage, !hasSelectedStage(lifecycleState, row.stage))
      } else {
        void chooseAutopilot(!autopilot)
      }
    }
  }
</script>

<div class="relative">
  <button
    type="button"
    class="flex h-7 w-7 items-center justify-center rounded-lg transition-colors {filled
      ? 'text-thread-spec'
      : 'text-muted hover:bg-elevated hover:text-foreground'}"
    title="Engineering Toolbox"
    aria-label="Open Engineering Toolbox"
    aria-haspopup="menu"
    aria-expanded={open}
    {disabled}
    onclick={() => void toggle()}
  >
    <Toolbox
      size={15}
      class={filled ? 'text-thread-spec' : ''}
      fill={filled ? 'var(--color-thread-spec)' : 'none'}
      fill-opacity={filled ? 0.18 : undefined}
    />
  </button>

  {#if open}
    <button
      type="button"
      class="fixed inset-0 z-30 cursor-default"
      aria-label="Close Engineering Toolbox"
      onclick={() => (open = false)}
    ></button>
    <div
      bind:this={panel}
      class="fixed inset-x-3 bottom-3 z-40 rounded-2xl border bg-surface p-2 shadow-lg sm:absolute sm:inset-x-auto sm:bottom-9 sm:left-0 sm:w-80 sm:rounded-xl"
      role="menu"
      tabindex="-1"
      aria-label="Engineering lifecycle"
      onkeydown={handleKeydown}
    >
      <div class="px-2.5 pb-2 pt-1">
        <p class="text-xs font-semibold text-foreground">Engineering Toolbox</p>
        <p class="mt-0.5 text-[11px] leading-4 text-muted">
          Select the stages to run. Assignment and Achievement run after an approved Spec.
        </p>
      </div>
      {#each rows as row, i (row.stage)}
        <Switch
          checked={hasSelectedStage(lifecycleState, row.stage)}
          disabled={disabled || autopilot}
          onchange={(enabled) => void choose(row.stage, enabled)}
          title={`${hasSelectedStage(lifecycleState, row.stage) ? 'Turn off' : 'Turn on'} ${row.label}`}
          aria-label={`${hasSelectedStage(lifecycleState, row.stage) ? 'Turn off' : 'Turn on'} ${row.label}`}
          class="w-full items-start justify-between rounded-lg px-2.5 py-2 transition-colors hover:bg-elevated {highlightIndex ===
          i
            ? 'outline-2 outline-primary'
            : ''}"
          activeClass="bg-thread-spec"
        >
          <span class="min-w-0 flex-1 pr-3">
            <span class="block text-xs font-medium text-foreground">{row.label}</span>
            <span class="mt-0.5 block text-[11px] leading-4 text-muted">{row.description}</span>
          </span>
        </Switch>
      {/each}
      <div class="mx-2 my-1 border-t"></div>
      <Switch
        checked={autopilot}
        {disabled}
        onchange={(enabled) => void chooseAutopilot(enabled)}
        title={autopilot ? 'Turn off Auto Pilot' : 'Turn on Auto Pilot'}
        aria-label={autopilot ? 'Turn off Auto Pilot' : 'Turn on Auto Pilot'}
        class="w-full items-start justify-between rounded-lg px-2.5 py-2 transition-colors hover:bg-elevated {highlightIndex ===
        rows.length
          ? 'outline-2 outline-primary'
          : ''}"
        activeClass="bg-thread-spec"
      >
        <span class="min-w-0 flex-1 pr-3">
          <span class="block text-xs font-medium text-foreground">Auto Pilot</span>
          <span class="mt-0.5 block text-[11px] leading-4 text-muted">
            Brainstorm through Achievement on full autonomy, reworking until complete.
          </span>
        </span>
      </Switch>
    </div>
  {/if}
</div>
