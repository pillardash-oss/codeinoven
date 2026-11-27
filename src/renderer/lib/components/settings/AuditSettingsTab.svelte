<script lang="ts">
  import CioClose from '@pdslng/cio-icon/CioClose.svelte'
  import CioEye from '@pdslng/cio-icon/CioEye.svelte'
  import CioRefresh from '@pdslng/cio-icon/CioRefresh.svelte'
  import { onMount } from 'svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
  import { modelKey } from '$lib/model-keys'
  import ModelPicker from '../shared/ModelPicker.svelte'
  import WorkerNamesSettings from './WorkerNamesSettings.svelte'
  import TypesafeDecisionsCard from '../providers/TypesafeDecisionsCard.svelte'
  import AuxiliaryAgentsPanel from '../providers/AuxiliaryAgentsPanel.svelte'
  import type {
    AgentDefaultsConfig,
    AgentModelSelection,
    AppConfig,
    AppConfigPatch,
    ProviderCatalog,
    ThinkingLevel
  } from '$shared/types'
  import { DEFAULT_HARNESS } from '$shared/harness-default'

  interface Props {
    config: AppConfig
    settingsReady: boolean
    updateConfig: (patch: AppConfigPatch) => Promise<void>
  }

  let { config, settingsReady, updateConfig }: Props = $props()

  let providers = $state<ProviderCatalog[]>([])
  // Intentional initial snapshot; onMount refreshes from main-process config.
  // svelte-ignore state_referenced_locally
  let defaults = $state<AgentDefaultsConfig>($state.snapshot(config.agentDefaults))
  let loading = $state(true)
  let error = $state('')

  onMount(() => {
    const load = async (): Promise<void> => {
      loading = true
      error = ''
      try {
        const projectId = rendererRecovery.selectedProjectId
        const [latestConfig, catalogs] = await Promise.all([
          invoke('config:get'),
          projectId ? invoke('agent:listProviders', projectId) : Promise.resolve([])
        ])
        defaults = $state.snapshot(latestConfig.agentDefaults)
        providers = catalogs
      } catch (loadError) {
        error = loadError instanceof Error ? loadError.message : 'Agent models could not be loaded.'
      } finally {
        loading = false
      }
    }
    void load()
  })

  async function selectImageDescriptor(
    providerId: string,
    modelId: string,
    nextHarnessId?: string,
    accountId?: string
  ): Promise<void> {
    const provider = providers.find(
      (candidate) =>
        candidate.id === providerId &&
        (nextHarnessId ? candidate.harnessId === nextHarnessId : true)
    )
    if (!provider) return
    const harnessId = nextHarnessId ?? provider.harnessId
    const next: AgentDefaultsConfig = {
      ...defaults,
      imageDescriptor: {
        harnessId,
        providerId,
        modelId,
        accountId,
        thinkingLevel: defaults.imageDescriptor?.thinkingLevel
      }
    }
    defaults = next
    rendererRecovery.addRecentModel(modelKey(harnessId, providerId, modelId))
    await updateConfig({ agentDefaults: next })
  }

  async function selectImageDescriptorThinking(level: ThinkingLevel): Promise<void> {
    if (!defaults.imageDescriptor) return
    const next: AgentDefaultsConfig = {
      ...defaults,
      imageDescriptor: { ...defaults.imageDescriptor, thinkingLevel: level }
    }
    defaults = next
    await updateConfig({ agentDefaults: next })
  }

  async function selectImageDescriptorRuntime(
    runtime: import('$shared/types').ModelRuntimeSettings
  ): Promise<void> {
    if (!defaults.imageDescriptor) return
    const next: AgentDefaultsConfig = {
      ...defaults,
      imageDescriptor: { ...defaults.imageDescriptor, ...runtime }
    }
    defaults = next
    await updateConfig({ agentDefaults: next })
  }

  async function clearImageDescriptor(): Promise<void> {
    const next = { ...defaults }
    delete next.imageDescriptor
    defaults = next
    await updateConfig({ agentDefaults: next })
  }

  /** Whether two selections point at the same vision model. */
  function sameModel(
    a: AgentModelSelection | undefined,
    b: AgentModelSelection | undefined
  ): boolean {
    return (
      a !== undefined &&
      b !== undefined &&
      a.harnessId === b.harnessId &&
      a.providerId === b.providerId &&
      a.modelId === b.modelId &&
      a.accountId === b.accountId
    )
  }

  async function selectImageDescriptorFallback(
    providerId: string,
    modelId: string,
    nextHarnessId?: string,
    accountId?: string
  ): Promise<void> {
    const provider = providers.find(
      (candidate) =>
        candidate.id === providerId &&
        (nextHarnessId ? candidate.harnessId === nextHarnessId : true)
    )
    if (!provider) return
    const harnessId = nextHarnessId ?? provider.harnessId
    const next: AgentDefaultsConfig = {
      ...defaults,
      imageDescriptorFallback: {
        harnessId,
        providerId,
        modelId,
        accountId,
        thinkingLevel: defaults.imageDescriptorFallback?.thinkingLevel
      }
    }
    defaults = next
    rendererRecovery.addRecentModel(modelKey(harnessId, providerId, modelId))
    await updateConfig({ agentDefaults: next })
  }

  async function selectImageDescriptorFallbackThinking(level: ThinkingLevel): Promise<void> {
    if (!defaults.imageDescriptorFallback) return
    const next: AgentDefaultsConfig = {
      ...defaults,
      imageDescriptorFallback: { ...defaults.imageDescriptorFallback, thinkingLevel: level }
    }
    defaults = next
    await updateConfig({ agentDefaults: next })
  }

  async function selectImageDescriptorFallbackRuntime(
    runtime: import('$shared/types').ModelRuntimeSettings
  ): Promise<void> {
    if (!defaults.imageDescriptorFallback) return
    const next: AgentDefaultsConfig = {
      ...defaults,
      imageDescriptorFallback: { ...defaults.imageDescriptorFallback, ...runtime }
    }
    defaults = next
    await updateConfig({ agentDefaults: next })
  }

  async function clearImageDescriptorFallback(): Promise<void> {
    const next = { ...defaults }
    delete next.imageDescriptorFallback
    defaults = next
    await updateConfig({ agentDefaults: next })
  }
