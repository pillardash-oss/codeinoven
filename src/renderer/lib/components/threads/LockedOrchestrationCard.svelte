<script lang="ts">
  import CioArrowRight from '@pdslng/cio-icon/CioArrowRight.svelte'
  import CioAttention from '@pdslng/cio-icon/CioAttention.svelte'
  import CioLock from '@pdslng/cio-icon/CioLock.svelte'
  import CioUndo from '@pdslng/cio-icon/CioUndo.svelte'
  import { slide } from 'svelte/transition'
  import type { ProviderCatalog, ThreadSettings, ThinkingLevel } from '$shared/types'
  import { normalizeFastInference, supportsFastInference } from '$shared/fast-inference'
  import { presentProviderError } from '$shared/provider-issue'
  import { invoke } from '$lib/ipc.svelte'
  import CardButton from '../shared/CardButton.svelte'
  import CardFoot from '../shared/CardFoot.svelte'
  import CardFrame from '../shared/CardFrame.svelte'
  import CardHead from '../shared/CardHead.svelte'
  import CardNotice from '../shared/CardNotice.svelte'
  import ModelPicker from '../shared/ModelPicker.svelte'
  import { foldSlide } from '../shared/card-motion'
  import { threadCardFold } from '$lib/stores/thread-card-fold.svelte'

  /**
   * The pawn controls the locked card owns.
   *
   * A pawn answers only to the agent that spawned it, so nothing it does is
   * reachable by typing into it. Its run is still the reader's to fix: a rate
   * limit, a paused provider, or a task spawned on the wrong model or thinking
   * level is exactly what they have to correct, and they correct it here.
   */
  interface PawnControls {
    projectId: string
    settings: ThreadSettings
    providers: ProviderCatalog[]
    favoriteModels?: string[]
    recentModels?: string[]
    /** Changes while the pawn's live state may have moved, so the card re-reads
     *  its run instead of showing what it knew when it mounted. */
    refreshKey?: string
    onModelChange: (settings: ThreadSettings) => void
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
    /** Present for a pawn only. The composer gives up its place to this card, so
     *  the card must carry the two actions a pawn still needs: retry the run and
     *  change the model or thinking level it runs on. */
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
   * failure. A finished run is finished   offering to run it again invites the
   * reader to repeat work that already landed   and a live run is not the
   * reader's to restart. The model picker belongs to that same failure, because
   * a run that died on a rate limit or on the wrong model has to be able to move
   * before it is retried.
   */
  const retryable = $derived(pawn !== undefined && pawnFailure !== null && !pawnRunning)
  const chip = $derived.by(() => {
    if (pawnRunning) return { text: 'Running', tone: 'default' as const }
    if (pawnFailure !== null) return { text: 'Failed', tone: 'urgent' as const }
    return { text: 'Locked', tone: 'paused' as const }
  })

  /**
   * Commit a new model on the pawn's own thread, mirroring the picker the
   * composer shows everywhere else. The retry that follows runs on this
   * selection, which is the point of offering it here.
   */
  function chooseModel(
    providerId: string,
    modelId: string,
    nextHarnessId?: string,
    accountId?: string
  ): void {
    if (!pawn) return
    const { settings, providers } = pawn
    const harnessId = nextHarnessId ?? settings.harnessId
    const provider = providers.find(
      (candidate) => candidate.harnessId === harnessId && candidate.id === providerId
    )
    const model = provider?.models.find((candidate) => candidate.id === modelId)
    pawn.onModelChange(
      normalizeFastInference(
        { ...settings, harnessId, accountId, providerId, modelId },
        harnessId,
        providerId,
        modelId,
        supportsFastInference(harnessId, providerId, model?.fastSupported)
      )
    )
  }

  function chooseThinking(level: ThinkingLevel): void {
    if (!pawn) return
    pawn.onModelChange({ ...pawn.settings, thinkingLevel: level })
  }

  function chooseRuntime(runtime: import('$shared/types').ModelRuntimeSettings): void {
    if (!pawn) return
    pawn.onModelChange({ ...pawn.settings, ...runtime })
  }

  /** Run the same task again on the pawn's thread, on the model it carries now. */
  function retryPawnRun(): void {
    if (!pawn || retrying) return
    retrying = true
    actionError = ''
    void invoke('agent:retryPawnRun', pawn.projectId, threadId)
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
    icon={kind === 'pawn' && retryable ? CioAttention : CioLock}
    title={kind === 'pawn' && retryable ? 'Pawn run failed' : 'Driven by its coordinator'}
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
        <p>
          This thread is a {subject} its parent agent spawns and steers. It reports to that agent, and
          a new instruction goes there.
        </p>
        {#if retryable}
          <p>
            Its run stopped on an error, so it can be retried here, on the model and thinking level
            this thread carries, without sending it a message.
          </p>
        {/if}
        {#if retryable && failureText}
          <CardNotice icon={CioAttention} tone="danger">
            <span class="select-text break-words">{failureText}</span>
          </CardNotice>
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
    <CardFoot yields="right">
      {#snippet left()}
        {#if pawn && pawn.providers.length > 0}
          <ModelPicker
            providers={pawn.providers}
            projectId={pawn.projectId}
            harnessId={pawn.settings.harnessId}
            providerId={pawn.settings.providerId}
            modelId={pawn.settings.modelId}
            accountId={pawn.settings.accountId}
            favoriteModels={pawn.favoriteModels ?? []}
            recentModels={pawn.recentModels ?? []}
            onRemoveRecent={pawn.onRemoveRecent}
            side="top"
            label="Change"
            variant="action"
            disabled={retrying}
            onSelect={chooseModel}
            thinkingLevel={pawn.settings.thinkingLevel}
            runtimeSettings={pawn.settings}
            onSelectThinking={chooseThinking}
            onSelectRuntime={chooseRuntime}
            onToggleFavorite={pawn.onToggleFavorite}
            onReorderFavorite={pawn.onReorderFavorite}
          />
        {/if}
      {/snippet}
      {#snippet right()}
        {#if pawn}
          <CardButton
            label="Retry run"
            title={pawnRunning
              ? 'The pawn is still working; retry once its run has stopped'
              : 'Run this pawn agent again on the model it carries now'}
            icon={retrying ? undefined : CioUndo}
            variant="primary"
            loading={retrying}
            disabled={retrying || pawnRunning}
            onclick={retryPawnRun}
          />
        {/if}
        <CardButton
          label="Open coordinator"
          title={coordinatorTitle
            ? `Open the coordinator thread “${coordinatorTitle}”`
            : 'Open the coordinator that runs this thread'}
          icon={CioArrowRight}
          variant={pawn ? 'secondary' : 'primary'}
          onclick={onOpenCoordinator}
        />
      {/snippet}
    </CardFoot>
  {/if}
</CardFrame>
