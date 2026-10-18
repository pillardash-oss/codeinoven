<script lang="ts">
  import CioClipboardPaste from '@codeinoven/icons/CioClipboardPaste.svelte'
  import CioDownload from '@codeinoven/icons/CioDownload.svelte'
  import CioExternalLink from '@codeinoven/icons/CioExternalLink.svelte'
  import CioSpinner from '@codeinoven/icons/CioSpinner.svelte'
  import CioTrash from '@codeinoven/icons/CioTrash.svelte'
  import CioUpload from '@codeinoven/icons/CioUpload.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { listRowMove } from '$lib/motion'
  import { speechSettingsStore as speech } from '$lib/stores/speech.svelte'
  import {
    describeSupportedFormatsForCapability,
    parseModelIdentityFromPath
  } from '../../../../lib/speech/model-path-validation'
  import type {
    SpeechCapability,
    SpeechInstalledArtifact,
    SpeechModelArtifact,
    SpeechRuntime,
    SpeechSettings
  } from '../../../../lib/speech/types'
  import DownloadProgress from '../ui/DownloadProgress.svelte'
  import PasteModelPathModal from './PasteModelPathModal.svelte'
  import {
    activeIdFor,
    downloadPercent,
    formatBytes,
    installedCapability,
    isActiveCapability,
    labelForInstalled,
    modelSubTabForCapability,
    modelSubTabs,
    runtimeBadge,
    runtimesForSubTab,
    sortedForSubTab,
    type ModelSubTab,
    type PendingDeletion
  } from './sound-settings-helpers'

  interface Props {
    settings: SpeechSettings
    patch: (next: Partial<SpeechSettings>) => void
    onRequestDelete: (pending: PendingDeletion) => void
  }

  interface InstalledRow {
    installed: SpeechInstalledArtifact
    capability: SpeechCapability
    /** The catalog entry when the model came from the catalog, null when imported. */
    artifact: SpeechModelArtifact | null
  }

  let { settings, patch, onRequestDelete }: Props = $props()

  let activeModelSubTab = $state<ModelSubTab>('asr')
  let runtimeFilter = $state<'all' | SpeechRuntime>('all')
  let importing = $state(false)
  let pasteOpen = $state(false)

  const activeSubTab = $derived(
    modelSubTabs.find((tab) => tab.id === activeModelSubTab) ?? modelSubTabs[0]
  )
  const pasteCapability = $derived<SpeechCapability>(
    activeModelSubTab === 'asr' ? 'asr' : activeModelSubTab === 'tts' ? 'tts' : 'cleanup'
  )

  const catalogArtifacts = $derived(speech.catalog?.artifacts ?? [])
  const installedArtifacts = $derived(speech.capabilities?.installedArtifacts ?? [])
  const visibleArtifacts = $derived(
    sortedForSubTab(catalogArtifacts, activeModelSubTab, runtimeFilter)
  )

  /** Installed models of the current capability, active one first. */
  const installedRows = $derived.by((): InstalledRow[] => {
    const activeId = activeIdFor(settings, activeModelSubTab)
    return installedArtifacts
      .map((installed) => ({
        installed,
        capability: installedCapability(installed, catalogArtifacts),
        artifact: catalogArtifacts.find((artifact) => artifact.id === installed.artifactId) ?? null
      }))
      .filter((row): row is InstalledRow => row.capability === pasteCapability)
      .filter((row) => runtimeFilter === 'all' || row.installed.runtime === runtimeFilter)
      .sort((a, b) => {
        if (a.installed.artifactId === activeId) return -1
        if (b.installed.artifactId === activeId) return 1
        return b.installed.installedAt - a.installed.installedAt
      })
  })

  /** Every installed id of this capability, so none is offered twice. */
  const installedIds = $derived(
    new Set(
      installedArtifacts
        .filter((item) => installedCapability(item, catalogArtifacts) === pasteCapability)
        .map((item) => item.artifactId)
    )
  )
  const availableArtifacts = $derived(
    visibleArtifacts.filter((artifact) => !installedIds.has(artifact.id))
  )

  function setActive(sub: ModelSubTab, artifactId: string): void {
    if (sub === 'asr') patch({ asrArtifactId: artifactId })
    else if (sub === 'tts') patch({ ttsArtifactId: artifactId })
    else patch({ cleanupArtifactId: artifactId })
  }

  /**
   * Download an artifact and make it active the moment it lands. Waiting for a
   * manual "Set Active" after a multi-hundred-megabyte download is busywork:
   * downloading a model is the request to use it.
   */
  async function downloadAndActivate(artifact: SpeechModelArtifact): Promise<void> {
    await speech.download(artifact.id)
    const sub = modelSubTabForCapability(artifact.capability)
    if (activeIdFor(settings, sub) !== artifact.id) setActive(sub, artifact.id)
  }

  /** An imported model becomes active the same way a downloaded one does. */
  async function importAndActivate(path: string): Promise<boolean> {
    const installed = await speech.importModel(path, pasteCapability)
    if (!installed) return false
    const capability = installedCapability(installed, catalogArtifacts) ?? pasteCapability
    if (!isActiveCapability(settings, installed.artifactId, capability)) {
      setActive(modelSubTabForCapability(capability), installed.artifactId)
    }
    return true
  }

  async function pickImport(): Promise<void> {
    if (importing) return
    importing = true
    try {
      const path = await invoke('dialog:pickFolder')
      if (!path) return
      await importAndActivate(path)
    } catch (cause) {
      speech.error = cause instanceof Error ? cause.message : String(cause)
    } finally {
      importing = false
    }
  }

  function removeInstalled(row: InstalledRow): void {
    const isImported = row.installed.source === 'import'
    onRequestDelete({
      action: 'model',
      targetId: row.installed.artifactId,
      label: isImported
        ? `imported model ${row.installed.importPath ?? row.installed.artifactId}`
        : (row.artifact?.label ??
          labelForInstalled(catalogArtifacts, installedArtifacts, row.installed.artifactId)),
      isImported
    })
  }
