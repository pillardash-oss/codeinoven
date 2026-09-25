<script lang="ts">
  import { Loader2 } from '@lucide/svelte'
  import { onMount } from 'svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { modelKey } from '$lib/model-keys'
  import { reportError } from '$lib/stores/app-errors.svelte'
  import { harnessAccountCache } from '$lib/stores/harness-accounts'
  import { providerStore } from '$lib/stores/providers.svelte'
  import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
  import { INBOX_PROJECT_ID } from '$shared/types'
  import type {
    LocalRankingJudgeView,
    ProviderCatalog,
    RankingJudgeConfig,
    RankingJudgeKind,
    ThinkingLevel
  } from '$shared/types'
  import ModelPicker from '../shared/ModelPicker.svelte'
  import { harnessName, harnessOrder } from '../shared/model-picker-helpers'

  interface Props {
    /** Current judge, as reported by the parent's queue status. */
    judge: LocalRankingJudgeView
    /** Blocks interaction while the parent is busy. */
    disabled?: boolean
    /** Called after a successful save with the newly persisted judge view. */
    onSaved: (judge: LocalRankingJudgeView) => void
  }

  let { judge, disabled = false, onSaved }: Props = $props()

  /** The judge loaded from config, or the first optimistic write. Null until the
   *  read lands, while the parent's view already names the pinned kind. */
  let stored = $state<RankingJudgeConfig | null>(null)
  /** The chip the user is looking at when it deliberately differs from the
   *  persisted kind. It can sit on `model` before any model is pinned, in which
   *  case nothing has been persisted yet. */
  let selectionOverride = $state<RankingJudgeKind | null>(null)
  let typesafeAvailable = $state(false)
  let catalogs = $state<ProviderCatalog[]>([])
  /** Harness override for the picker, so a model from any harness can be pinned. */
  let runsOn = $state<string | null>(null)
  let loading = $state(true)
  let saving = $state(false)
  let error = $state('')

  let preference = $derived(stored ?? { kind: judge.kind })
  let selection = $derived(selectionOverride ?? preference.kind)

  /** Harness catalogs are project-independent, so a standalone chat (or a cold
   *  start with no project selected) still loads them through the chats root. */
  let catalogProjectId = $derived(rendererRecovery.selectedProjectId ?? INBOX_PROJECT_ID)

  /** Harnesses CodeInOven can actually drive right now: a harness whose binary
   *  is not on this machine behaves exactly as if it were not installed. */
  let installedProviders = $derived(
    providerStore.providers.filter((provider) => provider.status !== 'not_found')
  )

  let savedModel = $derived(preference.kind === 'model' ? preference : undefined)
  let chosenHarness = $derived(runsOn ?? savedModel?.harnessId ?? installedProviders[0]?.id ?? '')
  /** The saved pin stays visible only while its harness is the chosen one. */
  let modelTarget = $derived(
    savedModel && savedModel.harnessId === chosenHarness ? savedModel : undefined
  )
  let busy = $derived(disabled || saving)

  let chipOptions = $derived([
    { kind: 'automatic' as const, label: 'Automatic' },
    ...(typesafeAvailable ? [{ kind: 'typesafe' as const, label: 'TypeSafe (Jev)' }] : []),
    { kind: 'model' as const, label: 'Specific model' }
  ] satisfies { kind: RankingJudgeKind; label: string }[])

  function viewFor(next: RankingJudgeConfig): LocalRankingJudgeView {
    if (next.kind === 'typesafe') {
      return { kind: 'typesafe', label: 'TypeSafe (Jev)' }
    }
    if (next.kind === 'model') {
      return {
        kind: 'model',
        label: `${next.harnessId ?? ''} · ${next.modelId ?? ''}`
      }
    }
    return { kind: 'automatic', label: 'Automatic' }
  }

  function targetOptions(): Array<{ id: string; name: string }> {
    const options = installedProviders.map((provider) => ({
      id: provider.id,
      name: provider.name
    }))
    const savedHarnessId = savedModel?.harnessId
    if (savedHarnessId && !options.some((option) => option.id === savedHarnessId)) {
      options.push({ id: savedHarnessId, name: harnessName(savedHarnessId) })
    }
    return options.sort((left, right) => harnessOrder(left.id) - harnessOrder(right.id))
  }

  /** Apply the preference locally first, then persist it; roll back on failure. */
  async function commit(next: RankingJudgeConfig): Promise<void> {
    const previous = stored
    const previousOverride = selectionOverride
    stored = next
    selectionOverride = null
    saving = true
    try {
      await invoke('config:update', { rankingJudge: next })
    } catch (saveError) {
      stored = previous
      selectionOverride = previousOverride
      reportError(saveError, 'The grading model could not be saved.')
      return
    } finally {
      saving = false
    }
    onSaved(viewFor(next))
  }

  /** Choosing the model chip only reveals the picker; the pin is saved once a
   *  model is actually selected, because the main process rejects an incomplete
   *  model pin. */
  async function selectKind(kind: RankingJudgeKind): Promise<void> {
    if (kind === 'model') {
      selectionOverride = 'model'
      return
    }
    if (preference.kind === kind) {
      selectionOverride = null
      return
    }
    await commit({ kind })
  }

  async function selectModel(
    providerId: string,
    modelId: string,
    harnessId: string,
    accountId?: string
  ): Promise<void> {
    const thinkingLevel = savedModel?.harnessId === harnessId ? savedModel.thinkingLevel : undefined
    rendererRecovery.addRecentModel(modelKey(harnessId, providerId, modelId))
    await commit({ kind: 'model', harnessId, providerId, modelId, accountId, thinkingLevel })
  }

  async function selectThinking(level: ThinkingLevel): Promise<void> {
    const current = preference
    if (current.kind !== 'model') return
    await commit({ ...current, thinkingLevel: level })
  }

  onMount(() => {
    const load = async (): Promise<void> => {
      loading = true
      error = ''
      try {
        const [config, projectCatalogs, typesafeStatus] = await Promise.all([
          invoke('config:get'),
          invoke('agent:listProviders', catalogProjectId),
          invoke('typesafe:getStatus'),
          // Account labels are decoration on the model picker, so a registry read
          // that fails must not take the whole picker down with it.
          harnessAccountCache.warm().catch(() => [])
        ])
        const loaded = config.rankingJudge ?? { kind: 'automatic' }
        stored = loaded
        // A stored TypeSafe pin whose key is gone is shown as the automatic
        // chain, which is exactly what the engine falls back to.
        selectionOverride =
          loaded.kind === 'typesafe' && !typesafeStatus.hasKey ? 'automatic' : null
        typesafeAvailable = typesafeStatus.hasKey
        catalogs = projectCatalogs
      } catch {
        // A fixed line on purpose: a raw internal message is not something a
        // user can act on, and the picker's own state already reads as unset.
        error = 'The grading model could not be loaded.'
      } finally {
        loading = false
      }
    }
    void load()
  })
