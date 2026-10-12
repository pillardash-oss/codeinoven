<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import {
    CircleAlert,
    ClipboardPaste,
    Download,
    LoaderCircle,
    RefreshCw,
    Trash2,
    Upload
  } from '@lucide/svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { searchSettingsStore as search } from '$lib/stores/search.svelte'
  import { formatCompactAge } from '../../../../lib/date-time-format'
  import {
    SEARCH_CONTEXT_TOKENS_MAX,
    SEARCH_CONTEXT_TOKENS_MIN,
    clampSearchContextTokens,
    type SearchDownloadState,
    type SearchModelArtifact
  } from '../../../../lib/search/types'
  import type { SpeechLlamaRuntimeStatus } from '../../../../lib/speech/types'
  import DownloadProgress from '../ui/DownloadProgress.svelte'
  import Switch from '../ui/Switch.svelte'
  import ConfirmDialog from '../ui/ConfirmDialog.svelte'
  import PasteModelPathModal from './PasteModelPathModal.svelte'
  import { downloadPercent, formatBytes } from './sound-settings-helpers'

  const searchState = $derived(search.state)
  const status = $derived(searchState?.status ?? null)
  const models = $derived(searchState?.models ?? [])
  const catalog = $derived(searchState?.catalog ?? [])
  const downloads = $derived(searchState?.downloads ?? {})
  const enabled = $derived(searchState?.settings.enabled ?? false)
  const contextTokens = $derived(searchState?.settings.contextTokens ?? SEARCH_CONTEXT_TOKENS_MIN)
  const installedIds = $derived(new Set(models.map((model) => model.id)))
  const availableArtifacts = $derived(catalog.filter((artifact) => !installedIds.has(artifact.id)))
  const activeModelLabel = $derived(
    models.find((model) => model.id === status?.activeModelId)?.label ?? 'None'
  )

  let llamaRuntime: SpeechLlamaRuntimeStatus | null = $state(null)
  let installingRuntime = $state(false)
  let pasteOpen = $state(false)
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

  function saveContextTokens(event: Event & { currentTarget: HTMLInputElement }): void {
    const next = Number(event.currentTarget.value)
    if (!Number.isFinite(next)) return
    const clamped = clampSearchContextTokens(next)
    // Reflect the clamped value even when the write is a no-op, so the field
    // never keeps a number the app did not accept.
    event.currentTarget.value = String(clamped)
    if (clamped !== contextTokens) void search.setContextTokens(clamped)
  }

  onMount(() => {
    void search.load()
    void loadRuntime()
  })
  onDestroy(() => search.dispose())
</script>

