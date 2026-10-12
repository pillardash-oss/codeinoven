<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import {
    CircleAlert,
    Cpu,
    Database,
    Download,
    LoaderCircle,
    RefreshCw,
    Sparkles,
    Trash2,
    Upload
  } from '@lucide/svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { searchSettingsStore as search } from '$lib/stores/search.svelte'
  import { formatCompactAge } from '../../../../lib/date-time-format'
  import type { SearchDownloadState, SearchModelArtifact } from '../../../../lib/search/types'
  import type { SpeechLlamaRuntimeStatus } from '../../../../lib/speech/types'
  import DownloadProgress from '../ui/DownloadProgress.svelte'
  import Switch from '../ui/Switch.svelte'
  import ConfirmDialog from '../ui/ConfirmDialog.svelte'
  import { downloadPercent, formatBytes } from './sound-settings-helpers'

  const state = $derived(search.state)
  const status = $derived(state?.status ?? null)
  const models = $derived(state?.models ?? [])
  const catalog = $derived(state?.catalog ?? [])
  const downloads = $derived(state?.downloads ?? {})
  const enabled = $derived(state?.settings.enabled ?? false)
  const installedIds = $derived(new Set(models.map((model) => model.id)))
  const availableArtifacts = $derived(catalog.filter((artifact) => !installedIds.has(artifact.id)))

  let llamaRuntime: SpeechLlamaRuntimeStatus | null = $state(null)
  let installingRuntime = $state(false)
  let pendingDelete: { id: string; label: string } | null = $state(null)
  let deleting = $state(false)

  const canEnable = $derived(Boolean(status?.runtimeAvailable) && models.length > 0)

  function downloadState(artifactId: string): SearchDownloadState | undefined {
    return downloads[artifactId]
  }

  async function loadRuntime(): Promise<void> {
    try {
      const result = await invoke('speech:getLlamaRuntimeStatus')
      if (result.ok) llamaRuntime = result.value
    } catch {
      llamaRuntime = null
    }
  }

  async function installRuntime(): Promise<void> {
    if (installingRuntime) return
    installingRuntime = true
    try {
      await invoke('speech:downloadLlamaRuntime')
    } catch {
      // The runtime status refresh below surfaces the failure state.
    } finally {
      installingRuntime = false
      await loadRuntime()
      await search.load()
    }
  }

  async function confirmDelete(): Promise<void> {
    if (!pendingDelete) return
    deleting = true
    await search.deleteModel(pendingDelete.id)
    deleting = false
    pendingDelete = null
  }

  onMount(() => {
    void search.load()
    void loadRuntime()
  })
  onDestroy(() => search.dispose())
</script>

