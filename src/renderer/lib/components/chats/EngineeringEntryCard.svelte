<script lang="ts">
  import { FileText, Lightbulb, PenLine } from '@lucide/svelte'
  import type { ProviderCatalog, ThreadSettings } from '$shared/types'
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

  const label = $derived(target === 'prd' ? 'PRD' : 'Spec')
</script>

<section
  class="rounded-2xl border bg-surface p-4 shadow-sm"
  aria-labelledby="engineering-entry-title"
>
  <h2 id="engineering-entry-title" class="text-sm font-semibold text-foreground">
    Engineer this message
  </h2>
  <p class="mt-1 text-xs leading-5 text-muted">
    Explore the direction with a Brainstorm first, or jump straight into the {label} using the message
    you typed.
  </p>
  <div class="mt-4 grid gap-2 sm:grid-cols-2">
    <button
      type="button"
      class="rounded-xl bg-thread-spec px-3 py-2.5 text-left text-xs font-medium text-foreground disabled:opacity-50"
      disabled={busy}
      onclick={() => void onBrainstormFirst()}
    >
      <span class="flex items-center gap-2">
        <Lightbulb size={14} class="shrink-0" />
        Brainstorm first
      </span>
    </button>
    <button
      type="button"
      class="rounded-xl border px-3 py-2.5 text-left text-xs font-medium text-foreground hover:bg-elevated disabled:opacity-50"
      disabled={busy}
      onclick={() => void onJumpIn()}
    >
      <span class="flex items-center gap-2">
        <PenLine size={14} class="shrink-0" />
        {target === 'prd' ? 'Start PRD' : 'Jump into Spec'}
      </span>
    </button>
  </div>
  <div class="mt-3 flex items-center justify-between gap-2">
    <p class="flex min-w-0 items-center gap-1.5 text-[0.6875rem] text-muted">
      <FileText size={12} class="shrink-0" />
      Jumping in still lets the Sr. Engineer ask alignment questions — it just skips the Brainstorm
      document.
    </p>
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
  </div>
</section>
