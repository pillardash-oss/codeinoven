<script lang="ts">
  import { Check, Eye } from '@lucide/svelte'
  import ModelPicker from '../shared/ModelPicker.svelte'
  import Switch from '../ui/Switch.svelte'
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
</script>

<div
  class="mx-3 mt-2.5 rounded-xl border border-primary/30 bg-primary/5 p-4"
  role="dialog"
  aria-label="Pick a vision model to describe this image"
>
  <div class="flex items-start gap-2.5">
    <div class="mt-0.5 shrink-0 rounded-lg bg-primary/10 p-1.5 text-primary">
      <Eye size={15} />
    </div>
    <div class="min-w-0 flex-1">
      <p class="text-sm font-semibold text-foreground">This model can't see images</p>
      <p class="mt-1 text-xs leading-relaxed text-muted">
        You're about to send an image to a model without vision capability. Image Descriptor is a
        tool the model can call to describe the image for it but you need to pick the vision model
        that does the describing.
      </p>
    </div>
  </div>
  <div class="mt-3 flex flex-wrap items-center gap-2">
    <button
      type="button"
      class="flex h-9 items-center gap-1.5 rounded-lg border bg-elevated px-3 text-xs font-medium hover:bg-overlay"
      title="Cancel and keep your message and attachment"
      onclick={onCancel}
    >
      Cancel
    </button>
    <div class="min-w-0 flex-1">
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
        onSelectThinking={(level: ThinkingLevel) => {
          if (!visionSelection) return
          visionSelection = { ...visionSelection, thinkingLevel: level }
        }}
        {onToggleFavorite}
        {onReorderFavorite}
      />
    </div>
    <button
      type="button"
      class="flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
      title="Send the image and describe it with the selected vision model"
      disabled={!visionSelection}
      onclick={onConfirm}
    >
      <Check size={13} /> Continue
    </button>
  </div>
  {#if !visionSelection}
    <p class="mt-1.5 text-[0.6875rem] text-dimmed">
      No vision model selected Continue is disabled until you pick one.
    </p>
  {/if}
  <div class="mt-3 flex justify-start">
    <Switch
      bind:checked={donotAsk}
      label="Don't ask again"
      aria-label="Don't ask again for this vision model"
    />
  </div>
</div>
