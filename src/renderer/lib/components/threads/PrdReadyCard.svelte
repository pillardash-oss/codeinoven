<script lang="ts">
  import CioCheck from '@pillardash-oss/cio-icon/CioCheck.svelte'
  import CioExternalLink from '@pillardash-oss/cio-icon/CioExternalLink.svelte'
  import CioFileText from '@pillardash-oss/cio-icon/CioFileText.svelte'
  import { slide } from 'svelte/transition'
  import type { ProviderCatalog, ThreadSettings } from '$shared/types'
  import CardButton from '../shared/CardButton.svelte'
  import CardFoot from '../shared/CardFoot.svelte'
  import CardFrame from '../shared/CardFrame.svelte'
  import CardHead from '../shared/CardHead.svelte'
  import { type CardChipData } from '../shared/CardTimer.svelte'
  import { dismissSlide, foldSlide } from '../shared/card-motion'
  import EngineeringModelSwitch from '../shared/EngineeringModelSwitch.svelte'

  interface Props {
    busy?: boolean
    onReview: () => void
    onFinalize: () => void | Promise<void>
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
    busy = false,
    onReview,
    onFinalize,
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

  let folded = $state(false)

  const chip: CardChipData = {
    text: 'Ready',
    title: 'The PRD draft is ready to review'
  }
</script>

<div out:slide={dismissSlide()}>
  <CardFrame placement="replace" label="PRD ready for review">
    <CardHead
      icon={CioFileText}
      title="PRD ready for review"
      {chip}
      bind:folded
      foldLabel="PRD review"
    />

    {#if !folded}
      <div transition:slide={foldSlide()}>
        <div class="px-3 py-2.5">
          <p class="text-xs leading-relaxed text-muted">
            Review product requirements before finalizing this lifecycle gate.
          </p>
        </div>

        <CardFoot>
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
            <CardButton
              label="Review PRD"
              title="Open the PRD for review"
              icon={CioExternalLink}
              variant="secondary"
              onclick={onReview}
            />
            <CardButton
              label="Finalize PRD"
              title="Approve the PRD"
              icon={CioCheck}
              variant="primary"
              disabled={busy}
              loading={busy}
              onclick={() => void onFinalize()}
            />
          {/snippet}
        </CardFoot>
      </div>
    {/if}
  </CardFrame>
</div>
