<script lang="ts">
  import { tick } from 'svelte'
  import { Toolbox } from '@lucide/svelte'
  import Switch from '../ui/Switch.svelte'
  import type {
    EngineeringLifecycleSelection,
    EngineeringLifecycleStage,
    EngineeringLifecycleState
  } from '$shared/types'

  interface Props {
    lifecycleState: EngineeringLifecycleState | null
    disabled?: boolean
    onselect: (selection: EngineeringLifecycleSelection) => void | Promise<void>
    onretry?: () => void | Promise<void>
  }

  let { lifecycleState, disabled = false, onselect, onretry }: Props = $props()
  let open = $state(false)
  let panel: HTMLDivElement | undefined = $state(undefined)

  const rows: ReadonlyArray<{
    stage: EngineeringLifecycleStage
    label: string
    description: string
  }> = [
    { stage: 'brainstorm', label: 'Brainstorm', description: 'Research and align the direction.' },
    { stage: 'prd', label: 'PRD', description: 'Define product requirements and outcomes.' },
    { stage: 'spec', label: 'Spec', description: 'Create an implementation-ready contract.' },
    { stage: 'assignment', label: 'Assignment', description: 'Plan and dispatch approved work.' },
    { stage: 'achievement', label: 'Achievement', description: 'Audit and rework until complete.' }
  ]

  const selection = $derived(lifecycleState?.selection ?? 'none')
  const filled = $derived(selection !== 'none' || lifecycleState?.startedAt !== undefined)

  function checked(stage: EngineeringLifecycleStage): boolean {
    return selection === 'run_all' || selection === stage
  }

  async function choose(stage: EngineeringLifecycleStage, enabled: boolean): Promise<void> {
    if (selection === 'run_all') return
    await onselect(enabled ? stage : 'none')
  }

  async function chooseRunAll(enabled: boolean): Promise<void> {
    await onselect(enabled ? 'run_all' : 'none')
  }

  async function focusFirstSwitch(): Promise<void> {
    await tick()
    panel?.querySelector<HTMLButtonElement>('button[role="switch"]:not(:disabled)')?.focus()
  }

  export async function openAndFocus(): Promise<void> {
    if (disabled) return
    open = true
    await focusFirstSwitch()
  }

  async function toggle(): Promise<void> {
    open = !open
    if (open) await focusFirstSwitch()
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return
    event.preventDefault()
    open = false
  }
</script>

<div class="relative">
  <button
    type="button"
    class="flex h-7 w-7 items-center justify-center rounded-lg transition-colors {filled
      ? 'bg-thread-spec text-foreground'
      : 'text-muted hover:bg-elevated hover:text-foreground'}"
    title="Engineering Toolbox"
    aria-label="Open Engineering Toolbox"
    aria-haspopup="menu"
    aria-expanded={open}
    {disabled}
    onclick={() => void toggle()}
  >
    <Toolbox size={15} />
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
          Choose one stage or run the full lifecycle.
        </p>
      </div>
      {#each rows as row (row.stage)}
        <Switch
          checked={checked(row.stage)}
          disabled={disabled || selection === 'run_all'}
          onchange={(enabled) => void choose(row.stage, enabled)}
          title={`${checked(row.stage) ? 'Turn off' : 'Turn on'} ${row.label}`}
          aria-label={`${checked(row.stage) ? 'Turn off' : 'Turn on'} ${row.label}`}
          class="w-full items-start justify-between rounded-lg px-2.5 py-2 transition-colors hover:bg-elevated"
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
        checked={selection === 'run_all'}
        {disabled}
        onchange={(enabled) => void chooseRunAll(enabled)}
        title={selection === 'run_all' ? 'Turn off Run all' : 'Turn on Run all'}
        aria-label={selection === 'run_all' ? 'Turn off Run all' : 'Turn on Run all'}
        class="w-full items-start justify-between rounded-lg px-2.5 py-2 transition-colors hover:bg-elevated"
        activeClass="bg-thread-spec"
      >
        <span class="min-w-0 flex-1 pr-3">
          <span class="block text-xs font-medium text-foreground">Run all</span>
          <span class="mt-0.5 block text-[11px] leading-4 text-muted">
            Brainstorm through Achievement, with review gates.
          </span>
        </span>
      </Switch>
      {#if lifecycleState?.humanGate === 'terminal_failure'}
        <div class="mx-2 mt-2 rounded-lg border border-danger/30 bg-danger/5 p-2.5">
          <p class="text-[11px] font-medium text-danger">Engineering needs attention</p>
          <p class="mt-1 line-clamp-3 text-[11px] leading-4 text-muted">
            {lifecycleState.failure ?? 'The active stage could not complete.'}
          </p>
          <div class="mt-2 flex justify-end gap-2">
            <button
              type="button"
              class="rounded-lg px-2.5 py-1.5 text-[11px] text-muted transition-colors hover:bg-elevated hover:text-foreground"
              onclick={() => void onselect('none')}
            >
              Stop
            </button>
            <button
              type="button"
              class="rounded-lg bg-thread-spec px-2.5 py-1.5 text-[11px] font-medium text-foreground disabled:opacity-50"
              disabled={!onretry}
              onclick={() => void onretry?.()}
            >
              Retry stage
            </button>
          </div>
        </div>
      {/if}
    </div>
  {/if}
</div>
