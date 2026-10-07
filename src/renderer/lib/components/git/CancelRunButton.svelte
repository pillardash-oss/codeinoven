<script lang="ts">
  import { CircleStop, Loader2 } from '@lucide/svelte'
  import { toast } from 'svelte-sonner'
  import { showToastError } from '$lib/stores/app-errors.svelte'
  import { gitState } from '$lib/stores/git.svelte'
  import ConfirmDialog from '../ui/ConfirmDialog.svelte'
  import type { GitHubWorkflowRun } from '$shared/types'

  interface Props {
    projectId: string
    identity: { owner: string; repo: string }
    runId: number
    /**
     * The run's own status. GitHub only accepts a cancel for a run that is queued
     * or in progress, so a finished run renders nothing rather than a control
     * whose only outcome is a refusal.
     */
    runStatus: GitHubWorkflowRun['status']
    /** Icon-only trigger, for rows too tight to carry the label. */
    compact?: boolean
    /** Extra classes for the trigger, so each surface places it in its own row. */
    class?: string
    onCancelled?: () => void
  }

  let {
    projectId,
    identity,
    runId,
    runStatus,
    compact = false,
    class: className = '',
    onCancelled
  }: Props = $props()

  const busy = $derived(gitState.isBusy('deployment-cancel'))

  let confirmOpen = $state(false)

  /**
   * GitHub has no per-job cancel endpoint, so skipping a job means cancelling the
   * run that owns it. That is destructive enough to confirm first, which is also
   * what keeps a stray click from killing a run someone is waiting on.
   */
  const cancellable = $derived(runStatus === 'queued' || runStatus === 'in_progress')

  async function confirmCancel(): Promise<void> {
    // Dismiss first so the blocking confirm never holds the window while the
    // request runs and never survives its own failure. The outcome reports
    // where the run already lives: a toast plus the panel's error line.
    confirmOpen = false
    if (busy) return
    const ok = await gitState.cancelWorkflowRun(projectId, identity.owner, identity.repo, runId)
    if (ok) {
      toast.success('Workflow run cancellation requested')
      onCancelled?.()
      return
    }
    // A permission refusal already has its own panel notice with the fix link,
    // so it must not also raise a toast.
    if (gitState.githubPermission) return
    showToastError(gitState.error ?? 'The workflow run could not be cancelled')
  }
</script>

{#if cancellable}
  <button
    type="button"
    class="flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-xs border border-danger/40 px-2 text-[0.5625rem] font-medium text-danger transition-colors hover:bg-danger/10 disabled:cursor-default disabled:opacity-40 {className}"
    title="Cancel this workflow run and skip its remaining jobs"
    aria-label="Cancel this workflow run"
    disabled={busy}
    onclick={() => (confirmOpen = true)}
  >
    {#if busy}
      <Loader2 size={11} class="animate-spin" />
    {:else}
      <CircleStop size={11} />
    {/if}
    {#if !compact}
      <span>Cancel</span>
    {/if}
  </button>
{/if}

{#if confirmOpen}
  <ConfirmDialog
    open
    title="Cancel this workflow run?"
    confirmLabel="Cancel run"
    onCancel={() => (confirmOpen = false)}
    onConfirm={confirmCancel}
  >
    <p>
      The running jobs of this workflow run are stopped and the jobs that have not started are
      skipped. GitHub records the run as cancelled, and it can be re-run afterwards. This cannot be
      undone while it is in flight.
    </p>
  </ConfirmDialog>
{/if}
