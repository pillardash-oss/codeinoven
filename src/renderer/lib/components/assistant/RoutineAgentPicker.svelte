<script lang="ts">
  import { Plus, X } from '@lucide/svelte'
  import ModelPicker from '$lib/components/shared/ModelPicker.svelte'
  import { modelKey } from '$lib/model-keys'
  import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
  import type {
    AgentModelSelection,
    ProviderCatalog,
    RoutineAgents,
    ThinkingLevel
  } from '$shared/types'

  interface Props {
    /** Persisted model set; the parent keys this component per routine. */
    agents: RoutineAgents | undefined
    providers: ProviderCatalog[]
    /** Project whose harness catalog the pickers read. */
    projectId?: string | null
    /** Fallback rows shown before the user adds or removes any. */
    minFallbacks?: number
    /** Most fallback rows the picker offers. */
    maxFallbacks?: number
    disabled?: boolean
    /** Fires on every change with the full, already-updated model set. */
    onChange: (agents: RoutineAgents) => void
  }

  let {
    agents,
    providers,
    projectId = null,
    minFallbacks = 2,
    maxFallbacks = 8,
    disabled = false,
    onChange
  }: Props = $props()

  const DEFAULT_HARNESS = 'opencode'

  /**
   * The set this picker shows: its own last edit while the user is working, or
   * the persisted set on first render. The parent keys the component on the
   * routine id, so a slow persistence round-trip can never clobber a pick.
   */
  let edited = $state<RoutineAgents | null>(null)
  const draft = $derived(
    edited ?? {
      ...(agents?.primary ? { primary: { ...agents.primary } } : {}),
      fallbacks: (agents?.fallbacks ?? []).map((fallback) => ({ ...fallback }))
    }
  )

  /**
   * How many fallback rows the picker shows: the count the user last set, or
   * `null` until they touch the list, in which case the `minFallbacks` prompt
   * decides. It never drops below the fallbacks actually set. Empty rows are
   * never persisted.
   */
  let wantedSlots = $state<number | null>(null)
  const fallbackSlots = $derived(
    Math.max(wantedSlots ?? Math.min(minFallbacks, maxFallbacks), draft.fallbacks.length)
  )
  const canAddFallback = $derived(fallbackSlots < maxFallbacks)
  const filledFallbacks = $derived(
    draft.fallbacks.filter((fallback) => fallback.modelId.length > 0)
  )

  function commit(next: RoutineAgents): void {
    edited = next
    onChange({
      ...(next.primary ? { primary: { ...next.primary } } : {}),
      fallbacks: next.fallbacks.map((fallback) => ({ ...fallback }))
    })
  }

  function selectionOf(
    providerId: string,
    modelId: string,
    harnessId: string,
    accountId: string | undefined,
    thinkingLevel: ThinkingLevel | null | undefined
  ): AgentModelSelection {
    return {
      harnessId,
      providerId,
      modelId,
      ...(accountId ? { accountId } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {})
    }
  }

  function setPrimary(selection: AgentModelSelection | undefined): void {
    const next: RoutineAgents = { fallbacks: draft.fallbacks.map((entry) => ({ ...entry })) }
    if (selection) next.primary = selection
    commit(next)
  }

  function setFallback(index: number, selection: AgentModelSelection): void {
    const fallbacks = draft.fallbacks.map((entry) => ({ ...entry }))
    fallbacks[index] = selection
    commit({
      ...(draft.primary ? { primary: draft.primary } : {}),
      fallbacks: fallbacks.filter((entry) => entry.modelId.length > 0)
    })
  }

  function removeFallback(index: number): void {
    const fallbacks = draft.fallbacks
      .filter((_, position) => position !== index)
      .map((entry) => ({ ...entry }))
    // The row count shrinks with the removal, so a removed row really goes away
    // instead of leaving a permanent empty slot behind.
    wantedSlots = Math.max(fallbacks.length, fallbackSlots - 1)
    commit({
      ...(draft.primary ? { primary: { ...draft.primary } } : {}),
      fallbacks
    })
  }

  function addFallback(): void {
    if (!canAddFallback) return
    wantedSlots = fallbackSlots + 1
  }
</script>

