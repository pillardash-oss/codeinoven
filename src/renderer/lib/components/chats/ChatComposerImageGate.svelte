<script lang="ts">
  import CioCheck from 'cio-icon/CioCheck.svelte'
  import CioClose from 'cio-icon/CioClose.svelte'
  import CioEye from 'cio-icon/CioEye.svelte'
  import { slide } from 'svelte/transition'
  import CardHead from '../shared/CardHead.svelte'
  import CardFoot from '../shared/CardFoot.svelte'
  import CardButton from '../shared/CardButton.svelte'
  import ModelPicker from '../shared/ModelPicker.svelte'
  import Switch from '../ui/Switch.svelte'
  import { foldSlide } from '../shared/card-motion'
  import type { AgentModelSelection, ProviderCatalog, ThinkingLevel } from '$shared/types'

  interface Props {
    providers: ProviderCatalog[]
    projectId?: string | null
    /** Harness used when neither the staged selection nor the catalog names one. */
    harnessId: string
    /** Vision model the user staged for this send; bound so the host can persist it. */
    visionSelection: AgentModelSelection | null
    /** "Don't ask again" flag staged for this send. */
    donotAsk: boolean
    favoriteModels?: string[]
    recentModels?: string[]
    onRemoveRecent?: (modelKey: string) => void
    onToggleFavorite?: (providerId: string, modelId: string, harnessId: string) => void
    onReorderFavorite?: (
      draggedKey: string,
      targetKey: string,
      position: 'before' | 'after'
    ) => void
    onCancel: () => void
    onConfirm: () => void
  }

  let {
    providers,
    projectId = null,
    harnessId,
    visionSelection = $bindable(),
    donotAsk = $bindable(),
    favoriteModels = [],
    recentModels = [],
    onRemoveRecent,
    onToggleFavorite,
    onReorderFavorite,
    onCancel,
    onConfirm
  }: Props = $props()

  let folded = $state(false)
</script>

<!-- A gate that lives inside the composer: no frame of its own, a dashed rule
that hands the eye down to the writing surface. The head, the body and the foot
are the shared card shape. -->
<div
  class="border-b border-dashed border-border-strong bg-transparent"
  role="dialog"
  aria-label="Pick a vision model to describe this image"
>
  <CardHead
    icon={CioEye}
    title="This model can't see images"
    chip={{ text: 'Waiting', tone: 'paused' }}
    bind:folded
    foldLabel="This model can't see images"
  />

  {#if !folded}
    <div transition:slide={foldSlide()}>
      <div class="flex flex-col gap-2 px-3 py-2.5">
        <p class="text-xs leading-relaxed text-muted">
          You're about to send an image to a model without vision capability. The
          <span class="font-mono">cio:see-image</span> utility is a tool the model can call to describe
          the image for it, but you need to pick the vision model that does the describing.
        </p>
        <ModelPicker
          {providers}
          {projectId}
          harnessId={visionSelection?.harnessId ?? providers[0]?.harnessId ?? harnessId}
          providerId={visionSelection?.providerId ?? ''}
          modelId={visionSelection?.modelId ?? ''}
          accountId={visionSelection?.accountId}
          {favoriteModels}
          {recentModels}
          {onRemoveRecent}
          visionOnly
          side="top"
          variant="field"
          label={visionSelection ? undefined : 'Choose a vision model'}
          onSelect={(providerId, modelId, harnessId, accountId) => {
            visionSelection = { harnessId, providerId, modelId, accountId }
          }}
          thinkingLevel={visionSelection?.thinkingLevel}
          runtimeSettings={visionSelection ?? undefined}
          onSelectRuntime={(runtime) => {
            if (visionSelection) visionSelection = { ...visionSelection, ...runtime }
          }}
          onSelectThinking={(level: ThinkingLevel) => {
            if (!visionSelection) return
            visionSelection = { ...visionSelection, thinkingLevel: level }
          }}
          {onToggleFavorite}
          {onReorderFavorite}
        />
        {#if !visionSelection}
          <p class="text-[0.6875rem] text-dimmed">
            No vision model selected. Continue is disabled until you pick one.
          </p>
        {/if}
        <div class="flex justify-start">
          <Switch
            bind:checked={donotAsk}
            label="Don't ask again"
            aria-label="Don't ask again for this vision model"
          />
        </div>
      </div>

      <CardFoot>
        {#snippet left()}
          <CardButton
            variant="ghost"
            label="Cancel"
            title="Cancel and keep your message and attachment"
            icon={CioClose}
            onclick={onCancel}
          />
        {/snippet}

        {#snippet right()}
          <CardButton
            variant="primary"
            label="Continue"
            title="Send the image and describe it with the selected vision model"
            icon={CioCheck}
            disabled={!visionSelection}
            onclick={onConfirm}
          />
        {/snippet}
      </CardFoot>
    </div>
  {/if}
</div>
