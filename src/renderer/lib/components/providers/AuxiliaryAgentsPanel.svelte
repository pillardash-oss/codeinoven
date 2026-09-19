<script lang="ts">
  import { Cpu, Loader2, X } from '@lucide/svelte'
  import { onMount } from 'svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { modelKey } from '$lib/model-keys'
  import { harnessAccountCache } from '$lib/stores/harness-accounts'
  import { providerStore } from '$lib/stores/providers.svelte'
  import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
  import { reportError } from '$lib/stores/app-errors.svelte'
  import { auxiliarySelectionFor } from '$shared/auxiliary-agents'
  import { INBOX_PROJECT_ID } from '$shared/types'
  import AgentIcon from '$lib/agent-icons/AgentIcon.svelte'
  import type {
    AgentModelSelection,
    AuxiliaryAgentConfig,
    ProviderCatalog,
    ThinkingLevel
  } from '$shared/types'
  import ModelPicker from '../shared/ModelPicker.svelte'
  import EmptyState from '../ui/EmptyState.svelte'
  import { harnessName, harnessOrder } from '../shared/model-picker-helpers'

  interface AuxiliaryRow {
    id: string
    name: string
    installed: boolean
  }

  let auxiliaryAgents = $state<AuxiliaryAgentConfig>({})
  let catalogs = $state<ProviderCatalog[]>([])
  /** Per-row "Runs on" harness override, keyed by the row's harness id. */
  let runsOn = $state<Record<string, string>>({})
  let loading = $state(true)
  let error = $state('')
  /** Harness catalogs are project-independent, so a standalone chat (or a cold
   *  start with no project selected) still loads them through the chats root. */
  let catalogProjectId = $derived(rendererRecovery.selectedProjectId ?? INBOX_PROJECT_ID)

  /** Harnesses CodeInOven can actually drive right now; unsupported builds
   *  behave exactly as if the harness were not installed. */
  let installedProviders = $derived(
    providerStore.providers.filter(
      (provider) => provider.status !== 'not_found' && provider.unsupportedReason === undefined
    )
  )

  let rows: AuxiliaryRow[] = $derived.by(() => {
    const names = new Map(installedProviders.map((provider) => [provider.id, provider.name]))
    const ids = [...new Set([...names.keys(), ...Object.keys(auxiliaryAgents)])]
    return ids
      .map((id) => ({ id, name: names.get(id) ?? harnessName(id), installed: names.has(id) }))
      .sort((left, right) => harnessOrder(left.id) - harnessOrder(right.id))
  })

  function savedEntryFor(rowId: string): AgentModelSelection | undefined {
    return auxiliaryAgents[rowId]
  }

  function savedSelectionFor(rowId: string): AgentModelSelection | undefined {
    return auxiliarySelectionFor(auxiliaryAgents, rowId)
  }

  /** Harness whose catalog and accounts the row's picker shows. A saved
   *  assignment wins so a cross-harness assignment stays visible; otherwise
   *  the row's own harness is the default. */
  function chosenHarness(rowId: string): string {
    return runsOn[rowId] ?? savedSelectionFor(rowId)?.harnessId ?? rowId
  }

  function modelTarget(rowId: string): AgentModelSelection | undefined {
    const saved = savedSelectionFor(rowId)
    return saved && saved.harnessId === chosenHarness(rowId) ? saved : undefined
  }

  function targetOptions(rowId: string): Array<{ id: string; name: string }> {
    const options = installedProviders.map((provider) => ({
      id: provider.id,
      name: provider.name
    }))
    const extras: string[] = []
    if (!options.some((option) => option.id === rowId)) extras.push(rowId)
    const savedHarnessId = savedSelectionFor(rowId)?.harnessId
    if (
      savedHarnessId &&
      !extras.includes(savedHarnessId) &&
      !options.some((option) => option.id === savedHarnessId)
    ) {
      extras.push(savedHarnessId)
    }
    for (const id of extras) options.push({ id, name: harnessName(id) })
    return options
  }

  function onRunsOnChange(rowId: string, value: string): void {
    runsOn = { ...runsOn, [rowId]: value }
  }

  /** Apply an assignment locally first, then persist it; roll back on failure. */
  async function commit(next: AuxiliaryAgentConfig): Promise<void> {
    const previous = auxiliaryAgents
    auxiliaryAgents = next
    try {
      await invoke('config:update', { auxiliaryAgents: next })
    } catch (saveError) {
      auxiliaryAgents = previous
      reportError(saveError, 'Auxiliary agent assignment could not be saved.')
    }
  }

  async function selectModel(
    rowId: string,
    providerId: string,
    modelId: string,
    harnessId: string,
    accountId?: string
  ): Promise<void> {
    const saved = savedSelectionFor(rowId)
    const thinkingLevel = saved?.harnessId === harnessId ? saved.thinkingLevel : undefined
    rendererRecovery.addRecentModel(modelKey(harnessId, providerId, modelId))
    await commit({
      ...auxiliaryAgents,
      [rowId]: { harnessId, providerId, modelId, accountId, thinkingLevel }
    })
  }

  async function selectThinking(rowId: string, level: ThinkingLevel): Promise<void> {
    const current = auxiliaryAgents[rowId]
    if (!current) return
    await commit({ ...auxiliaryAgents, [rowId]: { ...current, thinkingLevel: level } })
  }

  async function clearAssignment(rowId: string): Promise<void> {
    const next = { ...auxiliaryAgents }
    delete next[rowId]
    const nextRunsOn = { ...runsOn }
    delete nextRunsOn[rowId]
    runsOn = nextRunsOn
    await commit(next)
  }

  onMount(() => {
    const load = async (): Promise<void> => {
      loading = true
      error = ''
      try {
        const [latestConfig, projectCatalogs] = await Promise.all([
          invoke('config:get'),
          invoke('agent:listProviders', catalogProjectId),
          harnessAccountCache.warm()
        ])
        auxiliaryAgents = latestConfig.auxiliaryAgents
        catalogs = projectCatalogs
      } catch (loadError) {
        error =
          loadError instanceof Error ? loadError.message : 'Auxiliary agents could not be loaded.'
      } finally {
        loading = false
      }
    }
    void load()
  })
