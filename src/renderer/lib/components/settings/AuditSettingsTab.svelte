<script lang="ts">
  import { BrainCircuit, Eye, Hammer, Loader2, ShieldCheck, X } from '@lucide/svelte'
  import { onMount } from 'svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
  import ModelPicker from '../shared/ModelPicker.svelte'
  import Switch from '../ui/Switch.svelte'
  import WorkerNamesSettings from './WorkerNamesSettings.svelte'
  import type {
    AgentDefaultsConfig,
    AgentModelSelection,
    AgentRole,
    AppConfig,
    AppConfigPatch,
    ProviderCatalog
  } from '$shared/types'

  interface Props {
    config: AppConfig
    settingsReady: boolean
    updateConfig: (patch: AppConfigPatch) => Promise<void>
  }

  let { config, settingsReady, updateConfig }: Props = $props()

  const roles = [
    {
      id: 'seniorEngineer',
      label: 'Sr. Engineer',
      description: 'Plans the specification and coordinates Assignment work.',
      icon: BrainCircuit
    },
    {
      id: 'worker',
      label: 'Worker',
      description: 'Implements Assignment tasks when a task or phase has no override.',
      icon: Hammer
    },
    {
      id: 'auditor',
      label: 'Auditor',
      description: 'Independently audits completed Engineering and Achievement work.',
      icon: ShieldCheck
    }
  ] satisfies Array<{
    id: AgentRole
    label: string
    description: string
    icon: typeof BrainCircuit
  }>

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

  function selectionFor(role: AgentRole): AgentModelSelection | undefined {
    return defaults[role]
  }

  async function selectModel(
    role: AgentRole,
    providerId: string,
    modelId: string,
    nextHarnessId?: string
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
      [role]: { harnessId, providerId, modelId }
    }
    defaults = next
    rendererRecovery.addRecentModel(`${providerId}:${modelId}`)
    await updateConfig({ agentDefaults: next })
  }

  async function clearModel(role: AgentRole): Promise<void> {
    const next = { ...defaults }
    delete next[role]
    defaults = next
    await updateConfig({ agentDefaults: next })
  }

  async function selectImageDescriptor(
    providerId: string,
    modelId: string,
    nextHarnessId?: string
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
      imageDescriptor: { harnessId, providerId, modelId }
    }
    defaults = next
    rendererRecovery.addRecentModel(`${providerId}:${modelId}`)
    await updateConfig({ agentDefaults: next })
  }

  async function clearImageDescriptor(): Promise<void> {
    const next = { ...defaults }
    delete next.imageDescriptor
    defaults = next
    await updateConfig({ agentDefaults: next })
  }

  async function toggleThreadSync(): Promise<void> {
    const next = { ...defaults, syncFromThreadChanges: !defaults.syncFromThreadChanges }
    defaults = next
    await updateConfig({ agentDefaults: next })
  }
</script>

