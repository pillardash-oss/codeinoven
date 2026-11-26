<script lang="ts">
  import CioArrowRight from '@pdslng/cio-icon/CioArrowRight.svelte'
  import CioAttention from '@pdslng/cio-icon/CioAttention.svelte'
  import CioLock from '@pdslng/cio-icon/CioLock.svelte'
  import CioUndo from '@pdslng/cio-icon/CioUndo.svelte'
  import { slide } from 'svelte/transition'
  import type { ProviderCatalog, ThreadSettings } from '$shared/types'
  import { presentProviderError } from '$shared/provider-issue'
  import { invoke } from '$lib/ipc.svelte'
  import EngineeringModelSwitch from '../shared/EngineeringModelSwitch.svelte'
  import CardButton from '../shared/CardButton.svelte'
  import CardFoot from '../shared/CardFoot.svelte'
  import CardFrame from '../shared/CardFrame.svelte'
  import CardHead from '../shared/CardHead.svelte'
  import CardNotice from '../shared/CardNotice.svelte'
  import { foldSlide } from '../shared/card-motion'
  import { threadCardFold } from '$lib/stores/thread-card-fold.svelte'

  /**
   * What the card needs to read a pawn's run.
   *
   * A pawn answers only to the agent that spawned it, so its failure is the one
   * thing the reader has to see and the one thing they can act on: retry it.
   */
  interface PawnControls {
    projectId: string
    /** Changes while the pawn's live state may have moved, so the card re-reads
     *  its run instead of showing what it knew when it mounted. */
    refreshKey?: string
    /**
     * The pawn's own thread settings, which the retry runs on.
     *
     * A rate limit, a paused provider or a task spawned on the wrong model is
     * fixed by the person watching the pawn, and the retry is where that fix
     * lands: the picker writes the thread's settings, and the retry reads them
     * back. Without it the only fix on offer is "run the same failing model
     * again".
     */
    settings?: ThreadSettings
    providers?: ProviderCatalog[]
    favoriteModels?: string[]
    recentModels?: string[]
    onModelChange?: (settings: ThreadSettings) => void
    onToggleFavorite?: (providerId: string, modelId: string, harnessId: string) => void
    onRemoveRecent?: (modelKey: string) => void
    onReorderFavorite?: (
      draggedKey: string,
      targetKey: string,
      position: 'before' | 'after'
    ) => void
  }

  interface Props {
    /** Which coordinated thread this is, so the card explains the way out that
     *  actually exists for it. */
    kind: 'worker' | 'auditor' | 'pawn'
    threadId: string
    coordinatorTitle?: string
    /** Another card sits directly above this one, so its top rule is the broken
     *  line that separates two stacked surfaces. */
    stackedAbove?: boolean
    /** The surface below carries the join, so this card drops its bottom rule. */
    joinsBelow?: boolean
    /** Present for a pawn only: a run that stopped on a failure can be retried
     *  from here without sending the pawn a message. */
    pawn?: PawnControls
    onOpenCoordinator: () => void
  }

  let {
    kind,
    threadId,
    coordinatorTitle,
    stackedAbove = false,
    joinsBelow = false,
    pawn,
    onOpenCoordinator
  }: Props = $props()

  const foldState = {
    get folded(): boolean {
      return threadCardFold.isFolded(threadId, 'locked-orchestration')
    },
    set folded(value: boolean) {
      threadCardFold.setFolded(threadId, 'locked-orchestration', value)
    }
  }

  const subject = $derived(
    kind === 'auditor' ? 'auditor' : kind === 'pawn' ? 'helper agent' : 'worker'
  )
  const owner = $derived(coordinatorTitle ? `“${coordinatorTitle}”` : 'its coordinator')

  /** The pawn's own run, read from the records it left: its row, its session and
   *  its transcript. A card that trusted only the live events it happened to see
   *  showed a rate-limited pawn as done, or as nothing at all. */
  let pawnRunning = $state(false)
  let pawnFailure = $state<string | null>(null)
  let retrying = $state(false)
  let actionError = $state('')

  /** Read the pawn's run from the records it left. Called when the card mounts
   *  and again whenever its parent reports a settle, stop, error or retry. */
  function loadPawnRun(projectId: string): () => void {
    let alive = true
    void invoke('agent:getPawnRunState', projectId, threadId)
      .then((state) => {
        if (!alive) return
        pawnRunning = state.running
        pawnFailure = state.failure
      })
      .catch(() => {
        /* The card keeps what it has: a read that failed is not a failure report. */
      })
    return () => {
      alive = false
    }
  }

  $effect(() => {
    const projectId = pawn?.projectId
    const key = pawn?.refreshKey ?? ''
    if (projectId === undefined || key.length === 0) return
    return loadPawnRun(projectId)
  })

  const failureText = $derived(
    pawnFailure === null ? null : presentProviderError(pawnFailure).message
  )
  /**
   * Retry exists for one situation only: a pawn whose run stopped on a real
   * failure. A finished run is finished, and a live run is not the reader's to
   * restart.
   */
  const retryable = $derived(pawn !== undefined && pawnFailure !== null && !pawnRunning)
  const chip = $derived.by(() => {
    if (pawnRunning) return { text: 'Running', tone: 'default' as const }
    if (retryable) return { text: 'Failed', tone: 'urgent' as const }
    return { text: 'Locked', tone: 'paused' as const }
  })

  /** Run the same task again on the pawn's thread, on the model picked in this
   *  card. The pick rides with the click: the picker's own save is asynchronous,
   *  and a retry that read the row back could run the model the reader just left. */
  function retryPawnRun(): void {
    if (!pawn || retrying) return
    retrying = true
    actionError = ''
    void invoke('agent:retryPawnRun', pawn.projectId, threadId, pawn.settings)
      .then(() => {
        pawnRunning = true
        pawnFailure = null
      })
      .catch((error: unknown) => {
        actionError = error instanceof Error ? error.message : 'The pawn run could not be retried.'
      })
      .finally(() => {
        retrying = false
      })
  }
