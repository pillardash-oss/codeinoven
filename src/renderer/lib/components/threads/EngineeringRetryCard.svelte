<script lang="ts">
  import CioClose from '@pdslng/cio-icon/CioClose.svelte'
  import CioRefresh from '@pdslng/cio-icon/CioRefresh.svelte'
  import { slide } from 'svelte/transition'
  import CardButton from '../shared/CardButton.svelte'
  import ModelPicker from '../shared/ModelPicker.svelte'
  import { type CardChipData } from '../shared/CardTimer.svelte'
  import { dismissSlide } from '../shared/card-motion'
  import ErrorStrip, { type ErrorStripAction } from '../ui/ErrorStrip.svelte'
  import type {
    EngineeringLifecycleStage,
    ProviderCatalog,
    ThreadSettings,
    ThinkingLevel
  } from '$shared/types'

  interface Props {
    /** The stage that failed; `undefined` keeps the copy generic. */
    stage?: EngineeringLifecycleStage
    /** Persisted failure message from the lifecycle state. */
    failure?: string
    busy?: boolean
    providers?: ProviderCatalog[]
    projectId?: string | null
    settings?: ThreadSettings
    favoriteModels?: string[]
    recentModels?: string[]
    onRetry: () => void | Promise<void>
    /** Stops the Engineering lifecycle so the normal stage card shows again. */
    onCancel: () => void | Promise<void>
    onModelChange?: (settings: ThreadSettings) => void
    onToggleFavorite?: (providerId: string, modelId: string, harnessId: string) => void
    /** Removes one model from the recently-used history; shows the "x" on recent rows. */
    onRemoveRecent?: (modelKey: string) => void
    onReorderFavorite?: (
      draggedKey: string,
      targetKey: string,
      position: 'before' | 'after'
    ) => void
  }

  let {
    stage,
    failure,
    busy = false,
    providers = [],
    projectId = null,
    settings,
    favoriteModels = [],
    recentModels = [],
    onRetry,
    onCancel,
    onModelChange,
    onToggleFavorite,
    onRemoveRecent,
    onReorderFavorite
  }: Props = $props()

  let folded = $state(false)
  const STAGE_LABELS: Record<EngineeringLifecycleStage, string> = {
    brainstorm: 'Brainstorm',
    prd: 'PRD',
    spec: 'Spec',
    assignment: 'Assignment',
    achievement: 'Achievement'
  }

  const stageLabel = $derived(
    stage === undefined ? 'Engineering' : (STAGE_LABELS[stage] ?? 'Engineering')
  )

  const chip: CardChipData = {
    text: 'Stopped',
    tone: 'urgent',
    title: 'The stage stopped with an error'
  }

  /** The one primary action. It sits in the header while the card is folded. */
  const retryAction = $derived<ErrorStripAction>({
    label: busy ? 'Retrying…' : 'Retry stage',
    title: `Retry the failed ${stageLabel} stage with the selected model`,
    icon: busy ? undefined : CioRefresh,
    loading: busy,
    disabled: busy,
    onclick: () => void onRetry()
  })

  function chooseModel(
    providerId: string,
    modelId: string,
    nextHarnessId?: string,
    accountId?: string
  ): void {
    if (!settings) return
    onModelChange?.({
      ...settings,
      harnessId: nextHarnessId ?? settings.harnessId,
      accountId,
      providerId,
      modelId
    })
  }

  function chooseThinking(level: ThinkingLevel): void {
    if (!settings) return
    onModelChange?.({ ...settings, thinkingLevel: level })
  }

  function chooseRuntime(runtime: import('$shared/types').ModelRuntimeSettings): void {
    if (!settings) return
    onModelChange?.({ ...settings, ...runtime })
  }
</script>

<div out:slide={dismissSlide()}>
  <ErrorStrip
    placement="replace"
    label="Retry failed Engineering stage"
    title="{stageLabel} failed"
    tone="warning"
    {chip}
    bind:folded
    foldLabel="failed stage"
    primary={retryAction}
  >
    <p class="font-semibold text-foreground">The {stageLabel} stage could not complete</p>
    <p>
      {failure?.trim() ||
        'The stage stopped with an error. Retry it from where it stopped. Completed progress and context are preserved.'}
    </p>

    {#snippet footerStart()}
      <CardButton
        label="Cancel"
        title="Stop the Engineering lifecycle and return to the stage card"
        icon={CioClose}
        variant="ghost-danger"
        disabled={busy}
        onclick={() => void onCancel()}
      />
    {/snippet}

    {#snippet footerEnd()}
      {#if settings}
        <ModelPicker
          {providers}
          {projectId}
          harnessId={settings.harnessId}
          providerId={settings.providerId}
          modelId={settings.modelId}
          accountId={settings.accountId}
          {favoriteModels}
          {recentModels}
          {onRemoveRecent}
          side="top"
          label="Change model"
          variant="action"
          onSelect={chooseModel}
          thinkingLevel={settings.thinkingLevel}
          runtimeSettings={settings}
          onSelectThinking={chooseThinking}
          onSelectRuntime={chooseRuntime}
          {onToggleFavorite}
          {onReorderFavorite}
        />
      {:else}
        <CardButton
          label="Change model"
          title="Choose a model before retrying"
          variant="secondary"
          disabled
        />
      {/if}
    {/snippet}
  </ErrorStrip>
</div>
