<script lang="ts">
  import type { ProviderCatalog, ThreadSettings } from '$shared/types'
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
</script>

<section
  class="rounded-2xl border border-thread-spec/40 bg-surface p-4 shadow-sm"
  aria-labelledby="prd-ready-title"
>
  <h2 id="prd-ready-title" class="text-sm font-semibold text-foreground">PRD ready for review</h2>
  <p class="mt-1 text-xs leading-5 text-muted">
    Review product requirements before finalizing this lifecycle gate.
  </p>
  <div class="mt-4 flex items-center justify-end gap-2">
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
    <button
      type="button"
      class="rounded-lg px-3 py-2 text-xs text-muted hover:bg-elevated hover:text-foreground"
      onclick={onReview}
    >
      Review PRD
    </button>
    <button
      type="button"
      class="rounded-lg bg-thread-spec px-3 py-2 text-xs font-medium text-foreground disabled:opacity-50"
      disabled={busy}
      onclick={() => void onFinalize()}
    >
      Finalize PRD
    </button>
  </div>
</section>