<div class="flex flex-col gap-2">
  <div class="flex flex-col gap-1">
    <span class="text-[0.6875rem] font-medium text-muted">Primary model</span>
    <div class="flex items-center gap-1.5">
      <div class="min-w-0 flex-1">
        <ModelPicker
          {providers}
          {projectId}
          harnessId={draft.primary?.harnessId ?? DEFAULT_HARNESS}
          providerId={draft.primary?.providerId ?? ''}
          modelId={draft.primary?.modelId ?? ''}
          accountId={draft.primary?.accountId}
          favoriteModels={rendererRecovery.favoriteModels}
          recentModels={rendererRecovery.recentModels}
          onRemoveRecent={(key) => rendererRecovery.removeRecentModel(key)}
          side="bottom"
          variant="field"
          fullWidth
          {disabled}
          label={draft.primary ? undefined : 'Choose the model that runs this routine'}
          onSelect={(providerId, modelId, harnessId, accountId) =>
            setPrimary(
              selectionOf(providerId, modelId, harnessId, accountId, draft.primary?.thinkingLevel)
            )}
          thinkingLevel={draft.primary?.thinkingLevel}
          onSelectThinking={(level) => {
            const current = draft.primary
            if (!current) return
            setPrimary(
              selectionOf(
                current.providerId,
                current.modelId,
                current.harnessId,
                current.accountId,
                level
              )
            )
          }}
          onToggleFavorite={(providerId, modelId, harnessId) =>
            rendererRecovery.toggleFavorite(modelKey(harnessId, providerId, modelId))}
          onReorderFavorite={(draggedKey, targetKey, position) =>
            rendererRecovery.reorderFavorite(draggedKey, targetKey, position)}
        />
      </div>
      {#if draft.primary}
        <button
          type="button"
          class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-50"
          title="Clear the primary model"
          aria-label="Clear the primary model"
          {disabled}
          onclick={() => setPrimary(undefined)}
        >
          <X size={13} strokeWidth={1.8} />
        </button>
      {/if}
    </div>
  </div>

  <div class="flex flex-col gap-1">
    <span class="text-[0.6875rem] font-medium text-muted">Fallback models</span>
    {#if filledFallbacks.length < minFallbacks}
      <p class="text-[0.625rem] leading-relaxed text-dimmed">
        Add {minFallbacks} fallbacks so a model that fails or hits its limit never stops this routine.
      </p>
    {/if}
    {#each Array.from({ length: fallbackSlots }) as _slot, index (index)}
      {@const fallback = draft.fallbacks[index]}
      {@const removeLabel = fallback?.modelId
        ? `Remove fallback ${index + 1}`
        : `Remove empty fallback slot ${index + 1}`}
      <div class="flex items-center gap-1.5">
        <div class="min-w-0 flex-1">
          <ModelPicker
            {providers}
            {projectId}
            harnessId={fallback?.harnessId || DEFAULT_HARNESS}
            providerId={fallback?.providerId ?? ''}
            modelId={fallback?.modelId ?? ''}
            accountId={fallback?.accountId}
            favoriteModels={rendererRecovery.favoriteModels}
            recentModels={rendererRecovery.recentModels}
            onRemoveRecent={(key) => rendererRecovery.removeRecentModel(key)}
            side="bottom"
            variant="field"
            fullWidth
            {disabled}
            label={fallback?.modelId ? undefined : `Choose fallback ${index + 1}`}
            onSelect={(providerId, modelId, harnessId, accountId) =>
              setFallback(
                index,
                selectionOf(providerId, modelId, harnessId, accountId, fallback?.thinkingLevel)
              )}
            thinkingLevel={fallback?.thinkingLevel}
            onSelectThinking={(level) => {
              const current = draft.fallbacks[index]
              if (!current) return
              setFallback(
                index,
                selectionOf(
                  current.providerId,
                  current.modelId,
                  current.harnessId,
                  current.accountId,
                  level
                )
              )
            }}
            onToggleFavorite={(providerId, modelId, harnessId) =>
              rendererRecovery.toggleFavorite(modelKey(harnessId, providerId, modelId))}
            onReorderFavorite={(draggedKey, targetKey, position) =>
              rendererRecovery.reorderFavorite(draggedKey, targetKey, position)}
          />
        </div>
        <button
          type="button"
          class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-50"
          title={removeLabel}
          aria-label={removeLabel}
          {disabled}
          onclick={() => removeFallback(index)}
        >
          <X size={13} strokeWidth={1.8} />
        </button>
      </div>
    {/each}
    {#if canAddFallback}
      <button
        type="button"
        class="flex items-center gap-1.5 self-start rounded-md px-1.5 py-1 text-[0.6875rem] text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-50"
        title="Add another fallback model"
        aria-label="Add another fallback model"
        {disabled}
        onclick={addFallback}
      >
        <Plus size={12} strokeWidth={1.8} />
        Add fallback
      </button>
    {/if}
  </div>
</div>
