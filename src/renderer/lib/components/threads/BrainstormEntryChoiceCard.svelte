<script lang="ts">
  import CioClose from 'cio-icon/CioClose.svelte'
  import CioFileText from 'cio-icon/CioFileText.svelte'
  import CioLightbulb from 'cio-icon/CioLightbulb.svelte'
  import CioSparkles from 'cio-icon/CioSparkles.svelte'
  import { slide } from 'svelte/transition'
  import CardButton from '../shared/CardButton.svelte'
  import CardFoot from '../shared/CardFoot.svelte'
  import CardFrame from '../shared/CardFrame.svelte'
  import CardHead from '../shared/CardHead.svelte'
  import CardOption from '../shared/CardOption.svelte'
  import ModelPicker from '../shared/ModelPicker.svelte'
  import { type CardChipData } from '../shared/CardTimer.svelte'
  import { dismissSlide, foldSlide } from '../shared/card-motion'
  import type { ProviderCatalog, ThreadSettings, ThinkingLevel } from '$shared/types'

  interface Props {
    busy?: boolean
    retryChoice?: 'brainstorm' | 'spec'
    providers?: ProviderCatalog[]
    projectId?: string | null
    settings?: ThreadSettings
    favoriteModels?: string[]
    recentModels?: string[]
    onStartBrainstorm: () => void | Promise<void>
    onJumpToSpec: () => void | Promise<void>
    onModelChange?: (settings: ThreadSettings) => void
    onCancel?: () => void
    /** Dismiss the card and revert an accidental engineering-mode send. */
    onClose?: () => void | Promise<void>
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
    retryChoice,
    providers = [],
    projectId = null,
    settings,
    favoriteModels = [],
    recentModels = [],
    onStartBrainstorm,
    onJumpToSpec,
    onModelChange,
    onCancel,
    onClose,
    onToggleFavorite,
    onRemoveRecent,
    onReorderFavorite
  }: Props = $props()

  let folded = $state(false)

  const chip = $derived<CardChipData>(
    retryChoice
      ? { text: 'Waiting', tone: 'paused', title: 'Planning is paused until you retry' }
      : { text: 'No deadline', tone: 'paused', title: 'Nothing runs until you choose a path' }
  )

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
  <CardFrame placement="replace" label="Choose planning path">
    <CardHead
      icon={CioSparkles}
      title="Plan your work"
      {chip}
      bind:folded
      foldLabel="planning choice"
    >
      {#snippet controls()}
        {#if onClose}
          <button
            type="button"
            class="flex h-6 w-6 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-40"
            title="Close and revert this message to a normal chat draft"
            aria-label="Close and revert this message to a normal chat draft"
            disabled={busy}
            onclick={() => void onClose()}
          >
            <CioClose size={14} />
          </button>
        {/if}
      {/snippet}
    </CardHead>

    {#if !folded}
      <div transition:slide={foldSlide()}>
        <div class="flex flex-col gap-1.5 px-3 py-2.5">
          <p class="text-xs font-semibold text-foreground">
            {retryChoice ? 'Planning paused' : 'How do you want to begin?'}
          </p>
          <p class="text-xs leading-relaxed text-muted">
            {retryChoice
              ? 'The saved planning choice is safe. Retry generation without choosing the path again.'
              : 'Work through an evidence-led conversation with the Sr. Engineer, or move directly to a specification.'}
          </p>
        </div>

        {#if retryChoice}
          <CardFoot>
            {#snippet left()}
              <CardButton
                label="Cancel"
                title="Cancel the planning retry"
                variant="ghost"
                disabled={busy}
                onclick={onCancel}
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
              {:else}
                <CardButton
                  label="Change"
                  title="Choose a model before retrying"
                  variant="secondary"
                  disabled
                />
              {/if}
              <CardButton
                label={retryChoice === 'brainstorm' ? 'Retry brainstorm' : 'Retry specification'}
                title={retryChoice === 'brainstorm'
                  ? 'Retry generating the brainstorm'
                  : 'Retry generating the specification'}
                icon={busy ? undefined : retryChoice === 'brainstorm' ? CioLightbulb : CioFileText}
                variant="primary"
                disabled={busy}
                loading={busy}
                onclick={() =>
                  void (retryChoice === 'brainstorm' ? onStartBrainstorm() : onJumpToSpec())}
              />
            {/snippet}
          </CardFoot>
        {:else}
          <div class="flex flex-col gap-1.5 border-t border-border p-2.5">
            <CardOption
              title="Start brainstorm"
              description="Research the real context, answer focused questions, and align the direction before the spec."
              badge={{ text: 'Recommended', tone: 'ok' }}
              disabled={busy}
              onclick={() => void onStartBrainstorm()}
            />
            <CardOption
              title="Jump into spec"
              description="Skip brainstorming and ask the Sr. Engineer to prepare the specification now."
              disabled={busy}
              onclick={() => void onJumpToSpec()}
            />
          </div>
        {/if}
      </div>
    {/if}
  </CardFrame>
</div>
