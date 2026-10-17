<script lang="ts">
  import CioAlertCircle from '$lib/components/icons/cio/CioAlertCircle.svelte'
  import CioClipboardPaste from '$lib/components/icons/cio/CioClipboardPaste.svelte'
  import CioDownload from '$lib/components/icons/cio/CioDownload.svelte'
  import CioRefresh from '$lib/components/icons/cio/CioRefresh.svelte'
  import CioSpinner from '$lib/components/icons/cio/CioSpinner.svelte'
  import CioTrash from '$lib/components/icons/cio/CioTrash.svelte'
  import CioUpload from '$lib/components/icons/cio/CioUpload.svelte'
  import { onDestroy, onMount } from 'svelte'

  import { invoke } from '$lib/ipc.svelte'
  import { searchSettingsStore as search } from '$lib/stores/search.svelte'
  import { formatCompactAge } from '../../../../lib/date-time-format'
  import {
    SEARCH_CONTEXT_TOKENS_MAX,
    SEARCH_CONTEXT_TOKENS_MIN,
    SEARCH_MIN_RUNTIME_BUILD,
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
  const totalThreads = $derived(status?.totalThreads ?? null)
  const completedThreads = $derived(
    totalThreads === null
      ? (status?.indexedThreads ?? 0)
      : Math.max(0, totalThreads - (status?.pendingThreads ?? 0))
  )
  const indexingPercent = $derived(
    totalThreads !== null && totalThreads > 0
      ? Math.floor((completedThreads / totalThreads) * 100)
      : 0
  )
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

  const runtimeReady = $derived(
    Boolean(status?.runtimeAvailable) && Boolean(status?.runtimeSupported)
  )
  const canEnable = $derived(runtimeReady && models.length > 0)
  const runtimeTooOld = $derived(
    status?.runtimeBuild != null && status.runtimeBuild < SEARCH_MIN_RUNTIME_BUILD
  )

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
    // An index built (or attempted) under the previous runtime is meaningless,
    // so a runtime install re-embeds instead of waiting for the periodic sweep.
    const shouldIndex = enabled && models.length > 0
    installingRuntime = true
    try {
      await invoke('speech:downloadLlamaRuntime')
    } catch {
      // The runtime status refresh below surfaces the failure state.
    } finally {
      installingRuntime = false
      await loadRuntime()
      await search.load()
      if (shouldIndex && search.state?.status.runtimeSupported) await search.rebuildIndex()
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
        <p class="mt-1.5 text-xs text-dimmed">
          {models.length === 0
            ? 'Install an embedding model below to turn this on.'
            : 'Update the local runtime below to turn this on.'}
        </p>
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
        class="flex h-8 w-8 shrink-0 items-center justify-center border bg-elevated text-muted hover:text-foreground"
        title="Refresh search settings"
        aria-label="Refresh search settings"
        onclick={() => void search.load()}
      >
        <CioRefresh size={14} class={search.loading ? 'animate-spin' : ''} aria-hidden="true" />
      </button>
    </div>
  </div>

  {#if search.error}
    <p class="mb-4 bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
      {search.error}
    </p>
  {/if}

  <div class="space-y-4">
    {#if status && (!status.runtimeAvailable || runtimeTooOld)}
      <div class="flex items-start gap-3 border border-warning/40 bg-warning/10 p-4">
        <CioAlertCircle size={16} class="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
        <div class="min-w-0 flex-1">
          <p class="text-sm font-medium">
            {runtimeTooOld
              ? 'Update the local llama.cpp runtime'
              : 'A local llama.cpp runtime is required'}
          </p>
          <p class="mt-0.5 text-xs leading-relaxed text-muted">
            {#if runtimeTooOld}
              Your llama.cpp build ({status.runtimeBuild}) is too old to load the embedding models
              above. Intent search needs build {SEARCH_MIN_RUNTIME_BUILD} or newer. Installing the app
              runtime replaces the discovered one.
            {:else}
              Embedding models run through the same runtime the app uses for speech cleanup. Install
              it once and both features share it.
            {/if}
            {#if llamaRuntime?.downloadByteSize}
              ({llamaRuntime.downloadName} · {formatBytes(llamaRuntime.downloadByteSize)})
            {/if}
          </p>
        </div>
        <button
          type="button"
          class="flex shrink-0 items-center gap-1.5 bg-primary px-3 py-1.5 text-xs font-medium text-on-primary hover:opacity-90 disabled:opacity-50"
          disabled={installingRuntime}
          onclick={() => void installRuntime()}
        >
          {#if installingRuntime}
            <CioSpinner size={12} class="animate-spin" aria-hidden="true" />
            Installing
          {:else}
            <CioDownload size={12} aria-hidden="true" />
            {runtimeTooOld ? 'Update' : 'Install'}
          {/if}
        </button>
      </div>
    {/if}

    <!-- Index -->
    <div class="border bg-surface p-4">
      <div class="mb-3 flex items-center justify-between gap-3 border-b border-border pb-2">
        <h3 class="text-[0.625rem] font-semibold tracking-wide text-dimmed uppercase">Index</h3>
        <button
          type="button"
          class="flex items-center gap-1.5 border bg-elevated px-2.5 py-1 text-xs text-muted hover:text-foreground disabled:opacity-50"
          title="Rebuild the thread index from scratch"
          aria-label="Rebuild thread index"
          disabled={!enabled || status?.indexing}
          onclick={() => void search.rebuildIndex()}
        >
          <CioRefresh size={12} class={status?.indexing ? 'animate-spin' : ''} aria-hidden="true" />
          Rebuild
        </button>
      </div>
      <div class="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
        <div>
          <p class="text-[0.6875rem] uppercase tracking-wide text-dimmed">Threads indexed</p>
          <p class="text-sm font-medium tabular-nums">
            {completedThreads.toLocaleString()} / {totalThreads === null
              ? '…'
              : totalThreads.toLocaleString()}
          </p>
        </div>
        <div>
          <p class="text-[0.6875rem] uppercase tracking-wide text-dimmed">Progress</p>
          <p class="flex items-center gap-1.5 text-sm font-medium">
            {#if status?.indexing}
              <CioSpinner size={13} class="animate-spin text-primary" aria-hidden="true" />
              {totalThreads === null ? 'Counting threads…' : `${indexingPercent}%`}
            {:else}
              <span class="tabular-nums">
                {totalThreads === null ? '…' : `${indexingPercent}%`}
              </span>
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
      <p class="mt-3 flex h-4 gap-2 text-xs text-muted" role="status">
        <span class="min-w-0 truncate" title={status?.progress?.threadTitle}>
          {#if status?.progress}
            {status.progress.stage === 'summarizing' ? 'Summarizing' : 'Embedding'}
            {status.progress.threadTitle}
          {/if}
        </span>
        {#if status?.progress?.stage === 'summarizing'}
          <span class="shrink-0">Optional summary</span>
        {/if}
      </p>
      <p class="mt-3 text-xs leading-relaxed text-dimmed">
        Indexing runs in the background in small batches, so it never blocks the app.
      </p>
    </div>

    <!-- Models -->
    <div class="border bg-surface p-4">
      <div class="mb-1 flex items-center justify-between gap-3 border-b border-border pb-2">
        <h3 class="text-[0.625rem] font-semibold tracking-wide text-dimmed uppercase">
          Embedding model
        </h3>
        <div class="flex items-center gap-1.5">
          <button
            type="button"
            class="flex items-center gap-1.5 border bg-elevated px-2.5 py-1 text-xs text-muted hover:text-foreground"
            title="Paste a path to a GGUF embedding model"
            aria-label="Paste an embedding model path"
            onclick={() => (pasteOpen = true)}
          >
            <CioClipboardPaste size={12} aria-hidden="true" />
            Paste path
          </button>
          <button
            type="button"
            class="flex items-center gap-1.5 border bg-elevated px-2.5 py-1 text-xs text-muted hover:text-foreground"
            title="Import a GGUF embedding model from disk"
            aria-label="Import an embedding model"
            onclick={() => void search.importModel()}
          >
            <CioUpload size={12} aria-hidden="true" />
            Import
          </button>
        </div>
      </div>

      {#if models.length === 0}
        <p class="border border-dashed px-3 py-2 text-xs text-dimmed">
          No embedding model is installed. Download one below, or import a compatible GGUF model of
          your own.
        </p>
      {:else}
        <ul class="divide-y">
          {#each models as model (model.id)}
            {@const isActive = status?.activeModelId === model.id}
            <li class="flex items-center gap-3 py-2.5">
              <span
                class="size-1.5 shrink-0 {isActive ? 'bg-primary' : 'bg-border-strong'}"
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
                  class="shrink-0 border border-primary/30 bg-primary/10 px-2 py-0.5 text-[0.5625rem] font-semibold uppercase tracking-wide text-primary"
                  >Active</span
                >
              {:else}
                <button
                  type="button"
                  class="shrink-0 border bg-elevated px-2.5 py-1 text-xs text-muted hover:text-foreground"
                  title="Use this model for intent search"
                  aria-label="Use {model.label} for intent search"
                  onclick={() => void search.setActiveModel(model.id)}
                >
                  Use
                </button>
              {/if}
              <button
                type="button"
                class="flex size-7 shrink-0 items-center justify-center text-muted hover:bg-danger/10 hover:text-danger"
                title="Remove this model"
                aria-label="Remove {model.label}"
                onclick={() => (pendingDelete = { id: model.id, label: model.label })}
              >
                <CioTrash size={13} aria-hidden="true" />
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
              How many tokens the model may read in one pass. Each thread is indexed by several
              windows spread across the conversation, so this bounds one window's size rather than
              how much of a thread is searched.
            </p>
            <p class="mt-1 text-xs text-dimmed">Changing it clears the index and rebuilds it.</p>
          </div>
          <label class="flex shrink-0 items-center gap-2 text-xs text-muted">
            <input
              class="w-24 border bg-elevated px-2 py-1 text-right tabular-nums"
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
          <span class="border border-border bg-raised px-1.5 py-0.5 text-[0.6875rem] text-muted"
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
          class="flex shrink-0 items-center gap-1.5 bg-primary px-3 py-1.5 text-xs font-medium text-on-primary hover:opacity-90"
          title="Download {artifact.label}"
          aria-label="Download {artifact.label}"
          onclick={() => void search.download(artifact.id)}
        >
          <CioDownload size={12} aria-hidden="true" />
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
