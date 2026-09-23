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

  /** One fallback row: a model, or an empty slot the user has not filled yet. */
  type FallbackRow = AgentModelSelection | null

  /**
   * What the picker shows while the user works: one primary and one entry per
   * fallback row, empty slots included. Only the filled rows are ever saved.
   */
  interface PickerDraft {
    primary?: AgentModelSelection
    rows: FallbackRow[]
  }

  /**
   * The picker's own last edit, or `null` on first render when the persisted set
   * decides. The parent keys the component on the routine id, so a slow
   * persistence round-trip can never clobber a pick.
   */
  let edited = $state<PickerDraft | null>(null)

  /**
   * Seed the rows from the persisted fallbacks: one row each, plus the
   * `minFallbacks` prompt when fewer are set. Rows keep their position, so a
   * model picked in row 3 stays in row 3 instead of collapsing into an earlier
   * row the way a filtered list would.
   */
  function seedDraft(): PickerDraft {
    const persisted = agents?.fallbacks ?? []
    const rowCount = Math.max(persisted.length, Math.min(minFallbacks, maxFallbacks))
    return {
      ...(agents?.primary ? { primary: { ...agents.primary } } : {}),
      rows: Array.from({ length: rowCount }, (_, index) =>
        index < persisted.length ? { ...persisted[index] } : null
      )
    }
  }

  const draft = $derived(edited ?? seedDraft())

  const canAddFallback = $derived(draft.rows.length < maxFallbacks)
  const filledFallbacks = $derived(
    draft.rows.filter((row): row is AgentModelSelection => row !== null)
  )

  /**
   * Show the draft and hand the saved model set to the caller. The rows are the
   * display grid, so the saved `fallbacks` drop the empty slots while keeping
   * the order the user sees.
   */
  function commit(next: PickerDraft): void {
    edited = next
    onChange({
      ...(next.primary ? { primary: { ...next.primary } } : {}),
      fallbacks: next.rows
        .filter((row): row is AgentModelSelection => row !== null)
        .map((row) => ({ ...row }))
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
    const next: PickerDraft = { rows: draft.rows }
    if (selection) next.primary = selection
    commit(next)
  }

  function setFallback(index: number, selection: AgentModelSelection): void {
    commit({
      ...draft,
      rows: draft.rows.map((row, position) => (position === index ? selection : row))
    })
  }

  function removeFallback(index: number): void {
    const rows = draft.rows.filter((_, position) => position !== index)
    // Dropping an empty row changes nothing the routine runs on, so it stays local.
    if (draft.rows[index] === null) edited = { ...draft, rows }
    else commit({ ...draft, rows })
  }

  /** Add an empty row. Empty rows are never persisted, so this saves nothing. */
  function addFallback(): void {
    if (!canAddFallback) return
    edited = { ...draft, rows: [...draft.rows, null] }
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
    {#each draft.rows as row, index (index)}
      {@const removeLabel = row
        ? `Remove fallback ${index + 1}`
        : `Remove empty fallback slot ${index + 1}`}
      <div class="flex items-center gap-1.5">
        <div class="min-w-0 flex-1">
          <ModelPicker
            {providers}
            {projectId}
            harnessId={row?.harnessId || DEFAULT_HARNESS}
            providerId={row?.providerId ?? ''}
            modelId={row?.modelId ?? ''}
            accountId={row?.accountId}
            favoriteModels={rendererRecovery.favoriteModels}
            recentModels={rendererRecovery.recentModels}
            onRemoveRecent={(key) => rendererRecovery.removeRecentModel(key)}
            side="bottom"
            variant="field"
            fullWidth
            {disabled}
            label={row ? undefined : `Choose fallback ${index + 1}`}
            onSelect={(providerId, modelId, harnessId, accountId) =>
              setFallback(
                index,
                selectionOf(providerId, modelId, harnessId, accountId, row?.thinkingLevel)
              )}
            thinkingLevel={row?.thinkingLevel}
            onSelectThinking={(level) => {
              const current = draft.rows[index]
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
