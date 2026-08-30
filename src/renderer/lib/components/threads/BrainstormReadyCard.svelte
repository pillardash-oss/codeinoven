<script lang="ts">
  import { ArrowRight, Lightbulb } from '@lucide/svelte'
  import type { BrainstormPrototype, ProviderCatalog, ThreadSettings } from '$shared/types'
  import EngineeringModelSwitch from '../shared/EngineeringModelSwitch.svelte'

  interface Props {
    version: number
    busy?: boolean
    onReview: () => void
    onFinalize: () => void
    prototypes?: BrainstormPrototype[]
    onContinueWithoutHifi?: () => void
    onOpenPrototype?: (previewPath: string) => CallbackResult
    finalizeLabel?: string
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
    version,
    busy = false,
    onReview,
    onFinalize,
    prototypes = [],
    onContinueWithoutHifi,
    onOpenPrototype,
    finalizeLabel = 'Prepare spec',
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

  type CallbackResult = void | Promise<void>

  let lofiPrototypes = $derived(prototypes.filter((prototype) => prototype.fidelity === 'lofi'))
  let hasHifi = $derived(prototypes.some((prototype) => prototype.fidelity === 'hifi'))

  const fidelityLabel = (fidelity: BrainstormPrototype['fidelity']): string =>
    fidelity === 'hifi' ? 'HiFi' : 'LoFi'
</script>

<section
  class="overflow-hidden rounded-xl border bg-surface shadow-sm"
  aria-label="Brainstorm ready"
>
  <div class="flex items-center gap-2 border-b px-4 py-2.5">
    <Lightbulb size={15} class="shrink-0 text-accent" />
    <p class="truncate text-xs font-semibold uppercase tracking-wide text-muted">
      Session report · Version {version}
    </p>
  </div>

  <div class="space-y-1.5 p-4">
    <p class="text-sm font-semibold text-foreground">Your current alignment is captured.</p>
    <p class="text-xs leading-relaxed text-muted">
      Keep talking to refine the direction, review the concise report, or use it to prepare the
      specification.
    </p>
    {#if prototypes.length > 0}
      <div class="max-h-60 space-y-1 overflow-y-auto pt-1">
        <p class="text-xs font-semibold uppercase tracking-wide text-muted">
          Captured prototypes ({prototypes.length})
        </p>
        {#each prototypes as prototype (prototype.id)}
          <button
            type="button"
            class="flex w-full items-center gap-2 rounded-lg border bg-raised px-3 py-2 text-left hover:bg-elevated disabled:opacity-40"
            title="Open {prototype.title} preview"
            aria-label="Prototype {prototype.id}: {prototype.title}"
            disabled={busy}
            onclick={() => onOpenPrototype?.(prototype.previewPath)}
          >
            <span
              class="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide {'hifi' ===
              prototype.fidelity
                ? 'bg-thread-spec/10 text-thread-spec'
                : 'bg-overlay text-muted'}">{fidelityLabel(prototype.fidelity)}</span
            >
            <span class="truncate text-xs text-foreground">{prototype.title}</span>
          </button>
        {/each}
      </div>
    {/if}
  </div>

  <div class="flex items-center justify-end gap-2 border-t px-4 py-2.5">
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
    {#if lofiPrototypes.length > 0 && !hasHifi && onContinueWithoutHifi}
      <button
        class="min-h-8 rounded-lg px-3 py-1.5 text-xs font-semibold text-muted hover:bg-elevated hover:text-foreground disabled:opacity-40"
        disabled={busy}
        onclick={onContinueWithoutHifi}>Continue without HiFi</button
      >
    {/if}
    <button
      class="min-h-8 rounded-lg border bg-elevated px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:bg-overlay disabled:opacity-40"
      disabled={busy}
      onclick={onReview}
    >
      Review report
    </button>
    <button
      class="flex min-h-8 items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-40"
      disabled={busy}
      onclick={onFinalize}
    >
      {finalizeLabel}
      <ArrowRight size={13} />
    </button>
  </div>
</section>