<div class="p-6 pb-24">
  <div class="mb-6 flex items-start justify-between gap-4">
    <div class="min-w-0">
      <h1 class="text-xl font-bold tracking-tight">Search by intent</h1>
      <p class="mt-0.5 text-sm text-muted">
        Blends keyword hits with meaning-based matches on every thread search. Title matches stay
        first, semantic matches follow, keyword-only finds come last.
      </p>
      {#if !canEnable}
        <p class="mt-1.5 text-xs text-dimmed">Install an embedding model below to turn this on.</p>
      {/if}
    </div>
    <div class="flex shrink-0 items-center gap-2">
      <Switch
        checked={enabled}
        disabled={!canEnable}
        label="Enabled"
        title="Turn intent search on or off"
        aria-label="Enable intent search"
        onchange={(checked) => void search.setEnabled(checked)}
      />
      <button
        type="button"
        class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border bg-elevated text-muted hover:text-foreground"
        title="Refresh search settings"
        aria-label="Refresh search settings"
        onclick={() => void search.load()}
      >
        <RefreshCw size={14} class={search.loading ? 'animate-spin' : ''} aria-hidden="true" />
      </button>
    </div>
  </div>

  {#if search.error}
    <p class="mb-4 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
      {search.error}
    </p>
  {/if}

  <div class="space-y-4">
    {#if status && !status.runtimeAvailable}
      <div class="flex items-start gap-3 rounded-xl border border-warning/40 bg-warning/10 p-4">
        <CircleAlert size={16} class="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
        <div class="min-w-0 flex-1">
          <p class="text-sm font-medium">A local llama.cpp runtime is required</p>
          <p class="mt-0.5 text-xs leading-relaxed text-muted">
            Embedding models run through the same runtime the app uses for speech cleanup. Install
            it once and both features share it.
            {#if llamaRuntime?.downloadByteSize}
              ({llamaRuntime.downloadName} · {formatBytes(llamaRuntime.downloadByteSize)})
            {/if}
          </p>
        </div>
        <button
          type="button"
          class="flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-on-primary hover:opacity-90 disabled:opacity-50"
          disabled={installingRuntime}
          onclick={() => void installRuntime()}
        >
          {#if installingRuntime}
            <LoaderCircle size={12} class="animate-spin" aria-hidden="true" />
            Installing
          {:else}
            <Download size={12} aria-hidden="true" />
            Install
          {/if}
        </button>
      </div>
    {/if}

    <!-- Index -->
    <div class="rounded-xl border bg-surface p-4">
      <div class="mb-3 flex items-center justify-between gap-3">
        <h3 class="text-xs font-semibold uppercase tracking-wide text-muted">Index</h3>
        <button
          type="button"
          class="flex items-center gap-1.5 rounded-lg border bg-elevated px-2.5 py-1 text-xs text-muted hover:text-foreground disabled:opacity-50"
          title="Rebuild the thread index from scratch"
          aria-label="Rebuild thread index"
          disabled={!enabled || status?.indexing}
          onclick={() => void search.rebuildIndex()}
        >
          <RefreshCw size={12} class={status?.indexing ? 'animate-spin' : ''} aria-hidden="true" />
          Rebuild
        </button>
      </div>
      <div class="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
        <div>
          <p class="text-[0.6875rem] uppercase tracking-wide text-dimmed">Threads indexed</p>
          <p class="text-sm font-medium tabular-nums">{status?.indexedThreads ?? 0}</p>
        </div>
        <div>
          <p class="text-[0.6875rem] uppercase tracking-wide text-dimmed">
            {status?.indexing ? 'Indexing' : 'Waiting'}
          </p>
          <p class="flex items-center gap-1.5 text-sm font-medium">
            {#if status?.indexing}
              <LoaderCircle size={13} class="animate-spin text-primary" aria-hidden="true" />
              In progress
            {:else}
              <span class="tabular-nums">{status?.pendingThreads ?? 0}</span>
            {/if}
          </p>
        </div>
        <div class="min-w-0">
          <p class="text-[0.6875rem] uppercase tracking-wide text-dimmed">Model</p>
          <p class="truncate text-sm font-medium" title={activeModelLabel}>{activeModelLabel}</p>
        </div>
        <div>
          <p class="text-[0.6875rem] uppercase tracking-wide text-dimmed">Last indexed</p>
          <p class="text-sm font-medium">
            {status?.lastIndexedAt ? formatCompactAge(status.lastIndexedAt) : 'Never'}
          </p>
        </div>
      </div>
      <p class="mt-3 text-xs leading-relaxed text-dimmed">
        Indexing runs in the background in small batches, so it never blocks the app.
      </p>
    </div>

    <!-- Models -->
    <div class="rounded-xl border bg-surface p-4">
      <div class="mb-1 flex items-center justify-between gap-3">
        <h3 class="text-xs font-semibold uppercase tracking-wide text-muted">Embedding model</h3>
        <div class="flex items-center gap-1.5">
          <button
            type="button"
            class="flex items-center gap-1.5 rounded-lg border bg-elevated px-2.5 py-1 text-xs text-muted hover:text-foreground"
            title="Paste a path to a GGUF embedding model"
            aria-label="Paste an embedding model path"
            onclick={() => (pasteOpen = true)}
          >
            <ClipboardPaste size={12} aria-hidden="true" />
            Paste path
          </button>
          <button
            type="button"
            class="flex items-center gap-1.5 rounded-lg border bg-elevated px-2.5 py-1 text-xs text-muted hover:text-foreground"
            title="Import a GGUF embedding model from disk"
            aria-label="Import an embedding model"
            onclick={() => void search.importModel()}
          >
            <Upload size={12} aria-hidden="true" />
            Import
          </button>
        </div>
      </div>

      {#if models.length === 0}
        <p class="rounded-lg border border-dashed px-3 py-2 text-xs text-dimmed">
          No embedding model is installed. Download one below, or import a compatible GGUF model of
          your own.
        </p>
      {:else}
        <ul class="divide-y">
          {#each models as model (model.id)}
            {@const isActive = status?.activeModelId === model.id}
            <li class="flex items-center gap-3 py-2.5">
              <span
                class="size-1.5 shrink-0 rounded-full {isActive
                  ? 'bg-primary'
                  : 'bg-border-strong'}"
                aria-hidden="true"
              ></span>
              <div class="min-w-0 flex-1">
                <p class="truncate text-sm font-medium" title={model.label}>{model.label}</p>
                <p class="truncate text-xs text-dimmed">
                  {model.runtime} · {model.dimensions}-dim · {model.contextTokens > 0
                    ? `${model.contextTokens / 1024}K context`
                    : 'model context'} · {formatBytes(model.byteSize)} ·
                  {model.source === 'imported' ? 'imported' : 'catalog'}
                </p>
              </div>
              {#if isActive}
                <span
                  class="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[0.6875rem] font-medium text-primary"
                  >Active</span
                >
              {:else}
                <button
                  type="button"
                  class="shrink-0 rounded-lg border bg-elevated px-2.5 py-1 text-xs text-muted hover:text-foreground"
                  title="Use this model for intent search"
                  aria-label="Use {model.label} for intent search"
                  onclick={() => void search.setActiveModel(model.id)}
                >
                  Use
                </button>
              {/if}
              <button
                type="button"
                class="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-danger/10 hover:text-danger"
                title="Remove this model"
                aria-label="Remove {model.label}"
                onclick={() => (pendingDelete = { id: model.id, label: model.label })}
              >
                <Trash2 size={13} aria-hidden="true" />
              </button>
            </li>
          {/each}
        </ul>
      {/if}

      {#if availableArtifacts.length > 0}
        <div class="mt-4 border-t pt-3">
          <p class="mb-1 text-[0.6875rem] font-semibold uppercase tracking-wide text-dimmed">
            Available
          </p>
          <ul class="divide-y">
            {#each availableArtifacts as artifact (artifact.id)}
              {@render artifactRow(artifact)}
            {/each}
          </ul>
        </div>
      {/if}

      <div class="mt-4 border-t pt-3">
        <div class="flex items-start justify-between gap-6">
          <div class="min-w-0">
            <p class="text-sm font-medium">Context window</p>
            <p class="mt-0.5 text-xs leading-relaxed text-muted">
              How many tokens of each thread the model reads when it embeds. A wider window keeps
              more of a long conversation; a narrower one is faster.
            </p>
            <p class="mt-1 text-xs text-dimmed">Changing it clears the index and rebuilds it.</p>
          </div>
          <label class="flex shrink-0 items-center gap-2 text-xs text-muted">
            <input
              class="w-24 rounded-lg border bg-elevated px-2 py-1 text-right tabular-nums"
              type="number"
              min={SEARCH_CONTEXT_TOKENS_MIN}
              max={SEARCH_CONTEXT_TOKENS_MAX}
              step="1024"
              value={contextTokens}
              aria-label="Embedding context window in tokens"
              onchange={saveContextTokens}
            />
            tokens
          </label>
        </div>
      </div>
    </div>
  </div>
</div>

{#snippet artifactRow(artifact: SearchModelArtifact)}
  {@const download = downloadState(artifact.id)}
  <li class="py-3">
    <div class="flex items-start justify-between gap-6">
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
          <p class="text-sm font-medium">{artifact.label}</p>
          <span class="rounded-full bg-raised px-1.5 py-0.5 text-[0.6875rem] text-muted"
            >{artifact.quantization}</span
          >
        </div>
        <p class="mt-1 text-xs leading-relaxed text-muted">{artifact.description}</p>
        <p class="mt-1 text-xs text-dimmed">
          {formatBytes(artifact.byteSize)} · {artifact.dimensions}-dim · {artifact.contextTokens /
            1024}K context · {artifact.license}
        </p>
      </div>
      {#if !download || download.state === 'cancelled' || download.state === 'failed'}
        <button
          type="button"
          class="flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-on-primary hover:opacity-90"
          title="Download {artifact.label}"
          aria-label="Download {artifact.label}"
          onclick={() => void search.download(artifact.id)}
        >
          <Download size={12} aria-hidden="true" />
          {download?.state === 'failed' ? 'Retry' : 'Download'}
        </button>
      {/if}
    </div>

    {#if download?.state === 'downloading' || download?.state === 'verifying'}
      <div class="mt-2.5">
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
    {:else if download?.state === 'failed'}
      <p class="mt-2.5 text-xs text-danger">{download.message}</p>
    {:else if download?.state === 'cancelled'}
      <p class="mt-2.5 text-xs text-muted">Download cancelled.</p>
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

<PasteModelPathModal
  open={pasteOpen}
  title="Paste embedding model path"
  help="Embedding models are GGUF files. Paste an absolute path to a .gguf file, or a folder that contains one."
  placeholder="/Users/you/models/embeddinggemma-2-Q8_0.gguf"
  validate={(raw) => invoke('search:validateModelPath', raw)}
  onImport={(path) => search.importModelFromPath(path)}
  onClose={() => (pasteOpen = false)}
  onImported={() => void search.load()}
/>
