<script lang="ts">
  import { invoke } from '$lib/ipc.svelte'
  import {
    LOCAL_AI_RUNTIME_TABS,
    type LocalAiRuntimeId,
    type LocalAiRuntimeStatus
  } from '$shared/llama-cpp'
  import { onMount } from 'svelte'
  import LocalAiEngineTab from './local-ai/LocalAiEngineTab.svelte'
  import LocalAiSettingsTab from './local-ai/LocalAiSettingsTab.svelte'
  import type { AppConfig, AppConfigPatch } from '$shared/types'

  interface Props {
    config: AppConfig
    settingsReady: boolean
    updateConfig: (patch: AppConfigPatch) => Promise<void>
  }

  let { config, settingsReady, updateConfig }: Props = $props()

  /** What detection found for each engine, keyed by engine. */
  let statuses = $state<Partial<Record<LocalAiRuntimeId, LocalAiRuntimeStatus>>>({})
  let detecting = $state<Partial<Record<LocalAiRuntimeId, boolean>>>({})
  let detectErrors = $state<Partial<Record<LocalAiRuntimeId, string>>>({})

  type LocalAiTab = LocalAiRuntimeId | 'settings'
  let tab = $state<LocalAiTab>('llama.cpp')

  const TABS: { id: LocalAiTab; label: string; title: string }[] = [
    ...LOCAL_AI_RUNTIME_TABS,
    { id: 'settings', label: 'Settings', title: 'Model memory and unload behaviour' }
  ]

  const activeTab = $derived(TABS.some((entry) => entry.id === tab) ? tab : 'llama.cpp')

  async function detect(runtime: LocalAiRuntimeId): Promise<void> {
    detecting = { ...detecting, [runtime]: true }
    detectErrors = { ...detectErrors, [runtime]: '' }
    try {
      const status = await invoke('localAi:detect', runtime)
      statuses = { ...statuses, [runtime]: status }
    } catch (error) {
      detectErrors = {
        ...detectErrors,
        [runtime]: error instanceof Error ? error.message : 'Detection failed'
      }
    } finally {
      detecting = { ...detecting, [runtime]: false }
    }
  }

  function statusOf(runtime: LocalAiRuntimeId): LocalAiRuntimeStatus | null {
    return statuses[runtime] ?? null
  }

  onMount(() => {
    // Both engines are detected once, so each tab states what this machine has
    // before the user switches to it.
    for (const entry of LOCAL_AI_RUNTIME_TABS) void detect(entry.id)
  })
</script>

<div class="p-6 pb-24">
  <div class="mb-4">
    <h1 class="text-xl font-bold tracking-tight">Local AI</h1>
    <p class="mt-0.5 text-sm text-muted">Models that run on this computer, grouped by engine.</p>
  </div>

  <div
    class="mb-5 flex w-max items-center gap-0.5 border bg-elevated p-0.5"
    role="tablist"
    aria-label="Local AI tabs"
  >
    {#each TABS as entry (entry.id)}
      <button
        type="button"
        class="px-3 py-1.5 text-xs font-medium transition-colors {activeTab === entry.id
          ? 'bg-surface text-foreground'
          : 'text-muted hover:text-foreground'}"
        role="tab"
        aria-selected={activeTab === entry.id}
        title={entry.title}
        onclick={() => (tab = entry.id)}
      >
        {entry.label}
      </button>
    {/each}
  </div>

  {#if activeTab === 'settings'}
    <LocalAiSettingsTab {config} {settingsReady} {updateConfig} />
  {:else}
    <LocalAiEngineTab
      runtime={activeTab}
      status={statusOf(activeTab)}
      detecting={detecting[activeTab] ?? false}
      detectError={detectErrors[activeTab] ?? ''}
      onRefresh={() => void detect(activeTab)}
      onChanged={() => void detect(activeTab)}
      {config}
      {settingsReady}
      {updateConfig}
    />
  {/if}
</div>