</script>

<div class="space-y-4">
  <!-- Model capability sub-tabs -->
  <div
    class="flex items-center gap-1 border bg-surface p-1"
    role="tablist"
    aria-label="Model categories"
  >
    {#each modelSubTabs as sub (sub.id)}
      <button
        type="button"
        role="tab"
        aria-selected={activeModelSubTab === sub.id}
        class="flex-1 px-3 py-2 text-sm font-medium transition-colors {activeModelSubTab === sub.id
          ? 'bg-elevated text-foreground'
          : 'text-muted hover:text-foreground'}"
        onclick={() => {
          activeModelSubTab = sub.id
          runtimeFilter = 'all'
        }}
      >
        <span class="block text-sm font-semibold leading-none">{sub.label}</span>
        <span class="block text-[0.625rem] font-normal leading-none opacity-70">{sub.hint}</span>
      </button>
    {/each}
  </div>

  <!-- Runtime filter -->
  <div class="flex flex-wrap items-center gap-1.5">
    <span class="text-[0.6875rem] font-medium text-muted">Filter:</span>
    <button
      type="button"
      class="border px-2.5 py-1 text-[0.6875rem] font-medium {runtimeFilter === 'all'
        ? 'bg-primary text-on-primary border-primary'
        : 'bg-elevated text-muted border-border hover:text-foreground'}"
      onclick={() => (runtimeFilter = 'all')}>All</button
    >
    {#each runtimesForSubTab(activeModelSubTab) as rt (rt)}
      <button
        type="button"
        class="border px-2.5 py-1 text-[0.6875rem] font-medium {runtimeFilter === rt
          ? 'bg-primary text-on-primary border-primary'
          : 'bg-elevated text-muted border-border hover:text-foreground'}"
        onclick={() => (runtimeFilter = rt)}>{runtimeBadge(rt)}</button
      >
    {/each}
  </div>

  <!-- One card, exactly like the Search models card: installed rows first
       (active on top), then the catalog models this device has not downloaded. -->
  <div class="border bg-surface p-4">
    <div class="mb-1 flex items-center justify-between gap-3 border-b border-border pb-2">
      <h3 class="text-[0.625rem] font-semibold tracking-wide text-dimmed uppercase">
        {activeSubTab.label} models
      </h3>
      <div class="flex items-center gap-1.5">
        <button
          type="button"
          class="flex items-center gap-1.5 border bg-elevated px-2.5 py-1 text-xs text-muted hover:text-foreground"
          title="Paste a filesystem path to a model"
          aria-label="Paste a {activeSubTab.label} model path"
          onclick={() => (pasteOpen = true)}
        >
          <CioClipboardPaste size={12} aria-hidden="true" />
          Paste path
        </button>
        <button
          type="button"
          class="flex items-center gap-1.5 border bg-elevated px-2.5 py-1 text-xs text-muted hover:text-foreground disabled:opacity-50"
          title="Import a model from disk (.mlx, .gguf, or ONNX)"
          aria-label="Import a {activeSubTab.label} model"
          disabled={importing}
          onclick={() => void pickImport()}
        >
          {#if importing}
            <CioSpinner size={12} class="animate-spin" aria-hidden="true" />
          {:else}
            <CioUpload size={12} aria-hidden="true" />
          {/if}
          Import
        </button>
      </div>
    </div>

    {#if installedRows.length === 0}
      <p class="border border-dashed px-3 py-2 text-xs text-dimmed">
        No {activeSubTab.label} model is installed. Download one below, or import your own.
      </p>
    {:else}
      <ul class="divide-y">
        {#each installedRows as row (row.installed.artifactId)}
          <li class="flex items-center gap-3 py-2.5" animate:listRowMove>
            {@render installedRow(row)}
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
  </div>
</div>

{#snippet installedRow(row: InstalledRow)}
  {@const artifact = row.artifact}
  {@const parsedImport =
    !artifact && row.installed.importPath
      ? parseModelIdentityFromPath(row.installed.importPath, row.installed.runtime)
      : null}
  {@const isActive = isActiveCapability(settings, row.installed.artifactId, row.capability)}
  {@const label = artifact?.label ?? parsedImport?.displayName ?? row.installed.artifactId}
  {@const byteSize = artifact?.byteSize ?? row.installed.byteSize ?? 0}
  <span
    class="size-1.5 shrink-0 {!row.installed.available
      ? 'bg-danger'
      : isActive
        ? 'bg-primary'
        : 'bg-border-strong'}"
    aria-hidden="true"
  ></span>
  <div class="min-w-0 flex-1">
    <p class="truncate text-sm font-medium" title={label}>{label}</p>
    <p class="truncate text-xs text-dimmed" title={row.installed.unavailableReason}>
      {runtimeBadge(row.installed.runtime)}{#if byteSize}
        · {formatBytes(byteSize)}{/if}{#if artifact}
        · {artifact.license}{/if}{#if artifact?.languages.length}
        · {artifact.languages.join(', ')}{/if}{#if !row.installed.available}
        · {row.installed.unavailableReason ?? 'Unavailable'}{/if}
    </p>
    {#if !artifact && row.installed.importPath}
      <p class="truncate font-mono text-[0.6875rem] text-dimmed" title={row.installed.importPath}>
        {row.installed.importPath}
      </p>
    {/if}
  </div>
  {#if isActive && row.installed.available}
    <span
      class="shrink-0 border border-primary/30 bg-primary/10 px-2 py-0.5 text-[0.5625rem] font-semibold uppercase tracking-wide text-primary"
      >Active</span
    >
  {:else if row.installed.available}
    <button
      type="button"
      class="shrink-0 border bg-elevated px-2.5 py-1 text-xs text-muted hover:text-foreground"
      title="Use this model"
      aria-label="Use {label} for {activeSubTab.label}"
      onclick={() => setActive(modelSubTabForCapability(row.capability), row.installed.artifactId)}
    >
      Use
    </button>
  {:else}
    <span class="shrink-0 text-xs text-muted" title={row.installed.unavailableReason}>
      Unavailable
    </span>
  {/if}
  <button
    type="button"
    class="flex size-7 shrink-0 items-center justify-center text-muted hover:bg-danger/10 hover:text-danger"
    title="Remove {label}"
    aria-label="Remove {label}"
    onclick={() => removeInstalled(row)}
  >
    <CioTrash size={13} aria-hidden="true" />
  </button>
{/snippet}

{#snippet artifactRow(artifact: SpeechModelArtifact)}
  {@const download = speech.downloads[artifact.id]}
  {@const isRetired = artifact.qualification.status === 'retired'}
  {@const busy =
    download?.state === 'downloading' ||
    download?.state === 'verifying' ||
    download?.state === 'queued'}
  {@const canDownload = !busy && download?.state !== 'cancelled'}
  <li class="py-3">
    <div class="flex items-start justify-between gap-6">
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
          <p class="text-sm font-medium">{artifact.label}</p>
          <span class="border border-border bg-raised px-1.5 py-0.5 text-[0.6875rem] text-muted"
            >{runtimeBadge(artifact.runtime)} · {artifact.version}</span
          >
        </div>
        <p class="mt-1 text-xs leading-relaxed text-muted">{artifact.description}</p>
        <p class="mt-1 text-xs text-dimmed">
          {formatBytes(artifact.byteSize)} · {artifact.license}{#if artifact.languages.length}
            · {artifact.languages.join(', ')}{/if}
        </p>
        {#if artifact.sourcePageUrl}
          <a
            href={artifact.sourcePageUrl}
            target="_blank"
            rel="noreferrer"
            class="mt-1 inline-flex items-center gap-1 text-[0.6875rem] text-primary hover:underline"
          >
            Hugging Face <CioExternalLink size={10} aria-hidden="true" />
          </a>
        {/if}
      </div>
      {#if canDownload}
        <button
          type="button"
          class="flex shrink-0 items-center gap-1.5 bg-primary px-3 py-1.5 text-xs font-medium text-on-primary hover:opacity-90 disabled:opacity-50"
          title={isRetired ? `${artifact.label} is retired` : `Download ${artifact.label}`}
          aria-label={isRetired ? `${artifact.label} is retired` : `Download ${artifact.label}`}
          disabled={isRetired}
          onclick={() => void downloadAndActivate(artifact)}
        >
          <CioDownload size={12} aria-hidden="true" />
          {download?.state === 'failed' ? 'Retry' : 'Download'}
        </button>
      {/if}
    </div>

    {#if busy}
      {@const pct =
        download.state === 'queued'
          ? 0
          : download.state === 'verifying'
            ? 100
            : downloadPercent(download)}
      <div class="mt-2.5">
        <DownloadProgress
          percent={pct}
          label={download.state === 'verifying'
            ? 'Verifying…'
            : download.state === 'queued'
              ? 'Queued…   waiting to start'
              : 'Downloading…'}
          detail={download.state === 'downloading'
            ? `${formatBytes(download.bytesReceived)} / ${formatBytes(download.totalBytes)}`
            : download.state === 'verifying'
              ? `${formatBytes(download.bytesReceived)} · checksum`
              : `Position ${download.position}`}
          tone={download.state === 'verifying' ? 'verifying' : 'default'}
          ariaLabel="Downloading {artifact.label}"
          onCancel={() => void speech.cancelDownload(artifact.id)}
          cancelLabel={`Cancel ${artifact.label} download`}
        />
      </div>
    {:else if download?.state === 'failed'}
      <div
        class="mt-2.5 flex items-start justify-between gap-2 border border-danger/20 bg-danger/5 px-3 py-2"
      >
        <p class="text-[0.6875rem] leading-snug text-danger">
          Download failed{download.error?.message ? `: ${download.error.message}` : '.'}
        </p>
      </div>
    {:else if download?.state === 'cancelled'}
      <p class="mt-2.5 border bg-muted/10 px-3 py-2 text-[0.6875rem] text-muted">
        Download cancelled.
      </p>
    {/if}
  </li>
{/snippet}

<PasteModelPathModal
  open={pasteOpen}
  help={describeSupportedFormatsForCapability(pasteCapability)}
  placeholder="/Users/you/models/whisper.mlx  or  /path/to/model.gguf"
  validate={async (raw) => {
    const result = await invoke('speech:validateModelPath', raw, pasteCapability)
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }}
  onImport={(path) => importAndActivate(path)}
  onClose={() => (pasteOpen = false)}
/>
