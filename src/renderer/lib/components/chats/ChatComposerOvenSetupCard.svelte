<script lang="ts">
  import CioDownload from '@pdslng/cio-icon/CioDownload.svelte'
  import CioFolderGit from '@pdslng/cio-icon/CioFolderGit.svelte'
  import CioServer from '@pdslng/cio-icon/CioServer.svelte'
  import CioTerminal from '@pdslng/cio-icon/CioTerminal.svelte'
  import type { Component } from 'svelte'
  import { slide } from 'svelte/transition'
  import CardButton from '../shared/CardButton.svelte'
  import CardFoot from '../shared/CardFoot.svelte'
  import CardFrame from '../shared/CardFrame.svelte'
  import CardHead from '../shared/CardHead.svelte'
  import ModelPicker from '../shared/ModelPicker.svelte'
  import { type CardChipData } from '../shared/CardTimer.svelte'
  import { dismissSlide, foldSlide } from '../shared/card-motion'
  import type { ProviderCatalog, ThreadSettings, ThinkingLevel } from '$shared/types'

  /**
   * One piece of work the app performs on the Oven before the turn can stream.
   *
   * They are listed rather than described because they are independent and run at
   * the same time: the reader has to see all three before they agree to them.
   */
  interface OvenSetupWork {
    icon: Component
    label: string
  }

  interface Props {
    /** The harness the Oven does not have yet. */
    harnessName: string
    /** The Oven that will be prepared, by its own name. */
    ovenName: string
    /** The checkout that gets cloned; empty when no project names one. */
    projectName?: string
    /** True while the turn is being dispatched, so the card cannot be answered twice. */
    busy?: boolean
    providers?: ProviderCatalog[]
    projectId?: string | null
    /** The composer's live settings, so the picker reads what the send will use. */
    settings: ThreadSettings
    favoriteModels?: string[]
    recentModels?: string[]
    onModelChange?: (settings: ThreadSettings) => void
    /** Drop the held send and go back to the draft, which never left the composer. */
    onCancel: () => void
    /** Let the send through, so the Oven is prepared and the message dispatched. */
    onProceed: () => void
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
    harnessName,
    ovenName,
    projectName = '',
    busy = false,
    providers = [],
    projectId = null,
    settings,
    favoriteModels = [],
    recentModels = [],
    onModelChange,
    onCancel,
    onProceed,
    onToggleFavorite,
    onRemoveRecent,
    onReorderFavorite
  }: Props = $props()

  let folded = $state(false)

  const chip = $derived<CardChipData>({
    text: 'Needs setup',
    tone: 'paused',
    title: `${harnessName} is not installed on ${ovenName}`,
    label: `Needs setup: ${harnessName} is not installed on ${ovenName}`
  })

  /** The work the Oven does before the turn: all of it, started together. */
  const work = $derived<OvenSetupWork[]>([
    { icon: CioDownload, label: `Install ${harnessName} on ${ovenName}` },
    { icon: CioTerminal, label: `Install git on ${ovenName} if it is missing` },
    // A chat has no repository to clone: its directory is created quietly, so a
    // clone row here would promise work that never happens.
    ...(projectName ? [{ icon: CioFolderGit, label: `Clone ${projectName} to the Oven` }] : [])
  ])

  function chooseModel(
    providerId: string,
    modelId: string,
    nextHarnessId?: string,
    accountId?: string
  ): void {
    onModelChange?.({
      ...settings,
      harnessId: nextHarnessId ?? settings.harnessId,
      accountId,
      providerId,
      modelId
    })
  }

  function chooseThinking(level: ThinkingLevel): void {
    onModelChange?.({ ...settings, thinkingLevel: level })
  }

  function chooseRuntime(runtime: import('$shared/types').ModelRuntimeSettings): void {
    onModelChange?.({ ...settings, ...runtime })
  }
</script>

<!-- A card that lives where the composer does: the send is held behind it, so it
     wears the frame of the card that takes the composer's place. The composer
     below carries the join, so the card drops its own bottom rule. -->
<div out:slide={dismissSlide()}>
  <CardFrame placement="replace" label="Prepare this Oven" joinsBelow>
    <CardHead
      icon={CioServer}
      title="Prepare this Oven"
      {chip}
      bind:folded
      foldLabel="Oven setup"
    />

    {#if !folded}
      <div transition:slide={foldSlide()}>
        <div class="flex flex-col gap-1.5 px-3 py-2.5">
          <p class="text-xs font-semibold text-foreground">
            {harnessName} is not installed on {ovenName}
          </p>
          <p class="text-xs leading-relaxed text-muted">
            Sending now prepares the Oven first. These run at the same time, and nothing runs on
            {ovenName} until you proceed.
          </p>
          <ul class="mt-1 flex flex-col gap-1.5">
            {#each work as step (step.label)}
              {@const Icon = step.icon}
              <li class="flex min-w-0 items-center gap-2 text-xs text-muted">
                <Icon size={12} class="shrink-0 text-dimmed" />
                <span class="min-w-0 truncate">{step.label}</span>
              </li>
            {/each}
          </ul>
        </div>

        <CardFoot yields="right">
          {#snippet left()}
            <CardButton
              label="Cancel"
              title="Keep this message as a draft and close the card"
              variant="ghost"
              disabled={busy}
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
              label="Install and send"
              title={`Install ${harnessName} on ${ovenName}, clone the project, and send this message`}
              icon={CioDownload}
              variant="primary"
              disabled={busy}
              loading={busy}
              onclick={onProceed}
            />
          {/snippet}
        </CardFoot>
      </div>
    {/if}
  </CardFrame>
</div>
