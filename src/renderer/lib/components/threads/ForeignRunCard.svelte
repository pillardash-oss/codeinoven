<script lang="ts">
  import CioSwap from '$lib/components/icons/cio/CioSwap.svelte'
  import CioWindow from '$lib/components/icons/cio/CioWindow.svelte'
  import { slide } from 'svelte/transition'
  import CardButton from '../shared/CardButton.svelte'
  import CardFoot from '../shared/CardFoot.svelte'
  import CardFrame from '../shared/CardFrame.svelte'
  import CardHead from '../shared/CardHead.svelte'
  import { foldSlide } from '../shared/card-motion'
  import { foreignRuns } from '$lib/stores/foreign-runs.svelte'
  import { threadCardFold } from '$lib/stores/thread-card-fold.svelte'

  interface Props {
    projectId: string
    threadId: string
    /** Another card sits directly above this one, so its top rule is the broken
     *  line that separates two stacked surfaces. */
    stackedAbove?: boolean
    /** The surface below carries the join, so this card drops its bottom rule. */
    joinsBelow?: boolean
  }

  let { projectId, threadId, stackedAbove = false, joinsBelow = false }: Props = $props()

  /** The fold control writes a per-thread preference, so the card stays folded or
   *  unfolded when the thread is reopened. */
  const foldState = {
    get folded(): boolean {
      return threadCardFold.isFolded(threadId, 'foreign-run')
    },
    set folded(value: boolean) {
      threadCardFold.setFolded(threadId, 'foreign-run', value)
    }
  }
  const transfer = $derived(foreignRuns.transferState(projectId, threadId))
  const workflow = $derived(foreignRuns.isWorkflow(projectId, threadId))

  function startTransfer(): void {
    void foreignRuns.transfer(projectId, threadId)
  }
</script>

<CardFrame placement="replace" label="Running on another instance" {stackedAbove} {joinsBelow}>
  <CardHead
    icon={CioWindow}
    title="Running on another instance"
    chip={{ text: 'Live elsewhere', tone: 'paused' }}
    bind:folded={foldState.folded}
    foldLabel="foreign run"
  />

  {#if !foldState.folded}
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

  {#if !foldState.folded}
    <CardFoot>
      {#snippet right()}
        <CardButton
          label="Transfer to this instance"
          title="Move this thread's run to this instance"
          icon={transfer.pending ? undefined : CioSwap}
          variant="primary"
          loading={transfer.pending}
          disabled={transfer.pending}
          onclick={startTransfer}
        />
      {/snippet}
    </CardFoot>
  {/if}
</CardFrame>
