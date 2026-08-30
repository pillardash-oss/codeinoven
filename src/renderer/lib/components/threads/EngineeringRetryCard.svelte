<script lang="ts">
  import { Loader2, RefreshCw, TriangleAlert } from '@lucide/svelte'
  import ModelPicker from '../shared/ModelPicker.svelte'
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

  const STAGE_LABELS: Record<EngineeringLifecycleStage, string> = {
    brainstorm: 'Brainstorm',
    prd: 'PRD',
    spec: 'Spec',
    assignment: 'Assignment',
    achievement: 'Achievement'
  }

  const stageLabel = $derived(stage === undefined ? 'Engineering' : (STAGE_LABELS[stage] ?? 'Engineering'))

  function chooseModel(providerId: string, modelId: string, nextHarnessId?: string): void {
    if (!settings) return
    onModelChange?.({
      ...settings,
      harnessId: nextHarnessId ?? settings.harnessId,
      providerId,
      modelId
    })
  }

  function chooseThinking(level: ThinkingLevel): void {
    if (!settings) return
    onModelChange?.({ ...settings, thinkingLevel: level })
  }
</script>

<section
  class="overflow-hidden rounded-xl border border-danger/30 bg-surface shadow-sm"
  aria-label="Retry failed Engineering stage"
>
  <div class="flex items-center gap-2 border-b border-danger/20 bg-danger/5 px-4 py-2.5">
    <TriangleAlert size={15} class="shrink-0 text-danger" />
    <p class="truncate text-xs font-semibold uppercase tracking-wide text-danger">
      {stageLabel} failed
    </p>
  </div>

  <div class="space-y-1.5 p-4">
    <p class="text-sm font-semibold text-foreground">The {stageLabel} stage could not complete</p>
    <p class="text-xs leading-relaxed text-muted">
      {failure?.trim() || 'The stage stopped with an error. Retry it from where it stopped — completed progress and context are preserved.'}
    </p>
  </div>

  <div class="flex items-center justify-between gap-2 border-t px-4 py-2.5">
    <button
      type="button"
      class="min-h-8 rounded-lg px-3 py-1.5 text-xs font-semibold text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-40"
      title="Stop the Engineering lifecycle and return to the stage card"
      aria-label="Stop the Engineering lifecycle and return to the stage card"
      disabled={busy}
      onclick={() => void onCancel()}
    >
      Cancel
    </button>
    <div class="flex items-center gap-2">
      {#if settings}
        <ModelPicker
          {providers}
          {projectId}
          harnessId={settings.harnessId}
          providerId={settings.providerId}
          modelId={settings.modelId}
          {favoriteModels}
          {recentModels}
          {onRemoveRecent}
          side="top"
          label="Change model"
          variant="action"
          onSelect={chooseModel}
          thinkingLevel={settings.thinkingLevel}
          onSelectThinking={chooseThinking}
          {onToggleFavorite}
          {onReorderFavorite}
        />
      {:else}
        <button
          type="button"
          class="flex min-h-8 items-center gap-1 rounded-lg border bg-elevated px-3 py-1.5 text-xs font-semibold text-muted disabled:opacity-40"
          title="Choose a model before retrying"
          aria-label="Choose a model before retrying"
          disabled
        >
          Change model
        </button>
      {/if}
      <button
        type="button"
        class="flex min-h-8 items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-on-primary transition-opacity hover:opacity-90 disabled:opacity-40"
        title="Retry the failed {stageLabel} stage with the selected model"
        aria-label="Retry the failed {stageLabel} stage with the selected model"
        disabled={busy}
        onclick={() => void onRetry()}
      >
        {#if busy}
          <Loader2 size={13} class="animate-spin" />
          Retrying…
        {:else}
          <RefreshCw size={13} />
          Retry stage
        {/if}
      </button>
    </div>
  </div>
</section>
