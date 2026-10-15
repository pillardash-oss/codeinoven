<script lang="ts">
  import { AppWindow, ArrowRightLeft } from '@lucide/svelte'
  import { slide } from 'svelte/transition'
  import CardButton from '../shared/CardButton.svelte'
  import CardFoot from '../shared/CardFoot.svelte'
  import CardFrame from '../shared/CardFrame.svelte'
  import CardHead from '../shared/CardHead.svelte'
  import { foldSlide } from '../shared/card-motion'
  import { foreignRuns } from '$lib/stores/foreign-runs.svelte'

  interface Props {
    projectId: string
    threadId: string
  }

  let { projectId, threadId }: Props = $props()

  let folded = $state(false)
  const transfer = $derived(foreignRuns.transferState(projectId, threadId))
  const workflow = $derived(foreignRuns.isWorkflow(projectId, threadId))

  function startTransfer(): void {
    void foreignRuns.transfer(projectId, threadId)
  }
</script>

<CardFrame placement="replace" label="Running on another instance">
  <CardHead
    icon={AppWindow}
    title="Running on another instance"
    chip={{ text: 'Live elsewhere', tone: 'paused' }}
    bind:folded
    foldLabel="foreign run"
  />

  {#if !folded}
    <div
      transition:slide={foldSlide()}
      class="flex flex-col gap-1.5 px-3 py-2.5 text-xs leading-relaxed text-muted"
    >
      <p>
        Another CodeInOven window is streaming this run, so it cannot be typed into from here.
        Transfer the run to this instance to keep working in this window; the other window stops
        streaming and hands the thread over.
      </p>
      {#if workflow}
        <p>
          This run belongs to a coordinated workflow. Transferring moves the whole workflow, so the
          Sr. Engineer and every worker land on this instance together.
        </p>
      {/if}
      {#if transfer.error}
        <p class="text-danger" role="alert">{transfer.error}</p>
      {/if}
    </div>
  {/if}

  {#if !folded}
    <CardFoot>
      {#snippet right()}
        <CardButton
          label="Transfer to this instance"
          title="Move this thread's run to this instance"
          icon={transfer.pending ? undefined : ArrowRightLeft}
          variant="primary"
          loading={transfer.pending}
          disabled={transfer.pending}
          onclick={startTransfer}
        />
      {/snippet}
    </CardFoot>
  {/if}
</CardFrame>
