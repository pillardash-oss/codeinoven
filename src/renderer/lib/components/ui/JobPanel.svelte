<script lang="ts">
  /**
   * One background job as a dockable panel: what it is doing, the steps it goes
   * through, and what it left behind.
   *
   * Presentational on purpose. Every job owner in the app (the scope worktree
   * runs, the pull request batches and the syncs between checkouts) reports
   * progress in its own terms, so each resolves its own steps into
   * `JobStepView`s and hands them here. That is what keeps one panel, one footer
   * and one dockable behaviour instead of three copies that drift: a run that
   * spends minutes in the background is the same experience whoever started it.
   */
  import { Circle, CircleCheck, Loader2, TriangleAlert } from '@lucide/svelte'
  import type { Snippet } from 'svelte'
  import DockableModal from './DockableModal.svelte'
  import type { JobStatus, JobStepView } from './job-view'

  interface Props {
    /** Panel heading: who the run belongs to and where it stands. */
    title: string
    status: JobStatus
    /** What the run is doing right now, phrased for its own kind of work. */
    statusLabel: string
    steps: readonly JobStepView[]
    /** The refusal that stopped the run, shown above the checklist's outcome. */
    error?: string | null
    /**
     * The run's own result block, under the checklist: a branch and folder for a
     * worktree, a count and the survivors for a pull request batch.
     */
    details?: Snippet
    /** One sentence: what happens next, or that the user may leave. */
    note: string
    minimized: boolean
    onMinimize: () => void
    onClose: () => void
    storageKey: string
    dragLabel?: string
    defaultHeight?: number
  }

  let {
    title,
    status,
    statusLabel,
    steps,
    error = null,
    details,
    note,
    minimized,
    onMinimize,
    onClose,
    storageKey,
    dragLabel = 'Drag to move this run',
    defaultHeight = 420
  }: Props = $props()

  const running = $derived(status === 'running')
  const done = $derived(status === 'succeeded')
</script>

<DockableModal
  open
  {title}
  {minimized}
  closable={!running}
  {onMinimize}
  {onClose}
  {storageKey}
  {defaultHeight}
  {dragLabel}
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
      {#each steps as step (step.id)}
        <li class="flex items-start gap-2 text-[0.6875rem]">
          {#if step.state === 'complete'}
            <CircleCheck size={12} class="mt-0.5 shrink-0 text-success" aria-hidden="true" />
          {:else if step.state === 'active'}
            <Loader2 size={12} class="mt-0.5 shrink-0 animate-spin text-info" aria-hidden="true" />
          {:else if step.state === 'failed'}
            <TriangleAlert size={12} class="mt-0.5 shrink-0 text-danger" aria-hidden="true" />
          {:else}
            <Circle size={12} class="mt-0.5 shrink-0 text-dimmed" aria-hidden="true" />
          {/if}
          <span class="min-w-0 flex-1">
            <span
              class="block truncate {step.state === 'pending' ? 'text-dimmed' : 'text-foreground'}"
              title={step.label}
            >
              {step.label}
            </span>
            {#if step.detail}
              <!--
                A failure's reason is the point of the line, so it carries the danger
                tone; a reason a row was never attempted is information, not an error.
              -->
              <span
                class="block text-[0.625rem] leading-relaxed {step.state === 'failed'
                  ? 'text-danger'
                  : 'text-dimmed'}"
                title={step.detail}
              >
                {step.detail}
              </span>
            {/if}
          </span>
          {#if step.state === 'complete'}
            <span class="sr-only">completed</span>
          {:else if step.state === 'failed'}
            <span class="sr-only">failed</span>
          {:else if step.state === 'active'}
            <span class="sr-only">in progress</span>
          {/if}
        </li>
      {/each}
    </ol>

    {#if error}
      <p
        class="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[0.6875rem] text-danger"
      >
        {error}
      </p>
    {/if}

    {#if details}
      {@render details()}
    {/if}

    <p class="text-[0.6875rem] text-dimmed">{note}</p>
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
