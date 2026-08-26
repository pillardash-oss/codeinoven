<script lang="ts">
  import { onMount } from 'svelte'
  import { Download, ExternalLink, LoaderCircle, RefreshCw, Trash2, Upload, ClipboardPaste, X, Check, Star } from '@lucide/svelte'
  import DownloadProgress from '../ui/DownloadProgress.svelte'
  import { parseModelIdentityFromPath } from '../../../../lib/speech/model-path-validation'
  import type { AppConfigPatch } from '$shared/types'
  import type { SpeechDestructiveAction, SpeechSettings } from '../../../../lib/speech/types'
  import type { SpeechModelArtifact } from '../../../../lib/speech/types'
  import { invoke } from '$lib/ipc.svelte'
  import { speechSettingsStore as speech } from '$lib/stores/speech.svelte'
  import Switch from '../ui/Switch.svelte'
  import Modal from '../ui/Modal.svelte'
  import PasteModelPathModal from './PasteModelPathModal.svelte'
  import HistoryAudioPlayer from './HistoryAudioPlayer.svelte'

  interface Props {
    settings: SpeechSettings
    settingsReady: boolean
    updateConfig: (patch: AppConfigPatch) => Promise<void>
  }

  interface PendingDeletion {
    action: SpeechDestructiveAction
    targetId: string
    label: string
    isImported?: boolean
  }

  type SoundTab = 'models' | 'history' | 'learning' | 'preferences'
  type ModelSubTab = 'asr' | 'tts' | 'llm'

  let { settings, settingsReady: _settingsReady, updateConfig }: Props = $props()
  let deleting = $state<PendingDeletion | null>(null)
  let mutationBusy = $state(false)
  let activeTab = $state<SoundTab>('models')
  let activeModelSubTab = $state<ModelSubTab>('asr')
  const pasteCapability = $derived(activeModelSubTab === 'asr' ? 'asr' as const : activeModelSubTab === 'tts' ? 'tts' as const : 'cleanup' as const)
  let importing = $state(false)
  let pasteOpen = $state(false)
  let runtimeFilter = $state<'all' | import('../../../../lib/speech/types').SpeechRuntime>('all')

  const tabs: ReadonlyArray<{ id: SoundTab; label: string }> = [
    { id: 'models', label: 'Models' },
    { id: 'history', label: 'History' },
    { id: 'learning', label: 'Learning' },
    { id: 'preferences', label: 'Preferences' }
  ]

  const modelSubTabs: ReadonlyArray<{ id: ModelSubTab; label: string; hint: string }> = [
    { id: 'asr', label: 'ASR', hint: 'Speech-to-text' },
    { id: 'tts', label: 'TTS', hint: 'Speech synthesis' },
    { id: 'llm', label: 'LLM', hint: 'Cleanup models' }
  ]

  const unloadItems = [
    { key: 'asrUnload', label: 'Speech-to-text (ASR)' },
    { key: 'cleanupUnload', label: 'Cleanup LLM' },
    { key: 'ttsUnload', label: 'Text-to-speech (TTS)' }
  ] as const satisfies ReadonlyArray<{
    key: keyof Pick<SpeechSettings, 'asrUnload' | 'cleanupUnload' | 'ttsUnload'>
    label: string
  }>

  const unloadOptions = [
    { value: '5m', label: '5 minutes' },
    { value: '10m', label: '10 minutes' },
    { value: '20m', label: '20 minutes' },
    { value: '30m', label: '30 minutes' },
    { value: 'keep', label: 'Never unload' }
  ] as const satisfies ReadonlyArray<{ value: '5m' | '10m' | '20m' | '30m' | 'keep'; label: string }>

  onMount(() => {
    void speech.load()
    return () => speech.dispose()
  })

  function patch(next: Partial<SpeechSettings>): void {
    void updateConfig({ sound: { ...settings, ...next } })
  }

  function activeIdFor(sub: ModelSubTab): string | undefined {
    if (sub === 'asr') return settings.asrArtifactId
    if (sub === 'tts') return settings.ttsArtifactId
    return settings.cleanupArtifactId
  }

  function isActiveCatalog(artifactId: string, sub: ModelSubTab): boolean {
    return activeIdFor(sub) === artifactId
  }

  function isActiveImported(artifactId: string, sub: ModelSubTab): boolean {
    return activeIdFor(sub) === artifactId
  }

  function setActive(sub: ModelSubTab, artifactId: string): void {
    if (sub === 'asr') patch({ asrArtifactId: artifactId })
    else if (sub === 'tts') patch({ ttsArtifactId: artifactId })
    else patch({ cleanupArtifactId: artifactId })
  }

  function labelForInstalled(artifactId: string): string {
    const a = speech.catalog?.artifacts.find((x) => x.id === artifactId)
    if (a) return a.label
    const imp = speech.capabilities?.installedArtifacts.find((x) => x.artifactId === artifactId)
    if (imp?.importPath) {
      const parsed = parseModelIdentityFromPath(imp.importPath, imp.runtime)
      if (parsed) return parsed.displayName
      return imp.importPath.split('/').pop() ?? artifactId
    }
    return artifactId
  }

  function patchCues(next: Partial<SpeechSettings['cues']>): void {
    patch({ cues: { ...settings.cues, ...next } })
  }

  async function confirmDeletion(): Promise<void> {
    if (!deleting || mutationBusy) return
    mutationBusy = true
    const pending = deleting
    try {
      const confirmation = await invoke(
        'speech:requestConfirmation',
        pending.action,
        pending.targetId
      )
      if (!confirmation.ok) throw new Error(confirmation.error.message)
      const token = confirmation.value.token
      const result =
        pending.action === 'history-item'
          ? await invoke('speech:deleteHistory', pending.targetId, token)
          : pending.action === 'all-history'
            ? await invoke('speech:deleteAllHistory', token)
            : pending.action === 'rule'
              ? await invoke('speech:deleteCorrectionRule', pending.targetId, token)
              : pending.action === 'model' && pending.isImported
                ? await invoke('speech:unregisterModel', pending.targetId, token)
                : await invoke('speech:deleteArtifact', pending.targetId, token)
      if (!result.ok) throw new Error(result.error.message)
      deleting = null
      await speech.load()
    } catch (cause) {
      speech.error = cause instanceof Error ? cause.message : String(cause)
    } finally {
      mutationBusy = false
    }
  }

  async function saveHistoryLimit(
    event: Event & { currentTarget: HTMLInputElement }
  ): Promise<void> {
    const limit = Math.min(500, Math.max(1, Math.round(event.currentTarget.valueAsNumber)))
    patch({ historyLimit: limit })
    await invoke('speech:enforceHistoryLimit', limit)
    await speech.load()
  }

  async function pickImport(): Promise<void> {
    if (importing) return
    importing = true
    try {
      const path = await invoke('dialog:pickFolder')
      if (!path) return
      await speech.importModel(path, pasteCapability)
    } catch (cause) {
      speech.error = cause instanceof Error ? cause.message : String(cause)
    } finally {
      importing = false
    }
  }

  async function removeImported(artifactId: string, importPath: string): Promise<void> {
    deleting = {
      action: 'model',
      targetId: artifactId,
      label: `imported model ${importPath}`,
      isImported: true
    }
  }

  function runtimeBadge(runtime: string): string {
    if (runtime === 'mlx') return 'MLX'
    if (runtime === 'sherpa-onnx') return 'ONNX'
    if (runtime === 'gguf') return 'GGUF'
    if (runtime === 'coreml') return 'Core ML'
    return runtime.toUpperCase()
  }

  function runtimeBadgeClass(runtime: string): string {
    if (runtime === 'mlx') return 'bg-violet-500/15 text-violet-600 border-violet-500/20'
    if (runtime === 'sherpa-onnx') return 'bg-emerald-500/15 text-emerald-600 border-emerald-500/20'
    if (runtime === 'gguf') return 'bg-amber-500/15 text-amber-600 border-amber-500/20'
    if (runtime === 'coreml') return 'bg-blue-500/15 text-blue-600 border-blue-500/20'
    return 'bg-muted/10 text-muted border-border'
  }

  function bestForBadge(artifact: SpeechModelArtifact): { label: string; cls: string } | null {
    if (artifact.id === 'parakeet-tdt-v2-sherpa-onnx-int8') return { label: 'Best for English', cls: 'bg-sky-500 text-white border-sky-600' }
    if (artifact.id === 'parakeet-tdt-v3-sherpa-onnx-int8') return { label: 'Best for Multilingual', cls: 'bg-indigo-500 text-white border-indigo-600' }
    if (artifact.id === 'whisper-base-mlx-4bit') return { label: 'Apple Silicon · Fast', cls: 'bg-zinc-800 text-white border-zinc-700' }
    if (artifact.id === 'whisper-base-sherpa-int8') return { label: 'Portable · All platforms', cls: 'bg-white text-zinc-700 border-zinc-200' }
    if (artifact.id === 'kokoro-en-mlx-8bit') return { label: 'Best quality · MLX', cls: 'bg-violet-500 text-white border-violet-600' }
    if (artifact.id === 'kokoro-en-sherpa-v0-19') return { label: 'Portable · ONNX', cls: 'bg-white text-zinc-700 border-zinc-200' }
    if (artifact.id === 'qwen3-cleanup-mlx-0-6b-4bit') return { label: 'Recommended · MLX', cls: 'bg-violet-500 text-white border-violet-600' }
    if (artifact.id === 'sherpa-punctuation-zh-en') return { label: 'Lightweight · Portable', cls: 'bg-white text-zinc-700 border-zinc-200' }
    return null
  }

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1_048_576).toFixed(1)} MB`
    return `${(bytes / 1_073_741_824).toFixed(2)} GB`
  }

  function downloadPercent(download: { bytesReceived: number; totalBytes: number }): number {
    if (download.totalBytes <= 0) return 0
    return Math.min(100, Math.max(0, Math.round((download.bytesReceived / download.totalBytes) * 100)))
  }

  function isImportedForCapability(
    artifact: { capability?: import('../../../../lib/speech/types').SpeechCapability; runtime: import('../../../../lib/speech/types').SpeechRuntime },
    cap: import('../../../../lib/speech/types').SpeechCapability
  ): boolean {
    if (artifact.capability) return artifact.capability === cap
    // Fallback for legacy imports without capability: infer via runtime
    // gguf only belongs to cleanup, coreml only to asr
    if (artifact.runtime === 'gguf') return cap === 'cleanup'
    if (artifact.runtime === 'coreml') return cap === 'asr'
    // mlx/sherpa-onnx could be any, but without capability we hide to avoid leakage - only show on asr as safest fallback
    return cap === 'asr'
  }

  function runtimesForSubTab(sub: ModelSubTab): import('../../../../lib/speech/types').SpeechRuntime[] {
    if (sub === 'asr') return ['mlx', 'sherpa-onnx', 'coreml']
    if (sub === 'tts') return ['mlx', 'sherpa-onnx']
    return ['mlx', 'sherpa-onnx', 'gguf']
  }

  function sortedForSubTab(sub: ModelSubTab): SpeechModelArtifact[] {
    const all = speech.catalog?.artifacts ?? []
    let filtered: SpeechModelArtifact[]
    if (sub === 'asr') filtered = all.filter((a) => a.capability === 'asr')
    else if (sub === 'tts') filtered = all.filter((a) => a.capability === 'tts')
    else filtered = all.filter((a) => a.capability === 'cleanup')
    const order: Record<string, number> = {
      'parakeet-tdt-v2-sherpa-onnx-int8': 1,
      'parakeet-tdt-v3-sherpa-onnx-int8': 2,
      'whisper-base-mlx-4bit': 3,
      'whisper-base-sherpa-int8': 4,
      'kokoro-en-mlx-8bit': 1,
      'kokoro-en-sherpa-v0-19': 2,
      'qwen3-cleanup-mlx-0-6b-4bit': 1,
      'sherpa-punctuation-zh-en': 2
    }
    const sorted = [...filtered].sort((a, b) => (order[a.id] ?? 99) - (order[b.id] ?? 99))
    if (runtimeFilter !== 'all') return sorted.filter((a) => a.runtime === runtimeFilter)
    return sorted
  }
</script>

<div class="mx-auto max-w-3xl p-6 pb-24">
  <div class="mb-6 flex items-start justify-between gap-4">
    <div>
      <h1 class="text-xl font-bold tracking-tight">Sound</h1>
      <p class="mt-0.5 text-sm text-muted">
        Local dictation, cleanup, models, and spoken responses.
      </p>
    </div>
    <button
      type="button"
      class="flex h-8 w-8 items-center justify-center rounded-lg border bg-elevated text-muted hover:text-foreground"
      title="Refresh Sound settings"
      aria-label="Refresh Sound settings"
      onclick={() => void speech.load()}
    >
      <RefreshCw size={14} class={speech.loading ? 'animate-spin' : ''} aria-hidden="true" />
    </button>
  </div>

  {#if speech.error}
    <p class="mb-4 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
      {speech.error}
    </p>
  {/if}

  <div
    class="mb-6 flex items-center gap-1 rounded-lg border bg-surface p-1"
    role="tablist"
    aria-label="Sound settings sections"
    data-onboarding="sound-settings"
  >
    {#each tabs as tab (tab.id)}
      <button
        type="button"
        role="tab"
        aria-selected={activeTab === tab.id}
        class="flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors {activeTab ===
        tab.id
          ? 'bg-elevated text-foreground'
          : 'text-muted hover:text-foreground'}"
        onclick={() => (activeTab = tab.id)}
      >
        {tab.label}
      </button>
    {/each}
  </div>

  <div class="space-y-4">
    {#if activeTab === 'models'}
      <!-- Model capability sub-tabs -->
      <div class="flex items-center gap-1 rounded-lg border bg-surface p-1" role="tablist" aria-label="Model categories">
        {#each modelSubTabs as sub (sub.id)}
          <button
            type="button"
            role="tab"
            aria-selected={activeModelSubTab === sub.id}
            class="flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors {activeModelSubTab === sub.id ? 'bg-elevated text-foreground shadow-sm' : 'text-muted hover:text-foreground'}"
            onclick={() => { activeModelSubTab = sub.id; runtimeFilter = 'all' }}
          >
            <span class="block text-sm font-semibold leading-none">{sub.label}</span>
            <span class="block text-[10px] font-normal leading-none opacity-70">{sub.hint}</span>
          </button>
        {/each}
      </div>

      <div class="flex items-center justify-end gap-3">
        {#if activeIdFor(activeModelSubTab)}
          <button
            type="button"
            class="text-xs text-muted hover:text-foreground hover:underline underline-offset-2"
            title="Scroll to active model"
            aria-label="Scroll to active model {labelForInstalled(activeIdFor(activeModelSubTab)!)}"
            onclick={() => {
              const id = activeIdFor(activeModelSubTab)
              if (!id) return
              const el = document.getElementById(`model-card-${id}`)
              el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
            }}
          >
            Active: <span class="font-semibold text-foreground">{labelForInstalled(activeIdFor(activeModelSubTab)!)}</span>
          </button>
        {/if}
        <div class="ml-auto flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            class="inline-flex items-center gap-1 rounded-lg border bg-elevated px-2.5 py-1 text-xs text-muted hover:text-foreground disabled:opacity-50"
            title="Import your own model (.mlx or .gguf)"
            aria-label="Import model for {activeModelSubTab.toUpperCase()}"
            disabled={importing}
            onclick={() => void pickImport()}
          >
            {#if importing}
              <LoaderCircle size={12} class="animate-spin" aria-hidden="true" />
            {:else}
              <Upload size={12} aria-hidden="true" />
            {/if}
            Import
          </button>
          <button
            type="button"
            class="inline-flex items-center gap-1 rounded-lg border bg-elevated px-2.5 py-1 text-xs text-muted hover:text-foreground"
            title="Paste a filesystem path to a model"
            aria-label="Paste model path for {activeModelSubTab.toUpperCase()}"
            onclick={() => (pasteOpen = true)}
          >
            <ClipboardPaste size={12} aria-hidden="true" />
            Paste Path
          </button>
        </div>
      </div>
      {#if !activeIdFor(activeModelSubTab)}
        <p class="rounded-lg border border-dashed px-3 py-2 text-xs text-dimmed">No active model — import or download one and set it active.</p>
      {/if}

      {@const importedForTab = (speech.capabilities?.installedArtifacts ?? []).filter(
        (item) => item.source === 'import' && isImportedForCapability(item, pasteCapability)
      )}
      {#if importedForTab.length > 0}
        <div class="space-y-2">
          <p class="text-xs font-semibold uppercase tracking-wide text-muted">
            Imported · {activeModelSubTab.toUpperCase()} — {importedForTab.length} model{importedForTab.length === 1 ? '' : 's'}
          </p>
          {#each importedForTab as artifact (artifact.artifactId)}
              {@const parsedImp = artifact.importPath ? parseModelIdentityFromPath(artifact.importPath, artifact.runtime) : null}
              {@const impDetails = parsedImp ? parsedImp.details.filter((d) => d.label !== 'Family' && d.label !== 'Runtime') : []}
              <div id="model-card-{artifact.artifactId}" class="flex items-start gap-3 rounded-xl border px-3 py-3 {isActiveImported(artifact.artifactId, activeModelSubTab) ? 'bg-success/[0.04] border-success/25' : 'bg-elevated border-border/70'}">
                <div class="min-w-0 flex-1">
                  {#if parsedImp}
                    <div class="flex flex-wrap items-center gap-1.5">
                      <p class="truncate text-sm font-semibold leading-none" title={parsedImp.baseWithoutExtension}>{parsedImp.displayName}</p>
                      <span class="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium {runtimeBadgeClass(artifact.runtime)}">{runtimeBadge(artifact.runtime)}</span>
                      <span class="text-[10px] text-dimmed">· external</span>
                      {#if isActiveImported(artifact.artifactId, activeModelSubTab)}
                        <span class="inline-flex items-center gap-1 rounded-full bg-success px-2 py-0.5 text-[10px] font-semibold text-white"><Check size={10} aria-hidden="true" /> Active</span>
                      {/if}
                    </div>
                    <p class="mt-1 truncate font-mono text-[11px] leading-none text-dimmed" title={artifact.importPath}>{artifact.importPath}</p>
                    {#if impDetails.length}
                      <p class="mt-1.5 flex flex-wrap items-center gap-x-1 text-[11px] leading-none text-muted">
                        {#each impDetails as d, i (d.label)}
                          <span class="font-medium">{d.value}</span>{#if i < impDetails.length - 1}<span class="mx-0.5 opacity-30">·</span>{/if}
                        {/each}
                      </p>
                    {/if}
                    {#if parsedImp.tokens.length}
                      <p class="mt-1 font-mono text-[10px] leading-none text-dimmed/80">{parsedImp.tokens.join(' · ')}</p>
                    {/if}
                  {:else}
                    <p class="truncate text-sm font-medium">{artifact.importPath}</p>
                    <p class="mt-1 inline-flex items-center gap-1.5 text-[10px] text-dimmed">
                      <span class="inline-flex rounded-full border px-2 py-0.5 text-[10px] font-medium {runtimeBadgeClass(artifact.runtime)}">{runtimeBadge(artifact.runtime)}</span>
                      <span>· external</span>
                    </p>
                  {/if}
                </div>
                <div class="flex shrink-0 items-center gap-1">
                  {#if !isActiveImported(artifact.artifactId, activeModelSubTab)}
                    <button
                      type="button"
                      class="inline-flex items-center gap-1 rounded-lg bg-primary px-2.5 py-1 text-xs font-medium text-on-primary hover:bg-primary/90"
                      title="Make this imported model active"
                      aria-label="Make imported {artifact.importPath} active"
                      onclick={() => setActive(activeModelSubTab, artifact.artifactId)}
                    ><Star size={11} aria-hidden="true" /> Set Active</button
                    >
                  {/if}
                  {#if !isActiveImported(artifact.artifactId, activeModelSubTab)}<button
                    type="button"
                    class="flex h-7 w-7 items-center justify-center rounded-lg border border-transparent text-dimmed hover:border-border hover:bg-surface hover:text-muted"
                    title={`Unregister ${artifact.importPath}`}
                    aria-label={`Unregister ${artifact.importPath}`}
                    onclick={() => removeImported(artifact.artifactId, artifact.importPath ?? '')}
                    ><Trash2 size={12} aria-hidden="true" /></button>{/if}
                </div>
              </div>
            {/each}
        </div>
      {/if}

      <!-- Runtime filter -->
      <div class="flex flex-wrap items-center gap-1.5">
        <span class="text-[11px] font-medium text-muted">Filter:</span>
        <button
          type="button"
          class="rounded-full border px-2.5 py-1 text-[11px] font-medium {runtimeFilter === 'all' ? 'bg-primary text-on-primary border-primary' : 'bg-elevated text-muted border-border hover:text-foreground'}"
          onclick={() => runtimeFilter = 'all'}
        >All</button>
        {#each runtimesForSubTab(activeModelSubTab) as rt (rt)}
          <button
            type="button"
            class="rounded-full border px-2.5 py-1 text-[11px] font-medium {runtimeFilter === rt ? 'bg-primary text-on-primary border-primary' : 'bg-elevated text-muted border-border hover:text-foreground'}"
            onclick={() => runtimeFilter = rt}
          >{runtimeBadge(rt)}</button>
        {/each}
      </div>

      <!-- Catalog models — no max-height, expands naturally; imported already at top -->
      <div class="space-y-3">
        {#each sortedForSubTab(activeModelSubTab) as artifact (artifact.id)}
          {@const installed = speech.capabilities?.installedArtifacts.find(
            (item) => item.artifactId === artifact.id && item.available
          )}
          {@const download = speech.downloads[artifact.id]}
          {@const badge = bestForBadge(artifact)}
          {@const isRetired = artifact.qualification.status === 'retired'}
          {@const downloadLabel = isRetired
            ? `${artifact.label} is retired`
            : `Download ${artifact.label}`}
          <div id="model-card-{artifact.id}" class="rounded-xl border p-3 {isActiveCatalog(artifact.id, activeModelSubTab) ? 'bg-success/5 border-success/30 ring-1 ring-success/20' : 'bg-elevated'}">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-1.5">
                  <p class="truncate text-sm font-semibold">{artifact.label}</p>
                  <span class="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium {runtimeBadgeClass(artifact.runtime)}">{runtimeBadge(artifact.runtime)}</span>
                  {#if badge}
                    <span class="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold {badge.cls}">{badge.label}</span>
                  {/if}
                  {#if isActiveCatalog(artifact.id, activeModelSubTab)}
                    <span class="inline-flex items-center gap-1 rounded-full bg-success px-2 py-0.5 text-[10px] font-semibold text-white border-success"><Check size={10} aria-hidden="true" /> Active</span>
                  {/if}
                </div>
                <p class="mt-1 text-xs leading-relaxed text-muted">{artifact.description}</p>
                <p class="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-dimmed">
                  <span>{(artifact.byteSize / 1_048_576).toFixed(0)} MB</span>
                  <span class="opacity-40">·</span>
                  <span>{artifact.license}</span>
                  <span class="opacity-40">·</span>
                  <span class={artifact.qualification.status === 'qualified' ? 'text-success' : 'text-amber-600'}>{artifact.qualification.status}</span>
                  {#if artifact.languages.length}
                    <span class="opacity-40">·</span>
                    <span>{artifact.languages.join(', ')}</span>
                  {/if}
                </p>
                <a href={artifact.sourcePageUrl} target="_blank" rel="noreferrer" class="mt-1 inline-flex items-center gap-1 text-[11px] text-primary hover:underline">
                  Hugging Face <ExternalLink size={10} aria-hidden="true" />
                </a>
              </div>
              <div class="flex shrink-0 flex-col items-end gap-1.5">
                {#if installed}
                  {#if !isActiveCatalog(artifact.id, activeModelSubTab)}
                    <button
                      type="button"
                      class="flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-danger/10 hover:text-danger"
                    title={`Delete ${artifact.label}`}
                    aria-label={`Delete ${artifact.label}`}
                    onclick={() =>
                      (deleting = { action: 'model', targetId: artifact.id, label: artifact.label })}
                    ><Trash2 size={14} aria-hidden="true" /></button
                  >{/if}
                {:else if download?.state === 'downloading' || download?.state === 'verifying' || download?.state === 'queued'}
                  <button
                    type="button"
                    class="flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-muted/20"
                    title={`Cancel ${artifact.label} download`}
                    aria-label={`Cancel ${artifact.label} download`}
                    onclick={() => void speech.cancelDownload(artifact.id)}
                    ><X size={14} aria-hidden="true" /></button
                  >
                {:else}
                  <button
                    type="button"
                    class="flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-elevated hover:text-foreground disabled:opacity-40"
                    title={downloadLabel}
                    aria-label={downloadLabel}
                    disabled={isRetired}
                    onclick={() => void speech.download(artifact.id)}
                    ><Download size={14} aria-hidden="true" /></button
                  >
                {/if}
              </div>
            </div>
            {#if download?.state === 'downloading' || download?.state === 'verifying' || download?.state === 'queued'}
              {@const pct = download.state === 'queued' ? 0 : download.state === 'verifying' ? 100 : downloadPercent(download)}
              {@const isVerifying = download.state === 'verifying'}
              {@const isQueued = download.state === 'queued'}
              <div class="mt-3">
                <DownloadProgress
                  percent={pct}
                  label={isVerifying ? 'Verifying…' : isQueued ? 'Queued… — waiting to start' : 'Downloading…'}
                  detail={download.state === 'downloading' ? `${formatBytes(download.bytesReceived)} / ${formatBytes(download.totalBytes)}` : isVerifying ? `${formatBytes(download.bytesReceived)} · checksum` : `Position ${download.position}`}
                  tone={isVerifying ? 'verifying' : 'default'}
                  ariaLabel={`Download progress ${pct}%`}
                  onCancel={() => void speech.cancelDownload(artifact.id)}
                  cancelLabel={`Cancel ${artifact.label} download`}
                  hint={download.state === 'downloading' ? 'Large models can take a few minutes — you can keep using the app.' : undefined}
                />
              </div>
            {/if}
            {#if download?.state === 'failed'}
              <div class="mt-3 flex items-start justify-between gap-2 rounded-lg border border-danger/20 bg-danger/5 px-3 py-2">
                <p class="text-[11px] leading-snug text-danger">
                  Download failed{download.error?.message ? `: ${download.error.message}` : '.'}
                </p>
                <button type="button" class="shrink-0 rounded-md border bg-elevated px-2 py-1 text-[11px] font-medium text-foreground hover:bg-surface" onclick={() => void speech.download(artifact.id)}>Retry</button>
              </div>
            {/if}
            {#if download?.state === 'cancelled'}
              <p class="mt-3 rounded-lg border bg-muted/10 px-3 py-2 text-[11px] text-muted">Download cancelled.</p>
            {/if}
            <div class="mt-3 flex items-center gap-1.5 border-t pt-3">
              {#if installed}
                {#if isActiveCatalog(artifact.id, activeModelSubTab)}
                  <span class="inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-[11px] font-semibold text-success border border-success/20">
                    <Check size={11} aria-hidden="true" /> Active
                  </span>
                {:else}
                  <button
                    type="button"
                    class="inline-flex items-center gap-1 rounded-md border bg-primary/10 px-2 py-1 text-[11px] font-medium text-primary hover:bg-primary/15"
                    title="Make {artifact.label} active"
                    aria-label="Make {artifact.label} active"
                    onclick={() => setActive(activeModelSubTab, artifact.id)}
                  >
                    <Star size={11} aria-hidden="true" /> Set Active
                  </button>
                {/if}
              {/if}
              <button
                type="button"
                class="inline-flex items-center gap-1 rounded-md border bg-surface px-2 py-1 text-[11px] text-muted hover:text-foreground disabled:opacity-50"
                title="Import a local model file for this family"
                aria-label="Import for {artifact.label}"
                disabled={importing}
                onclick={() => void pickImport()}
              >
                <Upload size={11} aria-hidden="true" /> Import
              </button>
              <button
                type="button"
                class="inline-flex items-center gap-1 rounded-md border bg-surface px-2 py-1 text-[11px] text-muted hover:text-foreground"
                title="Paste a filesystem path for this family"
                aria-label="Paste path for {artifact.label}"
                onclick={() => (pasteOpen = true)}
              >
                <ClipboardPaste size={11} aria-hidden="true" /> Paste Path
              </button>
            </div>
          </div>
        {/each}
        {#if sortedForSubTab(activeModelSubTab).length === 0}
          <p class="py-8 text-center text-sm text-dimmed">No models in this category.</p>
        {/if}
      </div>


    {/if}

    {#if activeTab === 'history'}
      <section id="settings-block-sound-history" class="rounded-xl border bg-surface p-4">
        <div class="mb-3 flex items-center justify-between gap-3">
          <div>
            <h2 class="text-xs font-semibold uppercase tracking-wide text-muted">
              Recording history
            </h2>
            <p class="mt-1 text-[11px] text-dimmed">
              Every success and failure counts toward retention. Audio, raw transcript, and cleaned
              transcript are kept per attempt. Oldest attempts are evicted first at the limit.
            </p>
          </div>
          <label class="flex items-center gap-2 text-xs text-muted"
            >Keep <input
              class="w-16 rounded-lg border bg-elevated px-2 py-1 text-right"
              type="number"
              min="1"
              max="500"
              value={settings.historyLimit}
              aria-label="Speech history limit"
              onchange={(event) => void saveHistoryLimit(event)}
            /></label
          >
        </div>
        <div class="max-h-80 divide-y divide-border overflow-y-auto">
          {#each speech.history.items as attempt (attempt.id)}
            <div class="py-3">
              <div class="flex items-start gap-3">
                <div class="min-w-0 flex-1">
                  <p class="text-xs font-medium">
                    {new Date(attempt.createdAt).toLocaleString()} · {attempt.stage}
                  </p>
                  <p class="mt-0.5 line-clamp-2 text-[11px] text-dimmed">
                    {attempt.finalTranscript ??
                      attempt.rawTranscript ??
                      attempt.errors.at(-1)?.error.message ??
                      'No transcript'}
                  </p>
                  <p class="mt-1 text-[10px] text-dimmed">
                    {(attempt.byteSize / 1024).toFixed(1)} KB{attempt.runtime
                      ? ` · ${attempt.runtime}`
                      : ''}{attempt.rawTranscript ? ' · raw + cleaned' : ''}{attempt.retries.length
                      ? ` · ${attempt.retries.length} retries`
                      : ''}
                  </p>
                </div>
              {#if attempt.audioAvailable && attempt.stage === 'failed'}
                {@const asr = speech.catalog?.artifacts.find(
                  (item) =>
                    item.capability === 'asr' &&
                    item.qualification.status !== 'retired' &&
                    speech.capabilities?.installedArtifacts.some(
                      (installed) => installed.available && installed.artifactId === item.id
                    )
                )}
                <button
                  type="button"
                  class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-elevated disabled:opacity-40"
                  title="Retry transcription"
                  aria-label="Retry transcription"
                  disabled={!asr}
                  onclick={() => asr && void speech.retry(attempt.id, asr.runtime, asr.id)}
                  ><RefreshCw size={13} aria-hidden="true" /></button
                >
              {/if}
              <button
                type="button"
                class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-danger/10 hover:text-danger"
                title="Delete recording attempt"
                aria-label="Delete recording attempt"
                onclick={() =>
                  (deleting = {
                    action: 'history-item',
                    targetId: attempt.id,
                    label: new Date(attempt.createdAt).toLocaleString()
                  })}><Trash2 size={13} aria-hidden="true" /></button
              >
              </div>
              {#if attempt.audioAvailable}
                <div class="mt-2">
                  <HistoryAudioPlayer attemptId={attempt.id} mimeType={attempt.mimeType} label="Recording {new Date(attempt.createdAt).toLocaleString()}" />
                </div>
              {/if}
            </div>
          {/each}
        </div>
        {#if speech.history.total > 0}<button
            type="button"
            class="mt-3 text-xs text-danger hover:underline"
            onclick={() =>
              (deleting = { action: 'all-history', targetId: 'all', label: 'all recording history' })}
            >Delete all history</button
          >{/if}
      </section>
    {/if}

    {#if activeTab === 'learning'}
      <section id="settings-block-sound-rules" class="rounded-xl border bg-surface p-4">
        <h2 class="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">
          Learned corrections
        </h2>
        <p class="mb-3 text-xs text-dimmed">
          CodeInOven learns from the words you correct before sending and applies them to future
          transcripts within each project or chat context.
        </p>
        {#if speech.rules.length === 0}<p class="text-xs text-dimmed">
            No corrections learned yet.
          </p>{/if}
        {#each speech.rules as rule (rule.id)}
          <div class="flex items-center gap-3 border-t py-2 first:border-0">
            <div class="min-w-0 flex-1">
              <p class="truncate text-xs">
                <span class="text-muted">{rule.source}</span> → {rule.replacement}
              </p>
              <p class="text-[10px] text-dimmed">
                {rule.scope.kind} · {Math.round(rule.confidence * 100)}% · {rule.evidenceCount}
                observations
              </p>
            </div>
            <Switch
              checked={rule.enabled}
              onchange={(checked) => void speech.setRuleEnabled(rule.id, checked)}
              aria-label={`Toggle correction ${rule.source}`}
            /><button
              type="button"
              class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-danger/10 hover:text-danger"
              title={`Delete correction ${rule.source}`}
              aria-label={`Delete correction ${rule.source}`}
              onclick={() =>
                (deleting = {
                  action: 'rule',
                  targetId: rule.id,
                  label: `${rule.source} → ${rule.replacement}`
                })}><Trash2 size={13} aria-hidden="true" /></button
            >
          </div>
        {/each}
      </section>
    {/if}

    {#if activeTab === 'preferences'}
      <section id="settings-block-sound-cleanup" class="rounded-xl border bg-surface p-4">
        <h2 class="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">
          Transcript cleanup
        </h2>
        <div class="space-y-4">
          <div class="flex items-center justify-between gap-4">
            <div>
              <p class="text-sm font-medium">Local cleanup</p>
              <p class="text-xs text-dimmed">Punctuation and learned rules stay on this device.</p>
            </div>
            <Switch
              checked={settings.localCleanupEnabled}
              onchange={(checked) => patch({ localCleanupEnabled: checked })}
              aria-label="Toggle local transcript cleanup"
            />
          </div>
          <div class="flex items-center justify-between gap-4">
            <div>
              <p class="text-sm font-medium">Remote cleanup</p>
              <p class="text-xs text-dimmed">
                Send transcript text and minimal context only. Audio never leaves the device.
              </p>
            </div>
            <Switch
              checked={settings.remoteCleanupEnabled}
              onchange={(checked) => patch({ remoteCleanupEnabled: checked })}
              aria-label="Toggle remote transcript cleanup"
            />
          </div>
          <div class="flex items-center justify-between gap-4">
            <div>
              <p class="text-sm font-medium">Local-LLM cleanup</p>
              <p class="text-xs text-dimmed">
                Format transcripts with a local LLM (llama.cpp/GGUF or MLX). Point at a running
                server, or leave blank to use the app-managed runtime.
              </p>
            </div>
            <Switch
              checked={settings.localLlmCleanupEnabled}
              onchange={(checked) => patch({ localLlmCleanupEnabled: checked })}
              aria-label="Toggle local-LLM transcript cleanup"
            />
          </div>
          <label class="block text-xs text-muted">
            Local-LLM server base URL
            <input
              class="mt-1 w-full rounded-lg border bg-elevated px-2.5 py-2 text-xs outline-none focus:border-primary disabled:opacity-50"
              type="text"
              value={settings.localLlmBaseUrl ?? ''}
              disabled={!settings.localLlmCleanupEnabled}
              placeholder="http://127.0.0.1:8080 (LM Studio, llama.cpp server)"
              autocomplete="off"
              oninput={(event) =>
                patch({
                  localLlmBaseUrl: event.currentTarget.value.trim() || undefined
                })}
            />
          </label>
          <select
            class="w-full rounded-lg border bg-elevated px-2.5 py-2 text-xs outline-none focus:border-primary disabled:opacity-50"
            aria-label="Remote cleanup model source"
            disabled={!settings.remoteCleanupEnabled}
            value={settings.remoteCleanupSelection}
            onchange={(event) =>
              patch({
                remoteCleanupSelection: event.currentTarget.value as 'fixed' | 'conversation'
              })}
          >
            <option value="conversation">Current conversation model</option>
            <option value="fixed">Selected fixed model</option>
          </select>
          {#if settings.remoteCleanupSelection === 'fixed'}
            <label class="block text-xs text-muted">
              Fixed model ID
              <input
                class="mt-1 w-full rounded-lg border bg-elevated px-2.5 py-2 text-xs outline-none focus:border-primary disabled:opacity-50"
                type="text"
                value={settings.remoteCleanupModelId ?? ''}
                disabled={!settings.remoteCleanupEnabled}
                placeholder="Model ID from the current harness"
                autocomplete="off"
                oninput={(event) =>
                  patch({
                    remoteCleanupModelId: event.currentTarget.value.trim() || undefined
                  })}
              />
            </label>
          {/if}
        </div>
      </section>

      <section id="settings-block-sound-voice-recording" class="rounded-xl border bg-surface p-4">
        <div class="flex items-center justify-between gap-4">
          <div>
            <p class="text-sm font-medium">Enable voice recording</p>
            <p class="text-xs text-dimmed">
              When no local speech-to-text model is installed, dictation can send audio to an
              audio-capable conversation model. Audio never leaves this device unless you turn this
              on. Off by default.
            </p>
          </div>
          <Switch
            checked={settings.voiceRecordingEnabled}
            onchange={(checked) => patch({ voiceRecordingEnabled: checked })}
            aria-label="Toggle voice recording via the conversation model"
          />
        </div>
      </section>

      <section id="settings-block-sound-memory" class="rounded-xl border bg-surface p-4">
        <h2 class="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">Model memory</h2>
        <div class="space-y-3">
          {#each unloadItems as item (item.key)}
            <label class="flex items-center justify-between gap-3 text-xs text-muted">
              {item.label}
              <select
                class="rounded-lg border bg-elevated px-2.5 py-1.5 text-xs outline-none focus:border-primary"
                aria-label={`${item.label} unload delay`}
                value={settings[item.key]}
                onchange={(event) =>
                  patch({
                    [item.key]: event.currentTarget.value as '5m' | '10m' | '20m' | '30m' | 'keep'
                  })}
              >
                {#each unloadOptions as option (option.value)}
                  <option value={option.value}>{option.label}</option>
                {/each}
              </select>
            </label>
          {/each}
        </div>
      </section>

      <section id="settings-block-sound-cues" class="rounded-xl border bg-surface p-4">
        <h2 class="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">
          Cues and playback
        </h2>
        <div class="grid gap-3 sm:grid-cols-2">
          <Switch
            checked={settings.cues.listeningStarted}
            onchange={(checked) => patchCues({ listeningStarted: checked })}
            label="Listening started"
            aria-label="Toggle listening-start cue"
          />
          <Switch
            checked={settings.cues.recordingStopped}
            onchange={(checked) => patchCues({ recordingStopped: checked })}
            label="Recording stopped"
            aria-label="Toggle recording-stop cue"
          />
          <Switch
            checked={settings.cues.transcriptReady}
            onchange={(checked) => patchCues({ transcriptReady: checked })}
            label="Transcript ready"
            aria-label="Toggle transcript-ready cue"
          />
          <Switch
            checked={settings.includeCodeBlocksInSpeech}
            onchange={(checked) => patch({ includeCodeBlocksInSpeech: checked })}
            label="Read code blocks"
            aria-label="Toggle code blocks in spoken responses"
          />
        </div>
        <label class="mt-4 flex items-center gap-3 text-xs text-muted">
          Cue volume
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={settings.cues.volume}
            aria-label="Speech cue volume"
            oninput={(event) => patchCues({ volume: event.currentTarget.valueAsNumber })}
          />
        </label>
      </section>
    {/if}
  </div>
</div>

<PasteModelPathModal open={pasteOpen} capability={pasteCapability} onClose={() => (pasteOpen = false)} onImported={() => void speech.load()} />

<Modal open={deleting !== null} title="Confirm deletion" onClose={() => (deleting = null)}>
  <p class="text-sm text-muted">
    Delete {deleting?.label}? This removes the app-owned data and cannot be undone. Imported files
    are never deleted.
  </p>
  {#snippet footer()}
    <button
      type="button"
      class="rounded-lg border px-3 py-1.5 text-sm"
      onclick={() => (deleting = null)}>Cancel</button
    >
    <button
      type="button"
      class="rounded-lg bg-danger px-3 py-1.5 text-sm font-medium text-on-danger disabled:opacity-50"
      data-modal-primary
      disabled={mutationBusy}
      onclick={() => void confirmDeletion()}
      >{#if mutationBusy}<LoaderCircle
          size={13}
          class="mr-1 inline animate-spin"
          aria-hidden="true"
        />{/if}Delete</button
    >
  {/snippet}
</Modal>
