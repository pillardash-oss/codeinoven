<script lang="ts">
  import { Circle, CircleCheck, Loader2, TriangleAlert } from '@lucide/svelte'
  import DockableModal from '$lib/components/ui/DockableModal.svelte'
  import {
    scopeJobActiveStage,
    scopeJobStageLabel,
    type ScopeJob,
    type ScopeWorktreeStage
  } from '$lib/stores/scope-jobs.svelte'

  interface Props {
    job: ScopeJob
    storageKey: string
    onMinimize: () => void
    onExpand: () => void
    onClose: () => void
  }

  let { job, storageKey, onMinimize, onExpand, onClose }: Props = $props()

  const running = $derived(job.status === 'running')
  const done = $derived(job.status === 'succeeded')
  const failed = $derived(job.status === 'failed')
  /** Step the run is on right now, or the one it stopped on. */
  const active = $derived(scopeJobActiveStage(job))

  const heading = $derived(
    job.kind === 'agent'
      ? running
        ? `An agent is preparing “${job.title}”…`
        : done
          ? `“${job.title}” is ready`
          : `“${job.title}” could not be prepared`
      : job.kind === 'create'
        ? running
          ? `Creating “${job.title}”…`
          : done
            ? `“${job.title}” is ready`
            : `“${job.title}” could not be created`
        : running
          ? `Adopting a worktree for “${job.title}”…`
          : done
            ? `“${job.title}” has a worktree`
            : `“${job.title}” could not adopt the worktree`
  )

  /** Where one checklist step sits relative to the run. */
  function stateFor(step: ScopeWorktreeStage): 'complete' | 'active' | 'failed' | 'pending' {
    if (done) return 'complete'
    if (!active) return 'pending'
    const activeIndex = job.steps.indexOf(active)
    const index = job.steps.indexOf(step)
    if (index < activeIndex) return 'complete'
    if (index > activeIndex) return 'pending'
    return failed ? 'failed' : 'active'
  }

  /** Setup commands run in order; `detail` carries the 1-based command number. */
  const setupProgress = $derived(
    job.stage.stage === 'setup' && job.setupCommandCount > 0 && job.stage.detail
      ? ` (${job.stage.detail} of ${job.setupCommandCount})`
      : ''
  )

  const statusLabel = $derived(
    running ? `${scopeJobStageLabel(job.stage.stage)}${setupProgress}` : done ? 'Ready' : 'Failed'
  )
</script>

<DockableModal
  open
  title={heading}
  minimized={job.minimized}
  closable={!running}
  {onMinimize}
  {onExpand}
  {onClose}
  {storageKey}
  defaultHeight={420}
  dragLabel="Drag to move the worktree run"
>
  <div class="space-y-3">
    <p class="flex items-center gap-1.5 text-xs font-medium" aria-live="polite">
      {#if running}
        <Loader2 size={13} class="animate-spin text-info" aria-hidden="true" />
        <span class="text-info">{statusLabel}</span>
      {:else if done}
        <CircleCheck size={13} class="text-success" aria-hidden="true" />
        <span class="text-success">{statusLabel}</span>
      {:else}
        <TriangleAlert size={13} class="text-danger" aria-hidden="true" />
        <span class="text-danger">{statusLabel}</span>
      {/if}
    </p>

    <ol class="space-y-1.5">
      {#each job.steps as step (step)}
        {@const state = stateFor(step)}
        <li class="flex items-center gap-2 text-[0.6875rem]">
          {#if state === 'complete'}
            <CircleCheck size={12} class="shrink-0 text-success" aria-hidden="true" />
          {:else if state === 'active'}
            <Loader2 size={12} class="shrink-0 animate-spin text-info" aria-hidden="true" />
          {:else if state === 'failed'}
            <TriangleAlert size={12} class="shrink-0 text-danger" aria-hidden="true" />
          {:else}
            <Circle size={12} class="shrink-0 text-dimmed" aria-hidden="true" />
          {/if}
          <span class={state === 'pending' ? 'text-dimmed' : 'text-foreground'}>
            {scopeJobStageLabel(step)}{step === 'setup' && state === 'active' ? setupProgress : ''}
          </span>
          {#if state === 'complete'}
            <span class="sr-only">completed</span>
          {:else if state === 'failed'}
            <span class="sr-only">failed</span>
          {/if}
        </li>
      {/each}
    </ol>

    {#if job.error}
      <p
        class="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[0.6875rem] text-danger"
      >
        {job.error}
      </p>
    {/if}

    {#if job.result}
      <div class="space-y-1 rounded-lg border bg-overlay px-3 py-2 text-[0.6875rem] text-muted">
        <p class="flex min-w-0 items-center gap-1.5">
          <span class="shrink-0">Branch</span>
          <code class="truncate font-mono text-foreground">{job.result.branch}</code>
        </p>
        <p class="flex min-w-0 items-center gap-1.5">
          <span class="shrink-0">Folder</span>
          <code class="truncate font-mono text-foreground">{job.result.directoryName}</code>
        </p>
      </div>
    {/if}

    <p class="text-[0.6875rem] text-dimmed">
      {running
        ? 'You can keep working. The run continues in the background.'
        : done
          ? job.isolated
            ? 'Threads you move into this scope work in the new checkout.'
            : 'This scope shares the project directory with the Default scope.'
          : 'Nothing else changed. Fix the problem above and run it again from the scope menu.'}
    </p>
  </div>

  <!--
    The host renders one unified dock row for every minimized run, so this panel
    contributes no chip of its own (mirrors `GitPullRequestSheet`).
  -->
  {#snippet dock()}{/snippet}

  {#snippet footer()}
    {#if running}
      <button
        type="button"
        class="rounded-lg px-3 py-2 text-sm text-muted hover:bg-elevated"
        onclick={onMinimize}
      >
        Run in background
      </button>
    {:else}
      <button
        type="button"
        class="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-on-primary hover:bg-primary-hover"
        onclick={onClose}
      >
        Done
      </button>
    {/if}
  {/snippet}
</DockableModal>
