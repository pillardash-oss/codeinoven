<script lang="ts">
  import { ChevronDown, Loader2, RefreshCw, RotateCcw } from '@lucide/svelte'
  import { DropdownMenu } from 'bits-ui'
  import { toast } from 'svelte-sonner'
  import { showToastError } from '$lib/stores/app-errors.svelte'
  import { gitState } from '$lib/stores/git.svelte'
  import type { GitHubWorkflowRun, WorkflowRerunMode } from '$shared/types'

  interface Props {
    projectId: string
    identity: { owner: string; repo: string }
    runId: number
    /**
     * The run's own status. GitHub refuses to re-run a run that has not
     * finished, so a queued or in-progress run renders nothing rather than a
     * control whose only outcome is a refusal.
     */
    runStatus: GitHubWorkflowRun['status']
    /** Whether the run has a failed job, so "failed jobs only" can be offered. */
    hasFailedJobs: boolean
    /** Icon-only trigger, for rows too tight to carry the label. */
    compact?: boolean
    /** Extra classes for the trigger, so each surface places it in its own row. */
    class?: string
    onRerun?: (mode: WorkflowRerunMode) => void
  }

  let {
    projectId,
    identity,
    runId,
    runStatus,
    hasFailedJobs,
    compact = false,
    class: className = '',
    onRerun
  }: Props = $props()

  const busy = $derived(gitState.isBusy('deployment-rerun'))

  /**
   * GitHub accepts a re-run only once the run has finished, so an in-flight run
   * is a refusal waiting to happen. `unknown` is left to the provider, which
   * answers with its own reason rather than this view silently hiding the
   * control for a run that may well be re-runnable.
   */
  const rerunnable = $derived(runStatus !== 'queued' && runStatus !== 'in_progress')
  async function rerun(mode: WorkflowRerunMode): Promise<void> {
    const label = mode === 'failed' ? 'failed jobs' : 'all jobs'
    const ok = await gitState.rerunWorkflowRun(
      projectId,
      identity.owner,
      identity.repo,
      runId,
      mode
    )
    if (ok) {
      toast.success(`Re-running ${label}`)
      onRerun?.(mode)
      return
    }
    // A permission refusal already has its own panel notice with the fix link,
    // so it must not also raise a toast.
    if (gitState.githubPermission) return
    showToastError(gitState.error ?? 'The workflow run could not be re-run')
  }
</script>

{#if rerunnable}
  <DropdownMenu.Root>
    <DropdownMenu.Trigger
      class="flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-xs border border-border px-2 text-[0.5625rem] font-medium text-foreground transition-colors hover:bg-elevated disabled:cursor-default disabled:opacity-40 {className}"
      title="Re-run jobs for this workflow run"
      aria-label="Re-run jobs for this workflow run"
      disabled={busy}
    >
      {#if busy}
        <Loader2 size={11} class="animate-spin" />
      {:else}
        <RefreshCw size={11} />
      {/if}
      {#if !compact}
        <span>Re-run</span>
      {/if}
      <ChevronDown size={10} class="text-dimmed" />
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        side="bottom"
        align="end"
        sideOffset={6}
        class="z-90 w-44 overflow-hidden rounded-lg border-border bg-surface p-1 shadow-lg"
      >
        <p
          class="px-2.5 py-1.5 text-[0.625rem] font-semibold uppercase tracking-[0.14em] text-dimmed"
        >
          Re-run
        </p>
        <DropdownMenu.Item
          class="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-foreground outline-none transition-colors data-[highlighted]:bg-elevated"
          onSelect={() => void rerun('all')}
        >
          <RefreshCw size={12} class="shrink-0 text-dimmed" />
          Re-run all jobs
        </DropdownMenu.Item>
        <DropdownMenu.Item
          class="flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-foreground outline-none transition-colors data-[highlighted]:bg-elevated data-[disabled]:cursor-default data-[disabled]:opacity-40"
          disabled={!hasFailedJobs}
          onSelect={() => void rerun('failed')}
        >
          <RotateCcw size={12} class="shrink-0 text-dimmed" />
          Re-run failed jobs only
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>
{/if}