</script>

<!-- A coordinated thread takes no separate conversation, so it must not offer a
composer that only collects a rejected message. This card is what the composer's
slot becomes: the reason, and the one control that actually moves the work on. -->
<CardFrame placement="replace" label="Coordinated thread" {stackedAbove} {joinsBelow}>
  <CardHead
    icon={retryable ? CioAttention : CioLock}
    title={retryable ? 'Pawn run failed' : 'Driven by its coordinator'}
    {chip}
    bind:folded={foldState.folded}
    foldLabel="coordinated thread"
  />

  {#if !foldState.folded}
    <div
      transition:slide={foldSlide()}
      class="flex flex-col gap-1.5 px-3 py-2.5 text-xs leading-relaxed text-muted"
    >
      {#if kind === 'auditor'}
        <p>
          This thread is the {subject} that {owner} runs. Its audit is started and re-checked from that
          thread's audit coordinator, and the auditor's model and account are chosen there too.
        </p>
        <p>
          Nothing is typed into this thread: a message here would start a second run beside the
          audit the coordinator is driving. While the audit runs, its card above is where it is
          stopped.
        </p>
      {:else if kind === 'pawn'}
        {#if retryable && failureText}
          <CardNotice icon={CioAttention} tone="danger">
            <span class="select-text break-words">{failureText}</span>
          </CardNotice>
          
        {:else if !retryable}
          <p>
            This thread is a {subject} its parent agent spawns and steers. It reports to that agent, and
            a new instruction goes there.
          </p>
        {/if}
        {#if actionError}
          <CardNotice icon={CioAttention} tone="danger">
            <span class="select-text break-words">{actionError}</span>
          </CardNotice>
        {/if}
      {:else}
        <p>
          This thread is a {subject} of {owner}. It takes its instructions there, and while it is
          running you can still message it here to steer the work in progress.
        </p>
        <p>
          Once it finishes, the next instruction belongs to the coordinator so the task's evidence
          and review stay in one place.
        </p>
      {/if}
    </div>
  {/if}

  {#if !foldState.folded}
    <!-- The picker and the retry are one decision: the model is what the retry
         runs on, so it sits beside the button that carries it out. -->
    <CardFoot yields={retryable ? 'right' : 'left'}>
      {#snippet right()}
        {#if retryable && pawn}
          <EngineeringModelSwitch
            settings={pawn.settings}
            providers={pawn.providers ?? []}
            projectId={pawn.projectId}
            favoriteModels={pawn.favoriteModels ?? []}
            recentModels={pawn.recentModels ?? []}
            onRemoveRecent={pawn.onRemoveRecent}
            onModelChange={pawn.onModelChange}
            onToggleFavorite={pawn.onToggleFavorite}
            onReorderFavorite={pawn.onReorderFavorite}
          />
          <CardButton
            label="Retry run"
            title="Run this pawn agent again on the model and thinking level picked here"
            icon={retrying ? undefined : CioUndo}
            variant="primary"
            loading={retrying}
            disabled={retrying}
            onclick={retryPawnRun}
          />
        {/if}
        <CardButton
          label="Open coordinator"
          title={coordinatorTitle
            ? `Open the coordinator thread “${coordinatorTitle}”`
            : 'Open the coordinator that runs this thread'}
          icon={CioArrowRight}
          variant={retryable ? 'secondary' : 'primary'}
          onclick={onOpenCoordinator}
        />
      {/snippet}
    </CardFoot>
  {/if}
</CardFrame>