</script>

<div class="p-6 pb-24">
  <div class="mb-6">
    <h1 class="text-xl font-bold tracking-tight">Agents</h1>
    <p class="mt-0.5 text-sm text-muted">
      How the agents read images, what runs their background work, and what the workers are called.
      A worker inherits the thread's own harness, account, model and Oven.
    </p>
  </div>

  {#if loading}
    <p class="mb-4 flex items-center gap-2 text-xs text-muted">Loading models…</p>
  {:else if error}
    <p class="mb-4 text-xs text-danger" role="alert">{error}</p>
  {:else if providers.length === 0}
    <p class="mb-4 text-xs text-muted">Select a configured project to choose a vision model.</p>
  {/if}

  <section class="border bg-surface" aria-label="Image descriptor default">
    <div class="flex items-center gap-4 p-4">
      <div class="bg-primary/10 p-2 text-primary"><CioEye size={18} /></div>
      <div class="min-w-0 flex-1">
        <h2 class="text-sm font-semibold text-foreground">Image descriptor</h2>
        <p class="mt-0.5 text-xs text-muted">Describes images for models that cannot see them.</p>
        {#if !defaults.imageDescriptor}
          <p class="mt-1 text-[0.6875rem] text-dimmed">
            Not set · you'll be asked when you send an image
          </p>
        {/if}
      </div>
      <div class="flex w-60 shrink-0 items-center gap-1.5">
        <div class="min-w-0 flex-1">
          <ModelPicker
            {providers}
            projectId={rendererRecovery.selectedProjectId}
            harnessId={defaults.imageDescriptor?.harnessId ??
              providers[0]?.harnessId ??
              DEFAULT_HARNESS}
            providerId={defaults.imageDescriptor?.providerId ?? ''}
            modelId={defaults.imageDescriptor?.modelId ?? ''}
            accountId={defaults.imageDescriptor?.accountId}
            favoriteModels={rendererRecovery.favoriteModels}
            recentModels={rendererRecovery.recentModels}
            onRemoveRecent={(key) => rendererRecovery.removeRecentModel(key)}
            visionOnly
            side="bottom"
            variant="field"
            label={defaults.imageDescriptor ? undefined : 'Choose a vision model'}
            disabled={!settingsReady || loading || providers.length === 0}
            onSelect={(providerId, modelId, harnessId, accountId) =>
              void selectImageDescriptor(providerId, modelId, harnessId, accountId)}
            thinkingLevel={defaults.imageDescriptor?.thinkingLevel}
            runtimeSettings={defaults.imageDescriptor}
            onSelectThinking={(level) => void selectImageDescriptorThinking(level)}
            onSelectRuntime={(runtime) => void selectImageDescriptorRuntime(runtime)}
            onToggleFavorite={(providerId, modelId, harnessId) =>
              rendererRecovery.toggleFavorite(modelKey(harnessId, providerId, modelId))}
            onReorderFavorite={(draggedKey, targetKey, position) =>
              rendererRecovery.reorderFavorite(draggedKey, targetKey, position)}
          />
        </div>
        {#if defaults.imageDescriptor}
          <button
            type="button"
            class="p-2 text-dimmed hover:bg-elevated hover:text-foreground"
            title="Clear image descriptor default"
            aria-label="Clear image descriptor default"
            onclick={() => void clearImageDescriptor()}
          >
            <CioClose size={14} />
          </button>
        {/if}
      </div>
    </div>
    <div class="flex items-center gap-4 border-t p-4">
      <div class="bg-elevated p-2 text-muted"><CioRefresh size={18} /></div>
      <div class="min-w-0 flex-1">
        <h2 class="text-sm font-semibold text-foreground">Fallback</h2>
        <p class="mt-0.5 text-xs text-muted">Used when the primary fails.</p>
        {#if !defaults.imageDescriptorFallback}
          <p class="mt-1 text-[0.6875rem] text-dimmed">
            Not set · primary failures ask you for a model
          </p>
        {:else if sameModel(defaults.imageDescriptor, defaults.imageDescriptorFallback)}
          <p class="mt-1 text-[0.6875rem] text-danger">
            Same model as the primary it cannot act as a fallback.
          </p>
        {/if}
      </div>
      <div class="flex w-60 shrink-0 items-center gap-1.5">
        <div class="min-w-0 flex-1">
          <ModelPicker
            {providers}
            projectId={rendererRecovery.selectedProjectId}
            harnessId={defaults.imageDescriptorFallback?.harnessId ??
              providers[0]?.harnessId ??
              DEFAULT_HARNESS}
            providerId={defaults.imageDescriptorFallback?.providerId ?? ''}
            modelId={defaults.imageDescriptorFallback?.modelId ?? ''}
            accountId={defaults.imageDescriptorFallback?.accountId}
            favoriteModels={rendererRecovery.favoriteModels}
            recentModels={rendererRecovery.recentModels}
            onRemoveRecent={(key) => rendererRecovery.removeRecentModel(key)}
            visionOnly
            side="bottom"
            variant="field"
            label={defaults.imageDescriptorFallback ? undefined : 'Choose fallback model'}
            disabled={!settingsReady || loading || providers.length === 0}
            onSelect={(providerId, modelId, harnessId, accountId) =>
              void selectImageDescriptorFallback(providerId, modelId, harnessId, accountId)}
            thinkingLevel={defaults.imageDescriptorFallback?.thinkingLevel}
            runtimeSettings={defaults.imageDescriptorFallback}
            onSelectThinking={(level) => void selectImageDescriptorFallbackThinking(level)}
            onSelectRuntime={(runtime) => void selectImageDescriptorFallbackRuntime(runtime)}
            onToggleFavorite={(providerId, modelId, harnessId) =>
              rendererRecovery.toggleFavorite(modelKey(harnessId, providerId, modelId))}
            onReorderFavorite={(draggedKey, targetKey, position) =>
              rendererRecovery.reorderFavorite(draggedKey, targetKey, position)}
          />
        </div>
        {#if defaults.imageDescriptorFallback}
          <button
            type="button"
            class="p-2 text-dimmed hover:bg-elevated hover:text-foreground"
            title="Clear image descriptor fallback default"
            aria-label="Clear image descriptor fallback default"
            onclick={() => void clearImageDescriptorFallback()}
          >
            <CioClose size={14} />
          </button>
        {/if}
      </div>
    </div>
  </section>

  <div class="mt-6 space-y-6">
    <TypesafeDecisionsCard />
    <AuxiliaryAgentsPanel />
  </div>

  <div class="mt-6">
    <WorkerNamesSettings {settingsReady} />
  </div>
</div>