<div class="mx-auto max-w-2xl p-6 pb-24">
  <div class="mb-6">
    <h1 class="text-xl font-bold tracking-tight">Agents</h1>
    <p class="mt-0.5 text-sm text-muted">
      Choose global models for Engineering roles and image description. A thread can still override
      them.
    </p>
  </div>

  <section class="rounded-xl border bg-surface" aria-label="Agent defaults">
    <div class="divide-y">
      {#each roles as role (role.id)}
        {@const Icon = role.icon}
        {@const selection = selectionFor(role.id)}
        <div class="flex items-center gap-4 p-4">
          <div class="rounded-lg bg-primary/10 p-2 text-primary"><Icon size={18} /></div>
          <div class="min-w-0 flex-1">
            <h2 class="text-sm font-semibold text-foreground">{role.label}</h2>
            <p class="mt-0.5 text-xs text-muted">{role.description}</p>
            {#if !selection}
              <p class="mt-1 text-[11px] text-dimmed">Not set · uses the current thread model</p>
            {/if}
          </div>
          <div class="flex w-60 shrink-0 items-center gap-1.5">
            <div class="min-w-0 flex-1">
              <ModelPicker
                {providers}
                projectId={rendererRecovery.selectedProjectId}
                harnessId={selection?.harnessId ?? providers[0]?.harnessId ?? 'opencode'}
                providerId={selection?.providerId ?? ''}
                modelId={selection?.modelId ?? ''}
                favoriteModels={rendererRecovery.favoriteModels}
                recentModels={rendererRecovery.recentModels}
                side="bottom"
                variant="field"
                label={selection ? undefined : 'Choose model'}
                disabled={!settingsReady || loading || providers.length === 0}
                onSelect={(providerId, modelId, harnessId) =>
                  void selectModel(role.id, providerId, modelId, harnessId)}
                onToggleFavorite={(providerId, modelId) =>
                  rendererRecovery.toggleFavorite(`${providerId}:${modelId}`)}
                onReorderFavorite={(draggedKey, targetKey, position) =>
                  rendererRecovery.reorderFavorite(draggedKey, targetKey, position)}
              />
            </div>
            {#if selection}
              <button
                type="button"
                class="rounded-lg p-2 text-dimmed hover:bg-elevated hover:text-foreground"
                title={`Clear ${role.label} default`}
                aria-label={`Clear ${role.label} default`}
                onclick={() => void clearModel(role.id)}
              >
                <X size={14} />
              </button>
            {/if}
          </div>
        </div>
      {/each}
    </div>

    {#if loading}
      <div class="flex items-center gap-2 border-t px-4 py-3 text-xs text-muted">
        <Loader2 size={14} class="animate-spin" /> Loading models…
      </div>
    {:else if providers.length === 0}
      <p class="border-t px-4 py-3 text-xs text-muted">
        Select a configured project to choose role models. Unset roles use the current thread model.
      </p>
    {/if}

    {#if error}<p class="border-t px-4 py-3 text-xs text-danger" role="alert">{error}</p>{/if}

    <div class="flex items-center justify-between gap-4 border-t p-4">
      <div>
        <p class="text-sm font-medium text-foreground">Follow thread changes</p>
        <p class="mt-0.5 text-xs text-muted">
          Replace a role's global default when that role's model is changed inside a thread.
        </p>
      </div>
      <Switch
        checked={defaults.syncFromThreadChanges}
        onchange={() => void toggleThreadSync()}
        aria-label="Follow agent model changes from threads"
        disabled={!settingsReady}
      />
    </div>
  </section>

  <section class="rounded-xl border bg-surface" aria-label="Image descriptor default">
    <div class="flex items-center gap-4 p-4">
      <div class="rounded-lg bg-primary/10 p-2 text-primary"><Eye size={18} /></div>
      <div class="min-w-0 flex-1">
        <h2 class="text-sm font-semibold text-foreground">Image descriptor</h2>
        <p class="mt-0.5 text-xs text-muted">
          Vision model used to describe images for text-only models that cannot see them.
        </p>
        {#if !defaults.imageDescriptor}
          <p class="mt-1 text-[11px] text-dimmed">
            Not set · you'll be asked when you send an image
          </p>
        {/if}
      </div>
      <div class="flex w-60 shrink-0 items-center gap-1.5">
        <div class="min-w-0 flex-1">
          <ModelPicker
            {providers}
            projectId={rendererRecovery.selectedProjectId}
            harnessId={defaults.imageDescriptor?.harnessId ?? providers[0]?.harnessId ?? 'opencode'}
            providerId={defaults.imageDescriptor?.providerId ?? ''}
            modelId={defaults.imageDescriptor?.modelId ?? ''}
            favoriteModels={rendererRecovery.favoriteModels}
            recentModels={rendererRecovery.recentModels}
            visionOnly
            side="bottom"
            variant="field"
            label={defaults.imageDescriptor ? undefined : 'Choose a vision model'}
            disabled={!settingsReady || loading || providers.length === 0}
            onSelect={(providerId, modelId, harnessId) =>
              void selectImageDescriptor(providerId, modelId, harnessId)}
            onToggleFavorite={(providerId, modelId) =>
              rendererRecovery.toggleFavorite(`${providerId}:${modelId}`)}
            onReorderFavorite={(draggedKey, targetKey, position) =>
              rendererRecovery.reorderFavorite(draggedKey, targetKey, position)}
          />
        </div>
        {#if defaults.imageDescriptor}
          <button
            type="button"
            class="rounded-lg p-2 text-dimmed hover:bg-elevated hover:text-foreground"
            title="Clear image descriptor default"
            aria-label="Clear image descriptor default"
            onclick={() => void clearImageDescriptor()}
          >
            <X size={14} />
          </button>
        {/if}
      </div>
    </div>
  </section>

  <WorkerNamesSettings {settingsReady} />
</div>