</script>

<div class="space-y-4">
  <div>
    <h2 class="text-sm font-semibold text-foreground">Auxiliary Agents</h2>
    <p class="mt-0.5 text-xs text-muted">
      The model each harness uses for thread titles, memory proposals, and turn grading. A harness
      with no assignment keeps its own price-optimized choice.
    </p>
  </div>

  {#if loading}
    <div class="flex items-center gap-2 rounded-xl border bg-surface px-4 py-3 text-xs text-muted">
      <Loader2 size={14} class="animate-spin" /> Loading auxiliary agents…
    </div>
  {:else}
    {#if error}
      <p
        class="rounded-xl border border-danger/30 bg-danger/10 px-4 py-3 text-xs text-danger"
        role="alert"
      >
        {error}
      </p>
    {/if}

    {#if rows.length === 0}
      <div class="rounded-xl border border-dashed bg-surface">
        <EmptyState
          icon={Cpu}
          title="No harnesses installed"
          description="Install a harness to assign an auxiliary model."
        />
      </div>
    {:else}
      <div class="rounded-xl border bg-surface">
        <div class="divide-y">
          {#each rows as row (row.id)}
            {@const savedEntry = savedEntryFor(row.id)}
            {@const targetHarness = chosenHarness(row.id)}
            {@const target = modelTarget(row.id)}
            <div class="flex flex-wrap items-center gap-3 p-4">
              <div class="flex min-w-0 flex-1 items-center gap-3">
                <div
                  class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-elevated"
                >
                  <AgentIcon agentId={row.id} label={row.name} size={20} />
                </div>
                <div class="min-w-0">
                  <p class="truncate text-sm font-medium text-foreground">{row.name}</p>
                  <p class="truncate text-xs text-muted">
                    {row.installed ? 'Threads on this harness' : 'Harness not installed'}
                  </p>
                </div>
              </div>

              <label class="flex min-w-0 shrink-0 items-center gap-2 text-xs text-muted">
                <span class="shrink-0">Runs on</span>
                <select
                  class="max-w-44 rounded-lg border bg-elevated px-2.5 py-1.5 text-xs text-foreground outline-none focus:border-primary"
                  aria-label={`Harness that runs auxiliary work for ${row.name}`}
                  value={targetHarness}
                  onchange={(event) => onRunsOnChange(row.id, event.currentTarget.value)}
                >
                  {#each targetOptions(row.id) as option (option.id)}
                    <option value={option.id}>{option.name}</option>
                  {/each}
                </select>
              </label>

              <div class="flex w-64 shrink-0 items-center gap-1.5">
                <div class="min-w-0 flex-1">
                  <ModelPicker
                    providers={catalogs}
                    projectId={catalogProjectId}
                    harnessFilter={targetHarness}
                    harnessId={targetHarness}
                    providerId={target?.providerId ?? ''}
                    modelId={target?.modelId ?? ''}
                    accountId={target?.accountId}
                    favoriteModels={rendererRecovery.favoriteModels}
                    recentModels={rendererRecovery.recentModels}
                    onRemoveRecent={(key) => rendererRecovery.removeRecentModel(key)}
                    side="bottom"
                    variant="field"
                    label={target ? undefined : 'Choose model'}
                    disabled={catalogs.length === 0}
                    onSelect={(providerId, modelId, harnessId, accountId) =>
                      void selectModel(row.id, providerId, modelId, harnessId, accountId)}
                    thinkingLevel={target?.thinkingLevel}
                    onSelectThinking={(level) => void selectThinking(row.id, level)}
                    onToggleFavorite={(providerId, modelId, harnessId) =>
                      rendererRecovery.toggleFavorite(modelKey(harnessId, providerId, modelId))}
                    onReorderFavorite={(draggedKey, targetKey, position) =>
                      rendererRecovery.reorderFavorite(draggedKey, targetKey, position)}
                  />
                </div>
                {#if savedEntry}
                  <button
                    type="button"
                    class="rounded-lg p-2 text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
                    title={`Clear the auxiliary model for ${row.name}`}
                    aria-label={`Clear the auxiliary model for ${row.name}`}
                    onclick={() => void clearAssignment(row.id)}
                  >
                    <X size={14} />
                  </button>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      </div>
    {/if}
  {/if}
</div>
