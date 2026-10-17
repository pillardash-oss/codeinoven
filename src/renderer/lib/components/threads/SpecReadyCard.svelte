<script lang="ts">
  import CioClose from '$lib/components/icons/cio/CioClose.svelte'
  import CioListChecks from '$lib/components/icons/cio/CioListChecks.svelte'
  import CioPlay from '$lib/components/icons/cio/CioPlay.svelte'
  import CioTools from '$lib/components/icons/cio/CioTools.svelte'
  import { slide } from 'svelte/transition'
  import CardButton from '../shared/CardButton.svelte'
  import CardFoot from '../shared/CardFoot.svelte'
  import CardFrame from '../shared/CardFrame.svelte'
  import CardHead from '../shared/CardHead.svelte'
  import CardNotice from '../shared/CardNotice.svelte'
  import ModelPicker from '../shared/ModelPicker.svelte'
  import { type CardChipData } from '../shared/CardTimer.svelte'
  import { dismissSlide, foldSlide } from '../shared/card-motion'
  import type { ProviderCatalog, ThreadSettings, ThinkingLevel } from '$shared/types'

  interface Props {
    providers?: ProviderCatalog[]
    projectId?: string | null
    settings?: ThreadSettings
    favoriteModels?: string[]
    recentModels?: string[]
    busy?: boolean
    assignmentMode?: boolean
    assignmentAvailable?: boolean
    /** Spec-less Assignment entry: this thread has no Spec, so the card offers
     *  generating the Assignment from the conversation and never mentions a
     *  specification it cannot show. */
    specless?: boolean
    /** Failure from the last spec or Assignment generation attempt. */
    error?: string
    onCancel: () => void
    onReview: () => void
    onProceed: () => void
    onGenerateAssignment?: () => void
    onOpenAssignment?: () => void
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
    providers = [],
    projectId = null,
    settings,
    favoriteModels = [],
    recentModels = [],
    busy = false,
    assignmentMode = false,
    assignmentAvailable = false,
    specless = false,
    error = '',
    onCancel,
    onReview,
    onProceed,
    onGenerateAssignment,
    onOpenAssignment,
    onModelChange,
    onToggleFavorite,
    onRemoveRecent,
    onReorderFavorite
  }: Props = $props()

  let folded = $state(false)

  const chip = $derived<CardChipData>(
    specless
      ? { text: 'No deadline', tone: 'paused', title: 'Nothing runs until you send work' }
      : { text: 'Ready', title: 'The specification is ready to review' }
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
  <CardFrame placement="replace" label={specless ? 'Assignment' : 'Specification ready'}>
    <CardHead
      icon={specless ? CioListChecks : CioTools}
      title={specless ? 'Assignment' : 'Specification ready'}
      {chip}
      bind:folded
      foldLabel={specless ? 'Assignment entry' : 'specification'}
    >
      {#snippet controls()}
        <button
          type="button"
          class="flex h-6 w-6 shrink-0 items-center justify-center text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-30"
          disabled={busy}
          onclick={onCancel}
          aria-label={specless ? 'Dismiss Assignment entry' : 'Cancel specification review'}
          title="Cancel"
        >
          <CioClose size={14} />
        </button>
      {/snippet}
    </CardHead>

    {#if !folded}
      <div transition:slide={foldSlide()}>
        <div class="flex flex-col gap-1.5 px-3 py-2.5">
          {#if specless}
            <p class="text-xs font-semibold text-foreground">No specification for this thread.</p>
            <p class="text-xs leading-relaxed text-muted">
              Send the work you want assigned. The Sr. Engineer breaks it into tasks with their own
              worker threads you can follow and chat with independently, and it asks you the missing
              questions first whenever your message and this conversation cannot carry a task graph
              yet.
            </p>
          {:else}
            <p class="text-xs font-semibold text-foreground">
              The engineering specification is ready.
            </p>
            <p class="text-xs leading-relaxed text-muted">
              {assignmentMode
                ? 'Review and annotate the persisted spec, then prepare or open its Assignment.'
                : 'Review and annotate the persisted spec, or proceed with the signed version.'}
            </p>
          {/if}
          {#if error}
            <CardNotice tone="danger">{error}</CardNotice>
          {/if}
        </div>

        <CardFoot>
          {#snippet left()}
            <CardButton
              label="Cancel"
              title="Cancel specification review"
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
                title="Choose a model before proceeding"
                variant="secondary"
                disabled
              />
            {/if}
            {#if !specless}
              <CardButton
                label="Review spec"
                title="Review the specification"
                variant="secondary"
                disabled={busy}
                onclick={onReview}
              />
            {/if}
            {#if assignmentMode}
              <CardButton
                label={assignmentAvailable ? 'View Assignment' : 'Generate Assignment'}
                title={assignmentAvailable
                  ? 'Open the existing Assignment'
                  : 'Generate the Assignment from this thread'}
                icon={CioPlay}
                variant="primary"
                disabled={busy}
                loading={busy}
                onclick={assignmentAvailable ? onOpenAssignment : onGenerateAssignment}
              />
            {:else}
              <CardButton
                label="Implement"
                title="Implement this specification"
                icon={CioPlay}
                variant="primary"
                disabled={busy}
                loading={busy}
                onclick={onProceed}
              />
            {/if}
          {/snippet}
        </CardFoot>
      </div>
    {/if}
  </CardFrame>
</div>
