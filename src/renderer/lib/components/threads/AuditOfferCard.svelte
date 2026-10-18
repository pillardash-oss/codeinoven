<script lang="ts">
  import CioPlay from '@codeio/icon/CioPlay.svelte'
  import CioShieldCheck from '@codeio/icon/CioShieldCheck.svelte'
  import { slide } from 'svelte/transition'
  import CardButton from '../shared/CardButton.svelte'
  import CardFoot from '../shared/CardFoot.svelte'
  import CardFrame from '../shared/CardFrame.svelte'
  import CardHead from '../shared/CardHead.svelte'
  import ModelPicker from '../shared/ModelPicker.svelte'
  import { type CardChipData } from '../shared/CardTimer.svelte'
  import { dismissSlide, foldSlide } from '../shared/card-motion'
  import type { ProviderCatalog, ThreadSettings, ThinkingLevel } from '$shared/types'

  interface Props {
    threadTitle: string
    reworkCycle?: number
    settings: ThreadSettings
    providers: ProviderCatalog[]
    projectId?: string | null
    favoriteModels?: string[]
    recentModels?: string[]
    busy?: boolean
    onCancel: () => void
    onAudit: (settings: ThreadSettings) => void
    onModelChange: (settings: ThreadSettings) => void
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
    threadTitle,
    reworkCycle,
    settings,
    providers,
    projectId = null,
    favoriteModels = [],
    recentModels = [],
    busy = false,
    onCancel,
    onAudit,
    onModelChange,
    onToggleFavorite,
    onRemoveRecent,
    onReorderFavorite
  }: Props = $props()
  let folded = $state(false)
  let selected = $derived.by(() => {
    const provider =
      providers.find(
        (candidate) =>
          candidate.id === settings.providerId && candidate.harnessId === settings.harnessId
      ) ?? providers.find((candidate) => candidate.id === settings.providerId)
    const model = provider?.models.find((candidate) => candidate.id === settings.modelId)
    return { provider, model }
  })

  const chip: CardChipData = {
    text: 'No deadline',
    tone: 'paused',
    title: 'Nothing runs until you start the audit'
  }

  function chooseModel(
    providerId: string,
    modelId: string,
    nextHarnessId?: string,
    accountId?: string
  ): void {
    const harnessId = nextHarnessId ?? settings.harnessId
    onModelChange({ ...settings, harnessId, accountId, providerId, modelId })
  }

  function chooseThinking(level: ThinkingLevel): void {
    onModelChange({ ...settings, thinkingLevel: level })
  }

  function chooseRuntime(runtime: import('$shared/types').ModelRuntimeSettings): void {
    onModelChange({ ...settings, ...runtime })
  }
</script>

<div out:slide={dismissSlide()}>
  <CardFrame placement="replace" label="Audit implementation">
    <CardHead
      icon={CioShieldCheck}
      title={reworkCycle
        ? `Rework ${reworkCycle} complete   audit again`
        : 'Implementation finished'}
      {chip}
      bind:folded
      foldLabel="audit offer"
    />

    {#if !folded}
      <div transition:slide={foldSlide()}>
        <div class="flex flex-col gap-1.5 px-3 py-2.5">
          <p class="text-xs leading-relaxed text-muted">
            {reworkCycle ? 'Verify the completed corrections for' : 'Audit'} “{threadTitle}” with
            <span class="font-medium text-foreground">
              {selected.model?.name ?? settings.modelId}
            </span>
            before marking it complete?
          </p>
          <p class="text-[0.6875rem] text-dimmed">
            {selected.provider?.name ?? settings.providerId} / {selected.model?.name ??
              settings.modelId}
          </p>
        </div>

        <CardFoot>
          {#snippet left()}
            <CardButton
              label="Cancel"
              title="Cancel the audit"
              variant="ghost"
              onclick={onCancel}
            />
          {/snippet}
          {#snippet right()}
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
              label="Change"
              variant="action"
              onSelect={chooseModel}
              thinkingLevel={settings.thinkingLevel}
              runtimeSettings={settings}
              onSelectThinking={chooseThinking}
              onSelectRuntime={chooseRuntime}
              {onToggleFavorite}
              {onReorderFavorite}
            />
            <CardButton
              label={reworkCycle ? 'Audit again' : 'Audit'}
              title={reworkCycle ? 'Run the audit again' : 'Run an independent audit'}
              icon={CioPlay}
              variant="primary"
              disabled={busy}
              loading={busy}
              onclick={() => onAudit(settings)}
            />
          {/snippet}
        </CardFoot>
      </div>
    {/if}
  </CardFrame>
</div>
