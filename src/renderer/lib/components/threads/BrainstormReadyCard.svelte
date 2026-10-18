<script lang="ts">
  import CioLightbulb from '@pillardash-oss/cio-icon/CioLightbulb.svelte'
  import { slide } from 'svelte/transition'
  import type { BrainstormPrototype, ProviderCatalog, ThreadSettings } from '$shared/types'
  import BrainstormNextStepMenu from '../shared/BrainstormNextStepMenu.svelte'
  import type { BrainstormNextStep } from '../shared/BrainstormNextStepMenu.svelte'
  import CardButton from '../shared/CardButton.svelte'
  import CardFoot from '../shared/CardFoot.svelte'
  import CardFrame from '../shared/CardFrame.svelte'
  import CardHead from '../shared/CardHead.svelte'
  import CardTag from '../shared/CardTag.svelte'
  import { type CardChipData } from '../shared/CardTimer.svelte'
  import { dismissSlide, foldSlide } from '../shared/card-motion'
  import EngineeringModelSwitch from '../shared/EngineeringModelSwitch.svelte'

  interface Props {
    version: number
    busy?: boolean
    onReview: () => void
    onNextStep: (step: BrainstormNextStep) => CallbackResult
    prototypes?: BrainstormPrototype[]
    onOpenPrototype?: (previewPath: string) => CallbackResult
    settings?: ThreadSettings
    providers?: ProviderCatalog[]
    projectId?: string | null
    favoriteModels?: string[]
    recentModels?: string[]
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
    version,
    busy = false,
    onReview,
    onNextStep,
    prototypes = [],
    onOpenPrototype,
    settings,
    providers = [],
    projectId = null,
    favoriteModels = [],
    recentModels = [],
    onModelChange,
    onToggleFavorite,
    onRemoveRecent,
    onReorderFavorite
  }: Props = $props()

  type CallbackResult = void | Promise<void>

  let folded = $state(false)

  const chip: CardChipData = {
    text: 'Ready',
    title: 'The brainstorm report is ready to read'
  }

  const fidelityLabel = (fidelity: BrainstormPrototype['fidelity']): string =>
    fidelity === 'hifi' ? 'HiFi' : 'LoFi'
</script>

<div out:slide={dismissSlide()}>
  <CardFrame placement="replace" label="Brainstorm ready">
    <CardHead
      icon={CioLightbulb}
      title="Session report · Version {version}"
      {chip}
      bind:folded
      foldLabel="brainstorm report"
    />

    {#if !folded}
      <div transition:slide={foldSlide()}>
        <div class="flex flex-col gap-1.5 px-3 py-2.5">
          <p class="text-xs font-semibold text-foreground">Your current alignment is captured.</p>
          <p class="text-xs leading-relaxed text-muted">
            Keep talking to refine the direction, review the concise report, or choose what to build
            next.
          </p>
          {#if prototypes.length > 0}
            <div class="max-h-60 space-y-1 overflow-y-auto pt-1">
              <p class="text-[0.6875rem] font-semibold text-muted">
                Captured prototypes ({prototypes.length})
              </p>
              {#each prototypes as prototype (prototype.id)}
                <button
                  type="button"
                  class="flex w-full items-center gap-2 border border-border bg-raised px-3 py-2 text-left hover:bg-elevated disabled:opacity-40"
                  title="Open {prototype.title} preview"
                  aria-label="Prototype {prototype.id}: {prototype.title}"
                  disabled={busy}
                  onclick={() => onOpenPrototype?.(prototype.previewPath)}
                >
                  <CardTag
                    text={fidelityLabel(prototype.fidelity)}
                    tone={prototype.fidelity === 'hifi' ? 'info' : 'default'}
                  />
                  <span class="truncate text-xs text-foreground">{prototype.title}</span>
                </button>
              {/each}
            </div>
          {/if}
        </div>

        <CardFoot>
          {#snippet left()}
            <CardButton
              label="Review report"
              title="Review the brainstorm report"
              variant="secondary"
              disabled={busy}
              onclick={onReview}
            />
          {/snippet}
          {#snippet right()}
            <EngineeringModelSwitch
              {settings}
              {providers}
              {projectId}
              {favoriteModels}
              {recentModels}
              {onRemoveRecent}
              {onModelChange}
              {onToggleFavorite}
              {onReorderFavorite}
            />
            <BrainstormNextStepMenu {busy} onNextStep={(step) => void onNextStep(step)} />
          {/snippet}
        </CardFoot>
      </div>
    {/if}
  </CardFrame>
</div>