</script>

<div class="space-y-3">
  <div
    class="flex flex-wrap items-center gap-1"
    role="group"
    aria-label="Model that grades ranking conversations"
  >
    {#each chipOptions as option (option.kind)}
      <button
        type="button"
        class="flex h-7 items-center rounded-lg px-2.5 text-[0.6875rem] font-medium {selection ===
        option.kind
          ? 'bg-overlay text-foreground'
          : 'text-muted hover:bg-elevated hover:text-foreground'}"
        aria-pressed={selection === option.kind}
        disabled={busy}
        onclick={() => void selectKind(option.kind)}
      >
        {option.label}
      </button>
    {/each}
  </div>

  <p class="text-xs text-muted">
    A pinned model grades ranking conversations first. A model that cannot answer falls back to the
    automatic chain.
  </p>

  {#if selection === 'model'}
    {#if loading}
      <div class="flex items-center gap-2 text-xs text-muted">
        <Loader2 size={14} class="animate-spin" /> Loading models…
      </div>
    {:else}
      <div class="flex flex-wrap items-center gap-3">
        <label class="flex min-w-0 shrink-0 items-center gap-2 text-xs text-muted">
          <span class="shrink-0">Runs on</span>
          <select
            class="max-w-44 rounded-lg border bg-elevated px-2.5 py-1.5 text-xs text-foreground outline-none focus:border-primary disabled:opacity-50"
            aria-label="Harness that runs the pinned judging model"
            value={chosenHarness}
            disabled={busy}
            onchange={(event) => (runsOn = event.currentTarget.value)}
          >
            {#each targetOptions() as option (option.id)}
              <option value={option.id}>{option.name}</option>
            {/each}
          </select>
        </label>

        <div class="flex w-64 shrink-0 items-center gap-1.5">
          <div class="min-w-0 flex-1">
            <ModelPicker
              providers={catalogs}
              projectId={catalogProjectId}
              harnessFilter={chosenHarness}
              harnessId={chosenHarness}
              providerId={modelTarget?.providerId ?? ''}
              modelId={modelTarget?.modelId ?? ''}
              accountId={modelTarget?.accountId}
              favoriteModels={rendererRecovery.favoriteModels}
              recentModels={rendererRecovery.recentModels}
              onRemoveRecent={(key) => rendererRecovery.removeRecentModel(key)}
              side="bottom"
              variant="field"
              label={modelTarget ? undefined : 'Choose model'}
              disabled={busy || catalogs.length === 0}
              onSelect={(providerId, modelId, harnessId, accountId) =>
                void selectModel(providerId, modelId, harnessId, accountId)}
              thinkingLevel={modelTarget?.thinkingLevel}
              onSelectThinking={(level) => void selectThinking(level)}
              onToggleFavorite={(providerId, modelId, harnessId) =>
                rendererRecovery.toggleFavorite(modelKey(harnessId, providerId, modelId))}
              onReorderFavorite={(draggedKey, targetKey, position) =>
                rendererRecovery.reorderFavorite(draggedKey, targetKey, position)}
            />
          </div>
        </div>
      </div>
    {/if}
  {/if}

  {#if error}
    <p
      class="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
      role="alert"
    >
      {error}
    </p>
  {/if}
</div>
