<script lang="ts">
  import { onMount } from 'svelte'
  import {
    AlertTriangle,
    CheckCircle2,
    HeartPulse,
    Loader2,
    Pencil,
    Plus,
    Trash2,
    XCircle
  } from '@lucide/svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
  import { heartbeatStore } from '$lib/stores/heartbeat.svelte'
  import { modelKey } from '$lib/model-keys'
  import AgentIcon from '$lib/agent-icons/AgentIcon.svelte'
  import ModelPicker from '../shared/ModelPicker.svelte'
  import Switch from '../ui/Switch.svelte'
  import Modal from '../ui/Modal.svelte'
  import type { HeartbeatConfig, ProviderCatalog, ThinkingLevel } from '$shared/types'
  import { DEFAULT_HARNESS } from '$shared/harness-default'

  let providers = $state<ProviderCatalog[]>([])
  let providersLoading = $state(true)
  let providersError = $state('')

  let editorOpen = $state(false)
  let editingId = $state<string | null>(null)
  let draftName = $state('')
  let draftHarnessId = $state('')
  let draftProviderId = $state('')
  let draftModelId = $state('')
  let draftThinkingLevel = $state<ThinkingLevel | undefined>(undefined)
  let draftTimes = $state<string[]>([])
  let draftTimeInput = $state('')
  let draftError = $state('')
  let deleteTarget = $state<HeartbeatConfig | null>(null)

  function providerName(harnessId: string): string {
    return providers.find((catalog) => catalog.harnessId === harnessId)?.name ?? harnessId
  }

  function modelName(harnessId: string, providerId: string, modelId: string): string {
    const catalog = providers.find(
      (candidate) => candidate.harnessId === harnessId && candidate.id === providerId
    )
    return catalog?.models.find((model) => model.id === modelId)?.name ?? modelId
  }

  function formatTime(time: string): string {
    const [hours, minutes] = time.split(':').map(Number)
    return new Date(2000, 0, 1, hours, minutes).toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit'
    })
  }

  function formatLastRun(config: HeartbeatConfig): string {
    if (!config.lastRun) return 'Never sent'
    const when = new Date(config.lastRun.at).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    })
    return config.lastRun.success ? `Ponged ${when}` : `Failed ${when}`
  }

  function openCreate(): void {
    editingId = null
    draftName = ''
    draftHarnessId = providers[0]?.harnessId ?? ''
    draftProviderId = ''
    draftModelId = ''
    draftThinkingLevel = undefined
    draftTimes = []
    draftTimeInput = ''
    draftError = ''
    editorOpen = true
  }

  function openEdit(config: HeartbeatConfig): void {
    editingId = config.id
    draftName = config.name
    draftHarnessId = config.harnessId
    draftProviderId = config.providerId
    draftModelId = config.modelId
    draftThinkingLevel = config.thinkingLevel
    draftTimes = [...config.times]
    draftTimeInput = ''
    draftError = ''
    editorOpen = true
  }

  function closeEditor(): void {
    editorOpen = false
  }

  function addDraftTime(): void {
    if (!draftTimeInput) return
    if (!draftTimes.includes(draftTimeInput)) {
      draftTimes = [...draftTimes, draftTimeInput].sort()
    }
    draftTimeInput = ''
  }

  function removeDraftTime(time: string): void {
    draftTimes = draftTimes.filter((entry) => entry !== time)
  }

  async function saveDraft(): Promise<void> {
    draftError = ''
    if (!draftName.trim()) {
      draftError = 'Give this heartbeat a name.'
      return
    }
    if (!draftHarnessId || !draftProviderId || !draftModelId) {
      draftError = 'Choose a model.'
      return
    }
    if (draftTimes.length === 0) {
      draftError = 'Add at least one time.'
      return
    }
    try {
      if (editingId) {
        await heartbeatStore.update(editingId, {
          name: draftName.trim(),
          harnessId: draftHarnessId,
          providerId: draftProviderId,
          modelId: draftModelId,
          thinkingLevel: draftThinkingLevel,
          times: draftTimes
        })
      } else {
        await heartbeatStore.create({
          name: draftName.trim(),
          harnessId: draftHarnessId,
          providerId: draftProviderId,
          modelId: draftModelId,
          thinkingLevel: draftThinkingLevel,
          times: draftTimes,
          enabled: true
        })
      }
      closeEditor()
    } catch (saveError) {
      draftError = saveError instanceof Error ? saveError.message : 'Failed to save heartbeat.'
    }
  }

  async function removeHeartbeat(): Promise<void> {
    if (!deleteTarget) return
    try {
      await heartbeatStore.remove(deleteTarget.id)
      deleteTarget = null
    } catch (removeError) {
      draftError = removeError instanceof Error ? removeError.message : 'Failed to delete heartbeat.'
    }
  }

  onMount(() => {
    void heartbeatStore.load()
    const load = async (): Promise<void> => {
      providersLoading = true
      providersError = ''
      try {
        const projectId = rendererRecovery.selectedProjectId
        providers = projectId ? await invoke('agent:listProviders', projectId) : []
      } catch (loadError) {
        providersError =
          loadError instanceof Error ? loadError.message : 'Models could not be loaded.'
      } finally {
        providersLoading = false
      }
    }
    void load()
  })
