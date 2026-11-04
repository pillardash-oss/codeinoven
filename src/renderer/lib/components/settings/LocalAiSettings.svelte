<script lang="ts">
  import { invoke } from '$lib/ipc.svelte'
  import type { LlamaCppRuntimeStatus, LocalAiRuntimeSummary } from '$shared/llama-cpp'
  import { onMount } from 'svelte'
  import LocalAiLlamaTab from './local-ai/LocalAiLlamaTab.svelte'
  import LocalAiSettingsTab from './local-ai/LocalAiSettingsTab.svelte'
  import LocalAiWorkerTab from './local-ai/LocalAiWorkerTab.svelte'
  import type { AppConfig, AppConfigPatch } from '$shared/types'

  interface Props {
    config: AppConfig
    settingsReady: boolean
    updateConfig: (patch: AppConfigPatch) => Promise<void>
  }

  let { config, settingsReady, updateConfig }: Props = $props()

  let runtime = $state<LlamaCppRuntimeStatus | null>(null)
  /** MLX and Core ML: the bundled workers, which the llama.cpp card does not cover. */
  let workerRuntimes = $state<LocalAiRuntimeSummary[]>([])
  let detecting = $state(false)
  let detectError = $state('')

  type LocalAiTab = 'llama' | 'mlx' | 'coreml' | 'settings'
  let tab = $state<LocalAiTab>('llama')

  const TABS: { id: LocalAiTab; label: string; title: string }[] = [
    { id: 'llama', label: 'llama.cpp', title: 'The llama.cpp engine and its servers' },
    { id: 'mlx', label: 'MLX', title: 'The MLX engine and the models it serves' },
    { id: 'coreml', label: 'Core ML', title: 'The Core ML engine and the models it serves' },
    { id: 'settings', label: 'Settings', title: 'Model memory and unload behaviour' }
  ]

  /**
   * MLX and Core ML are Apple Silicon engines that ship as bundled workers, so a
   * machine that cannot run them does not get a tab for them at all. Until the
   * detection answers, only the always-present tabs are listed, so no tab
   * appears and then disappears.
   */
  const visibleTabs = $derived(
    TABS.filter(
      (entry) =>
        entry.id === 'llama' ||
        entry.id === 'settings' ||
        workerRuntimes.some((worker) => worker.id === entry.id && worker.available)
    )
  )

  /** The selected tab, or the first one that still exists after a detection. */
  const activeTab = $derived(
    visibleTabs.some((entry) => entry.id === tab) ? tab : ('llama' as LocalAiTab)
  )

  const worker = $derived(workerRuntimes.find((entry) => entry.id === activeTab) ?? null)

  async function detect(): Promise<void> {
    detecting = true
    detectError = ''
    try {
      const [llama, runtimes] = await Promise.all([
        invoke('llamaCpp:detect'),
        invoke('localAi:runtimes')
      ])
      runtime = llama
      workerRuntimes = runtimes.filter((entry) => entry.id !== 'llama.cpp')
    } catch (error) {
      detectError = error instanceof Error ? error.message : 'Detection failed'
    } finally {
      detecting = false
    }
  }

  onMount(() => {
    void detect()
  })
</script>

<div class="p-6 pb-24">
  <div class="mb-4">
    <h1 class="text-xl font-bold tracking-tight">Local AI</h1>
    <p class="mt-0.5 text-sm text-muted">One engine per tab, each with the models it serves.</p>
  </div>

  <div
    class="mb-5 flex w-max items-center gap-0.5 border bg-elevated p-0.5"
    role="tablist"
    aria-label="Local AI tabs"
  >
    {#each visibleTabs as entry (entry.id)}
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

  {#if activeTab === 'llama'}
    <LocalAiLlamaTab
      {runtime}
      {detecting}
      {detectError}
      onRefresh={() => void detect()}
      onChanged={() => void detect()}
      {config}
      {settingsReady}
      {updateConfig}
    />
  {:else if activeTab === 'settings'}
    <LocalAiSettingsTab {config} {settingsReady} {updateConfig} />
  {:else if worker}
    <LocalAiWorkerTab runtime={worker} {config} {settingsReady} {updateConfig} />
  {:else}
    <p class="text-sm text-muted">
      {detecting ? 'Detecting runtimes…' : 'This runtime is not available.'}
    </p>
  {/if}
</div>
