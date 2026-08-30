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
    onSelectPrototype?: (prototypeId: string) => void | Promise<void>
    onContinueWithoutHifi?: () => void
    finalizeLabel?: string
    settings?: ThreadSettings
    providers?: ProviderCatalog[]
    projectId?: string | null
    favoriteModels?: string[]
    recentModels?: string[]
    onModelChange?: (settings: ThreadSettings) => void
    onToggleFavorite?: (providerId: string, modelId: string, harnessId: string) => void
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
    onSelectPrototype,
    onContinueWithoutHifi,
    finalizeLabel = 'Prepare spec',
    settings,
    providers = [],
    projectId = null,
    favoriteModels = [],
    recentModels = [],
    onModelChange,
    onToggleFavorite,
    onReorderFavorite
  }: Props = $props()

  let lofiPrototypes = $derived(prototypes.filter((prototype) => prototype.fidelity === 'lofi'))
  let hasHifi = $derived(prototypes.some((prototype) => prototype.fidelity === 'hifi'))
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
    {#if lofiPrototypes.length > 0 && !hasHifi && onSelectPrototype}
      <div class="grid gap-2 pt-2 sm:grid-cols-2">
        {#each lofiPrototypes as prototype (prototype.id)}
          <button
            type="button"
            class="rounded-lg border bg-raised px-3 py-2 text-left hover:bg-elevated disabled:opacity-40"
            disabled={busy}
            onclick={() => void onSelectPrototype?.(prototype.id)}
          >
            <span class="text-xs font-semibold text-thread-spec">{prototype.id}</span>
            <span class="mt-0.5 block text-xs text-foreground"
              >Build HiFi from {prototype.title}</span
            >
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
