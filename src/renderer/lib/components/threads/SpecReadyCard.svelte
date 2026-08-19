<script lang="ts">
  import { FileText, Play, X } from '@lucide/svelte'
  import ModelPicker from '../shared/ModelPicker.svelte'
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
    onCancel: () => void
    onReview: () => void
    onProceed: () => void
    onGenerateAssignment?: () => void
    onOpenAssignment?: () => void
    onModelChange?: (settings: ThreadSettings) => void
    onToggleFavorite?: (providerId: string, modelId: string, harnessId: string) => void
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
    onCancel,
    onReview,
    onProceed,
    onGenerateAssignment,
    onOpenAssignment,
    onModelChange,
    onToggleFavorite,
    onReorderFavorite
  }: Props = $props()

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
  class="overflow-hidden rounded-xl border bg-surface shadow-sm"
  aria-label="Specification ready"
>
  <div class="flex items-center justify-between gap-3 border-b px-4 py-2.5">
    <div class="flex min-w-0 items-center gap-2">
      <FileText size={15} class="shrink-0 text-accent" />
      <p class="truncate text-xs font-semibold uppercase tracking-wide text-muted">
        Specification ready
      </p>
    </div>
    <button
      class="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-30"
      disabled={busy}
      onclick={onCancel}
      aria-label="Cancel specification review"
      title="Cancel"
    >
      <X size={15} />
    </button>
  </div>

  <div class="space-y-1.5 p-4">
    <p class="text-sm font-semibold text-foreground">The engineering specification is ready.</p>
    <p class="text-xs leading-relaxed text-muted">
      {assignmentMode
        ? 'Review and annotate the persisted spec, then prepare or open its Assignment.'
        : 'Review and annotate the persisted spec, or proceed with the signed version.'}
    </p>
  </div>

  <div class="flex items-center justify-between gap-2 border-t px-4 py-2.5">
    <button
      class="min-h-8 rounded-lg px-3 py-1.5 text-xs font-semibold text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-40"
      disabled={busy}
      onclick={onCancel}
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
          side="top"
          label="Change"
          variant="action"
          onSelect={chooseModel}
          thinkingLevel={settings.thinkingLevel}
          onSelectThinking={chooseThinking}
          {onToggleFavorite}
          {onReorderFavorite}
        />
      {:else}
        <button
          class="flex min-h-8 items-center gap-1 rounded-lg border bg-elevated px-3 py-1.5 text-xs font-semibold text-muted disabled:opacity-40"
          disabled
          title="Choose a model before proceeding"
        >
          Change
        </button>
      {/if}
      <button
        class="min-h-8 rounded-lg border bg-elevated px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:bg-overlay disabled:opacity-40"
        disabled={busy}
        onclick={onReview}
      >
        Review spec
      </button>
      {#if assignmentMode}
        <button
          class="flex min-h-8 items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-on-primary transition-opacity hover:opacity-90 disabled:opacity-40"
          disabled={busy}
          onclick={assignmentAvailable ? onOpenAssignment : onGenerateAssignment}
        >
          {assignmentAvailable ? 'View Assignment' : 'Generate Assignment'}
          <Play size={13} />
        </button>
      {:else}
        <button
          class="flex min-h-8 items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-on-primary transition-opacity hover:opacity-90 disabled:opacity-40"
          disabled={busy}
          onclick={onProceed}
        >
          Implement
          <Play size={13} />
        </button>
      {/if}
    </div>
  </div>
</section>
