<script lang="ts">
  import CioFileText from '@pillardash-oss/cio-icon/CioFileText.svelte'
  import CioLightbulb from '@pillardash-oss/cio-icon/CioLightbulb.svelte'
  import CioPencil from '@pillardash-oss/cio-icon/CioPencil.svelte'
  import CioTabGit from '@pillardash-oss/cio-icon/CioTabGit.svelte'
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
    /** Which document the "Jump directly into…" choice produces. */
    target: 'prd' | 'spec'
    busy?: boolean
    onBrainstormFirst: () => void | Promise<void>
    onJumpIn: () => void | Promise<void>
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
    target,
    busy = false,
    onBrainstormFirst,
    onJumpIn,
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

  const label = $derived(target === 'prd' ? 'PRD' : 'Spec')

  const chip: CardChipData = {
    text: 'No deadline',
    tone: 'paused',
    title: 'Nothing runs until you choose a path'
  }
</script>

<div out:slide={dismissSlide()}>
  <CardFrame placement="replace" label="Engineer this message">
    <CardHead
      icon={CioTabGit}
      title="Engineer this message"
      {chip}
      bind:folded
      foldLabel="engineering entry"
    />

    {#if !folded}
      <div transition:slide={foldSlide()}>
        <div class="flex flex-col gap-1.5 px-3 py-2.5">
          <p class="text-xs leading-relaxed text-muted">
            Explore the direction with a Brainstorm first, or jump straight into the {label} using the
            message you typed.
          </p>
          <p class="flex min-w-0 items-center gap-1.5 text-[0.6875rem] leading-relaxed text-dimmed">
            <CioFileText size={12} class="shrink-0" />
            Jumping in still lets the Sr. Engineer ask alignment questions it just skips the Brainstorm
            document.
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
              label="Brainstorm first"
              title="Explore the direction with a Brainstorm first"
              icon={CioLightbulb}
              variant="secondary"
              disabled={busy}
              loading={busy}
              onclick={() => void onBrainstormFirst()}
            />
            <CardButton
              label={target === 'prd' ? 'Start PRD' : 'Jump into Spec'}
              title={target === 'prd'
                ? 'Jump straight into the PRD using this message'
                : 'Jump straight into the Spec using this message'}
              icon={CioPencil}
              variant="primary"
              disabled={busy}
              loading={busy}
              onclick={() => void onJumpIn()}
            />
          {/snippet}
        </CardFoot>
      </div>
    {/if}
  </CardFrame>
</div>