</script>

<div class="p-6 pb-24">
  <div class="mb-6 flex items-start justify-between gap-4">
    <div>
      <h1 class="text-xl font-bold tracking-tight">Heartbeat</h1>
      <p class="mt-0.5 text-sm text-muted">
        Send a lightweight "ping" to a model at set times to start its usage window early — so the
        next 5-hour reset lands before you need it.
      </p>
    </div>
    <button
      class="flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-primary px-2.5 text-xs font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
      disabled={providers.length === 0}
      onclick={openCreate}
    >
      <Plus size={13} /> Add heartbeat
    </button>
  </div>

  {#if providersError}
    <p class="mb-4 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
      {providersError}
    </p>
  {/if}
  {#if heartbeatStore.error}
    <p class="mb-4 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
      {heartbeatStore.error}
    </p>
  {/if}

  {#if heartbeatStore.loading && heartbeatStore.heartbeats.length === 0}
    <div class="rounded-xl border border-dashed p-6 text-center">
      <Loader2 size={17} class="mx-auto animate-spin text-dimmed" />
    </div>
  {:else if heartbeatStore.heartbeats.length === 0}
    <div class="rounded-xl border border-dashed p-6 text-center">
      <HeartPulse size={18} class="mx-auto mb-1.5 text-dimmed" />
      <p class="text-xs text-muted">No heartbeats configured yet.</p>
      {#if providers.length === 0 && !providersLoading}
        <p class="mt-1 text-[0.6875rem] text-dimmed">Select a configured project first.</p>
      {:else}
        <button class="mt-2 text-xs font-medium text-primary hover:underline" onclick={openCreate}>
          Add the first heartbeat
        </button>
      {/if}
    </div>
  {:else}
    <div class="overflow-hidden rounded-xl border bg-surface">
      {#each heartbeatStore.heartbeats as config (config.id)}
        <div class="flex items-start gap-3 border-b px-4 py-3 last:border-b-0">
          <div class="mt-0.5 rounded-lg bg-primary/10 p-1.5 text-primary">
            <AgentIcon agentId={config.harnessId} label={providerName(config.harnessId)} size={16} />
          </div>
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <p class="truncate text-sm font-semibold">{config.name}</p>
              {#if config.lastRun}
                <span
                  class="flex items-center gap-1 text-[0.625rem] {config.lastRun.success
                    ? 'text-success'
                    : 'text-danger'}"
                  title={formatLastRun(config)}
                >
                  {#if config.lastRun.success}
                    <CheckCircle2 size={11} />
                  {:else}
                    <XCircle size={11} />
                  {/if}
                  {formatLastRun(config)}
                </span>
              {:else}
                <span class="text-[0.625rem] text-dimmed">{formatLastRun(config)}</span>
              {/if}
            </div>
            <p class="mt-0.5 truncate text-[0.6875rem] text-dimmed">
              {providerName(config.harnessId)} · {modelName(
                config.harnessId,
                config.providerId,
                config.modelId
              )}
              {#if config.thinkingLevel}· {config.thinkingLevel}{/if}
            </p>
            <div class="mt-1.5 flex flex-wrap gap-1">
              {#each config.times as time (time)}
                <span class="rounded-full bg-raised px-1.5 py-0.5 text-[0.625rem] text-muted">
                  {formatTime(time)}
                </span>
              {/each}
            </div>
          </div>
          <div class="flex shrink-0 items-center gap-1">
            <Switch
              checked={config.enabled}
              onchange={(enabled) => void heartbeatStore.setEnabled(config.id, enabled)}
              aria-label="Enable {config.name}"
              title={config.enabled ? 'Disable heartbeat' : 'Enable heartbeat'}
            />
            <button
              class="flex h-7 w-7 items-center justify-center rounded-lg text-muted hover:bg-overlay hover:text-foreground"
              aria-label="Edit {config.name}"
              title="Edit {config.name}"
              onclick={() => openEdit(config)}
            >
              <Pencil size={13} />
            </button>
            <button
              class="flex h-7 w-7 items-center justify-center rounded-lg text-muted hover:bg-danger/10 hover:text-danger"
              aria-label="Delete {config.name}"
              title="Delete {config.name}"
              onclick={() => (deleteTarget = config)}
            >
              <Trash2 size={13} />
            </button>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<Modal
  open={editorOpen}
  title={editingId ? 'Edit heartbeat' : 'Add heartbeat'}
  onClose={closeEditor}
>
  {#snippet footer()}
    <button
      class="h-9 rounded-lg border bg-elevated px-3 text-xs font-medium hover:bg-overlay"
      type="button"
      onclick={closeEditor}
    >
      Cancel
    </button>
    <button
      class="flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
      type="button"
      disabled={heartbeatStore.saving}
      onclick={() => void saveDraft()}
    >
      {#if heartbeatStore.saving}<Loader2 size={13} class="animate-spin" />{/if}
      Save heartbeat
    </button>
  {/snippet}

  <div class="space-y-4">
    {#if draftError}
      <p class="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">{draftError}</p>
    {/if}

    <div>
      <label class="mb-1 block text-xs font-medium text-muted" for="heartbeat-name">Name</label>
      <input
        id="heartbeat-name"
        class="h-9 w-full rounded-lg border bg-elevated px-2.5 text-sm outline-none focus:border-primary"
        placeholder="e.g. Codex Sub, Claude Work"
        bind:value={draftName}
      />
    </div>

    <div>
      <span class="mb-1 block text-xs font-medium text-muted">Model</span>
      <ModelPicker
        {providers}
        projectId={rendererRecovery.selectedProjectId}
        harnessId={draftHarnessId || providers[0]?.harnessId || DEFAULT_HARNESS}
        providerId={draftProviderId}
        modelId={draftModelId}
        favoriteModels={rendererRecovery.favoriteModels}
        recentModels={rendererRecovery.recentModels}
        onRemoveRecent={(key) => rendererRecovery.removeRecentModel(key)}
        side="bottom"
        variant="field"
        label={draftModelId ? undefined : 'Choose model'}
        disabled={providers.length === 0}
        onSelect={(providerId, modelId, harnessId) => {
          draftHarnessId = harnessId
          draftProviderId = providerId
          draftModelId = modelId
          // Not every model supports thinking — drop a stale level the new
          // model doesn't offer so saving never carries an invalid value.
          const catalog = providers.find(
            (candidate) => candidate.harnessId === harnessId && candidate.id === providerId
          )
          const presets = catalog?.models.find((model) => model.id === modelId)?.thinkingPresets
          if (!presets?.some((preset) => preset.id === draftThinkingLevel)) {
            draftThinkingLevel = undefined
          }
          rendererRecovery.addRecentModel(modelKey(harnessId, providerId, modelId))
        }}
        thinkingLevel={draftThinkingLevel}
        onSelectThinking={(level) => (draftThinkingLevel = level)}
      />
    </div>

    <div>
      <span class="mb-1 block text-xs font-medium text-muted">Times</span>
      <div class="flex gap-2">
        <input
          type="time"
          class="h-9 flex-1 rounded-lg border bg-elevated px-2.5 text-sm outline-none focus:border-primary"
          bind:value={draftTimeInput}
        />
        <button
          type="button"
          class="flex h-9 items-center gap-1 rounded-lg border bg-elevated px-2.5 text-xs font-medium hover:bg-overlay disabled:opacity-50"
          disabled={!draftTimeInput}
          onclick={addDraftTime}
        >
          <Plus size={13} /> Add
        </button>
      </div>
      {#if draftTimes.length > 0}
        <div class="mt-2 flex flex-wrap gap-1.5">
          {#each draftTimes as time (time)}
            <span
              class="flex items-center gap-1 rounded-full bg-raised px-2 py-1 text-[0.6875rem] text-muted"
            >
              {formatTime(time)}
              <button
                type="button"
                class="text-dimmed hover:text-foreground"
                aria-label="Remove {formatTime(time)}"
                onclick={() => removeDraftTime(time)}
              >
                ×
              </button>
            </span>
          {/each}
        </div>
      {:else}
        <p class="mt-1.5 text-[0.6875rem] text-dimmed">No times added yet.</p>
      {/if}
    </div>
  </div>
</Modal>

<Modal open={deleteTarget !== null} title="Delete heartbeat" onClose={() => (deleteTarget = null)}>
  {#snippet footer()}
    <button
      class="h-9 rounded-lg border bg-elevated px-3 text-xs font-medium hover:bg-overlay"
      type="button"
      onclick={() => (deleteTarget = null)}
    >
      Cancel
    </button>
    <button
      class="flex h-9 items-center gap-1.5 rounded-lg bg-danger px-3 text-xs font-medium text-on-primary hover:opacity-90 disabled:opacity-50"
      type="button"
      disabled={heartbeatStore.saving}
      onclick={() => void removeHeartbeat()}
    >
      {#if heartbeatStore.saving}<Loader2 size={13} class="animate-spin" />{:else}<Trash2
          size={13}
        />{/if}
      Delete heartbeat
    </button>
  {/snippet}
  <div class="flex gap-2 text-sm text-muted">
    <AlertTriangle size={16} class="mt-0.5 shrink-0 text-warning" />
    <p>Delete <strong class="text-foreground">{deleteTarget?.name}</strong>? This can't be undone.</p>
  </div>
</Modal>
