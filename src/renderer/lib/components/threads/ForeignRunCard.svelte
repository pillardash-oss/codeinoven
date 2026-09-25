<script lang="ts">
  import { AppWindow, ArrowRightLeft, Loader2 } from '@lucide/svelte'
  import { foreignRuns } from '$lib/stores/foreign-runs.svelte'

  interface Props {
    projectId: string
    threadId: string
  }

  let { projectId, threadId }: Props = $props()

  const transfer = $derived(foreignRuns.transferState(projectId, threadId))
  const workflow = $derived(foreignRuns.isWorkflow(projectId, threadId))

  function startTransfer(): void {
    void foreignRuns.transfer(projectId, threadId)
  }
</script>

<section
  class="overflow-hidden rounded-xl border border-border bg-surface shadow-sm"
  aria-label="Thread running on another instance"
>
  <div class="flex items-center gap-2 border-b border-border bg-info/5 px-4 py-2.5">
    <AppWindow size={15} class="shrink-0 text-info" />
    <p class="text-xs font-semibold uppercase tracking-wide text-info">
      Running on another instance
    </p>
  </div>

  <div class="space-y-1.5 p-4">
    <p class="text-sm font-semibold text-foreground">This thread is running on another instance</p>
    <p class="text-xs leading-relaxed text-muted">
      Another CodeInOven window is streaming this run, so it cannot be typed into from here.
      Transfer the run to this instance to keep working in this window; the other window stops
      streaming and hands the thread over.
    </p>
    {#if workflow}
      <p class="text-xs leading-relaxed text-muted">
        This run belongs to a coordinated workflow. Transferring moves the whole workflow, so the
        Sr. Engineer and every worker land on this instance together.
      </p>
    {/if}
    {#if transfer.error}
      <p class="text-xs leading-relaxed text-danger" role="alert">{transfer.error}</p>
    {/if}
  </div>

  <div class="flex items-center justify-end gap-2 border-t border-border px-4 py-2.5">
    <button
      type="button"
      class="flex min-h-8 items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-on-primary transition-opacity hover:opacity-90 disabled:opacity-40"
      title="Move this thread's run to this instance"
      aria-label="Move this thread's run to this instance"
      disabled={transfer.pending}
      onclick={startTransfer}
    >
      {#if transfer.pending}
        <Loader2 size={13} class="animate-spin" />
        Transferring…
      {:else}
        <ArrowRightLeft size={13} />
        Transfer to this instance
      {/if}
    </button>
  </div>
</section>