<div class="space-y-6 p-6 pb-24">
  <!-- Intro -->
  <section class="space-y-1">
    <h2 class="text-lg font-semibold tracking-tight">Intent search</h2>
    <p class="max-w-3xl text-sm text-muted">
      Search your threads by meaning, not just by keywords. Intent search embeds each thread with a
      local Gemma embedding model and merges the semantic matches with the existing keyword results.
      Everything runs on this machine; nothing leaves it.
    </p>
  </section>

  <!-- Runtime -->
  {#if status && !status.runtimeAvailable}
    <section class="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4">
      <div class="flex items-start gap-3">
        <CircleAlert class="mt-0.5 size-5 shrink-0 text-amber-500" />
        <div class="min-w-0 flex-1 space-y-2">
          <p class="text-sm font-medium text-foreground">A local llama.cpp runtime is required</p>
          <p class="text-sm text-muted">
            Embedding models run through the same local llama.cpp runtime the app uses for speech
            cleanup. Install it once and both features share it.
          </p>
          {#if llamaRuntime?.downloadByteSize}
            <p class="text-xs text-dimmed">
              {llamaRuntime.downloadName} · {formatBytes(llamaRuntime.downloadByteSize)}
            </p>
          {/if}
        </div>
        <button
          type="button"
          class="inline-flex h-9 shrink-0 items-center gap-2 rounded-lg bg-primary px-3 text-sm font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-50"
          disabled={installingRuntime}
          onclick={() => void installRuntime()}
        >
          {#if installingRuntime}
            <LoaderCircle class="size-4 animate-spin" />
            Installing…
          {:else}
            <Download class="size-4" />
            Install runtime
          {/if}
        </button>
      </div>
    </section>
  {/if}

  <!-- Enable -->
  <section class="rounded-xl border bg-surface p-5">
    <div class="flex items-start justify-between gap-4">
      <div class="min-w-0 space-y-1">
        <p class="flex items-center gap-2 text-sm font-semibold">
          <Sparkles class="size-4 text-muted" />
          Search by intent
        </p>
        <p class="max-w-2xl text-sm text-muted">
          When on, every thread search blends keyword hits with semantic matches. Title matches stay
          first, semantic matches follow, and keyword-only finds come last.
        </p>
        {#if !canEnable}
          <p class="text-xs text-dimmed">
            Install an embedding model below to enable intent search.
          </p>
        {/if}
      </div>
      <Switch
        checked={enabled}
        disabled={!canEnable}
        aria-label="Enable intent search"
        onchange={(checked) => void search.setEnabled(checked)}
      />
    </div>
  </section>

  <!-- Status -->
  <section class="rounded-xl border bg-surface p-5">
    <p class="mb-4 flex items-center gap-2 text-sm font-semibold">
      <Database class="size-4 text-muted" />
      Index
    </p>
    <div class="grid grid-cols-2 gap-4 sm:grid-cols-4">
      <div>
        <p class="text-xs font-semibold uppercase tracking-wide text-dimmed">Indexed threads</p>
        <p class="text-xl font-semibold tabular-nums">{status?.indexedThreads ?? 0}</p>
      </div>
      <div>
        <p class="text-xs font-semibold uppercase tracking-wide text-dimmed">Indexing</p>
        <p class="text-xl font-semibold tabular-nums">
          {#if status?.indexing}
            <LoaderCircle class="inline size-5 animate-spin text-primary" />
          {:else}
            {status?.pendingThreads ?? 0}
          {/if}
        </p>
      </div>
      <div>
        <p class="text-xs font-semibold uppercase tracking-wide text-dimmed">Active model</p>
        <p class="truncate text-sm font-medium">{status?.activeModelId ?? 'None'}</p>
      </div>
      <div>
        <p class="text-xs font-semibold uppercase tracking-wide text-dimmed">Last indexed</p>
        <p class="text-sm font-medium">
          {status?.lastIndexedAt ? formatCompactAge(status.lastIndexedAt) : 'Never'}
        </p>
      </div>
    </div>
    <div class="mt-4 flex items-center gap-3">
      <button
        type="button"
        class="inline-flex h-9 items-center gap-2 rounded-lg border bg-elevated px-3 text-sm font-medium transition-colors hover:bg-overlay disabled:opacity-50"
        disabled={!enabled || status?.indexing}
        onclick={() => void search.rebuildIndex()}
      >
        <RefreshCw class="size-4 {status?.indexing ? 'animate-spin' : ''}" />
        Rebuild index
      </button>
      <p class="text-xs text-dimmed">
        Rebuilds from scratch. Runs in the background and never blocks the app.
      </p>
    </div>
  </section>

  <!-- Installed models -->
  <section class="space-y-3">
    <div class="flex items-center justify-between gap-3">
      <p class="flex items-center gap-2 text-sm font-semibold">
        <Cpu class="size-4 text-muted" />
        Installed models
      </p>
      <button
        type="button"
        class="inline-flex h-9 items-center gap-2 rounded-lg border bg-elevated px-3 text-sm font-medium transition-colors hover:bg-overlay"
        onclick={() => void search.importModel()}
      >
        <Upload class="size-4" />
        Import model
      </button>
    </div>

    {#if models.length === 0}
      <div class="rounded-xl border border-dashed bg-surface p-4 text-sm text-muted">
        No embedding model is installed yet. Download one below, or import a compatible GGUF model
        of your own.
      </div>
    {:else}
      <ul class="divide-y overflow-hidden rounded-xl border bg-surface">
        {#each models as model (model.id)}
          {@const isActive = status?.activeModelId === model.id}
          <li class="flex items-center gap-3 p-3">
            <span
              class="size-2.5 shrink-0 rounded-full {isActive ? 'bg-primary' : 'bg-border'}"
              aria-hidden="true"
            ></span>
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-medium">{model.label}</p>
              <p class="truncate text-xs text-muted">
                {model.runtime} · {model.dimensions}-dim · {formatBytes(model.byteSize)} ·
                {model.source === 'imported' ? 'imported' : 'catalog'}
              </p>
            </div>
            {#if isActive}
              <span
                class="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
                >Active</span
              >
            {:else}
              <button
                type="button"
                class="h-8 shrink-0 rounded-lg border bg-elevated px-3 text-xs font-medium transition-colors hover:bg-overlay"
                onclick={() => void search.setActiveModel(model.id)}
              >
                Use
              </button>
            {/if}
            <button
              type="button"
              class="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-danger/10 hover:text-danger"
              title="Remove model"
              aria-label="Remove {model.label}"
              onclick={() => (pendingDelete = { id: model.id, label: model.label })}
            >
              <Trash2 class="size-4" />
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <!-- Available models -->
  <section class="space-y-3">
    <p class="text-sm font-semibold">Available models</p>
    {#if availableArtifacts.length === 0}
      <div class="rounded-xl border border-dashed bg-surface p-4 text-sm text-muted">
        Every model in the catalog is already installed.
      </div>
    {:else}
      <ul class="space-y-3">
        {#each availableArtifacts as artifact (artifact.id)}
          {@render artifactCard(artifact)}
        {/each}
      </ul>
    {/if}
  </section>
</div>

{#snippet artifactCard(artifact: SearchModelArtifact)}
  {@const download = downloadState(artifact.id)}
  <li class="rounded-xl border bg-surface p-4">
    <div class="flex items-start justify-between gap-4">
      <div class="min-w-0 space-y-1">
        <p class="flex items-center gap-2 text-sm font-medium">
          {artifact.label}
          <span class="rounded-full bg-raised px-2 py-0.5 text-xs font-medium text-muted"
            >{artifact.quantization}</span
          >
        </p>
        <p class="max-w-3xl text-sm text-muted">{artifact.description}</p>
        <p class="text-xs text-dimmed">
          {formatBytes(artifact.byteSize)} · {artifact.dimensions}-dim · {artifact.license}
        </p>
      </div>
      {#if !download || download.state === 'cancelled' || download.state === 'failed'}
        <button
          type="button"
          class="inline-flex h-9 shrink-0 items-center gap-2 rounded-lg bg-primary px-3 text-sm font-medium text-on-primary transition-colors hover:bg-primary-hover"
          onclick={() => void search.download(artifact.id)}
        >
          <Download class="size-4" />
          {download?.state === 'failed' ? 'Retry' : 'Download'}
        </button>
      {/if}
    </div>

    {#if download?.state === 'downloading' || download?.state === 'verifying'}
      <div class="mt-3">
        <DownloadProgress
          percent={download.state === 'verifying' ? 100 : downloadPercent(download)}
          label={download.state === 'verifying' ? 'Verifying…' : 'Downloading…'}
          detail="{formatBytes(download.bytesReceived)} / {formatBytes(download.totalBytes)}"
          tone={download.state === 'verifying' ? 'verifying' : 'default'}
          ariaLabel="Downloading {artifact.label}"
          onCancel={() => void search.cancelDownload(artifact.id)}
          cancelLabel="Cancel download"
        />
      </div>
    {:else if download?.state === 'installed'}
      <p class="mt-3 text-xs font-medium text-primary">Installed</p>
    {:else if download?.state === 'failed'}
      <p class="mt-3 text-xs text-danger">{download.message}</p>
    {:else if download?.state === 'cancelled'}
      <p class="mt-3 text-xs text-muted">Download cancelled.</p>
    {/if}
  </li>
{/snippet}

<ConfirmDialog
  open={pendingDelete !== null}
  title="Remove embedding model"
  confirmLabel="Remove"
  variant="danger"
  busy={deleting}
  onCancel={() => (pendingDelete = null)}
  onConfirm={() => void confirmDelete()}
>
  <p>
    Remove <span class="font-medium text-foreground">{pendingDelete?.label ?? ''}</span> and delete its
    files from disk? Intent search turns off if this is the active model.
  </p>
</ConfirmDialog>
