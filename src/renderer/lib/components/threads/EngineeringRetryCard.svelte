<script lang="ts">
  import CioAttention from '@pdslng/cio-icon/CioAttention.svelte'
  import CioClose from '@pdslng/cio-icon/CioClose.svelte'
  import CioRefresh from '@pdslng/cio-icon/CioRefresh.svelte'
  import { slide } from 'svelte/transition'
  import CardButton from '../shared/CardButton.svelte'
  import CardFoot from '../shared/CardFoot.svelte'
  import CardFrame from '../shared/CardFrame.svelte'
  import CardHead from '../shared/CardHead.svelte'
  import ModelPicker from '../shared/ModelPicker.svelte'
  import { type CardChipData } from '../shared/CardTimer.svelte'
  import { dismissSlide, foldSlide } from '../shared/card-motion'
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
  <CardFrame placement="replace" label="Retry failed Engineering stage">
    <CardHead
      icon={CioAttention}
      title="{stageLabel} failed"
      {chip}
      tone="warn"
      bind:folded
      foldLabel="failed stage"
    />

    {#if !folded}
      <div transition:slide={foldSlide()}>
        <div class="flex flex-col gap-1.5 px-3 py-2.5">
          <p class="text-xs font-semibold text-foreground">
            The {stageLabel} stage could not complete
          </p>
          <p class="text-xs leading-relaxed text-muted">
            {failure?.trim() ||
              'The stage stopped with an error. Retry it from where it stopped   completed progress and context are preserved.'}
          </p>
        </div>

        <CardFoot>
          {#snippet left()}
            <CardButton
              label="Cancel"
              title="Stop the Engineering lifecycle and return to the stage card"
              icon={CioClose}
              variant="ghost-danger"
              disabled={busy}
              onclick={() => void onCancel()}
            />
          {/snippet}
          {#snippet right()}
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
            <CardButton
              label={busy ? 'Retrying…' : 'Retry stage'}
              title="Retry the failed {stageLabel} stage with the selected model"
              icon={busy ? undefined : CioRefresh}
              variant="primary"
              disabled={busy}
              loading={busy}
              onclick={() => void onRetry()}
            />
          {/snippet}
        </CardFoot>
      </div>
    {/if}
  </CardFrame>
</div>
