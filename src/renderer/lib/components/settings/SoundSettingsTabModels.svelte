<script lang="ts">
  import {
    Check,
    ClipboardPaste,
    Download,
    ExternalLink,
    LoaderCircle,
    Star,
    Trash2,
    Upload,
    X
  } from '@lucide/svelte'
  import { invoke } from '$lib/ipc.svelte'
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
    bestForBadge,
    downloadPercent,
    formatBytes,
    installedCapability,
    isActiveCapability,
    labelForInstalled,
    modelSubTabForCapability,
    modelSubTabs,
    runtimeBadge,
    runtimeBadgeClass,
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
      .filter((row) => row.capability === pasteCapability)
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
    const capability = installedCapability(installed, catalogArtifacts)
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
        : (row.artifact?.label ?? row.installed.artifactId),
      isImported
    })
  }

  function activeLabel(): string {
    const id = activeIdFor(settings, activeModelSubTab)
    return id ? labelForInstalled(catalogArtifacts, installedArtifacts, id) : ''
  }
</script>

<div class="space-y-4">
  <!-- Model capability sub-tabs -->
  <div
    class="flex items-center gap-1 rounded-lg border bg-surface p-1"
    role="tablist"
    aria-label="Model categories"
  >
    {#each modelSubTabs as sub (sub.id)}
      <button
        type="button"
        role="tab"
        aria-selected={activeModelSubTab === sub.id}
        class="flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors {activeModelSubTab ===
        sub.id
          ? 'bg-elevated text-foreground shadow-sm'
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

  <div class="flex items-center justify-end gap-3">
    {#if activeIdFor(settings, activeModelSubTab)}
      <button
        type="button"
        class="text-xs text-muted hover:text-foreground hover:underline underline-offset-2"
        title="Scroll to active model"
        aria-label="Scroll to active model {activeLabel()}"
        onclick={() => {
          const id = activeIdFor(settings, activeModelSubTab)
          if (!id) return
          const el = document.getElementById(`model-card-${id}`)
          el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        }}
      >
        Active: <span class="font-semibold text-foreground">{activeLabel()}</span>
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

  <!-- Runtime filter -->
  <div class="flex flex-wrap items-center gap-1.5">
    <span class="text-[0.6875rem] font-medium text-muted">Filter:</span>
    <button
      type="button"
      class="rounded-full border px-2.5 py-1 text-[0.6875rem] font-medium {runtimeFilter === 'all'
        ? 'bg-primary text-on-primary border-primary'
        : 'bg-elevated text-muted border-border hover:text-foreground'}"
      onclick={() => (runtimeFilter = 'all')}>All</button
    >
    {#each runtimesForSubTab(activeModelSubTab) as rt (rt)}
      <button
        type="button"
        class="rounded-full border px-2.5 py-1 text-[0.6875rem] font-medium {runtimeFilter === rt
          ? 'bg-primary text-on-primary border-primary'
          : 'bg-elevated text-muted border-border hover:text-foreground'}"
        onclick={() => (runtimeFilter = rt)}>{runtimeBadge(rt)}</button
      >
    {/each}
  </div>

  <!-- Installed: the active model first, everything the user has on disk -->
  <section class="space-y-3">
    <div class="flex items-baseline justify-between gap-3">
      <h3 class="text-xs font-semibold uppercase tracking-wide text-muted">Installed</h3>
      <span class="text-[0.6875rem] text-dimmed">
        {installedRows.length} model{installedRows.length === 1 ? '' : 's'}
      </span>
    </div>
    {#if installedRows.length === 0}
      <p class="rounded-lg border border-dashed px-3 py-2 text-xs text-dimmed">
        Nothing installed for {activeModelSubTab.toUpperCase()} yet. Download one below, or import your
        own.
      </p>
    {:else}
      {#each installedRows as row (row.installed.artifactId)}
        {@render installedRow(row)}
      {/each}
    {/if}
  </section>

  <!-- Available: catalog models the user has not downloaded yet -->
  {#if availableArtifacts.length > 0}
    <section class="space-y-3">
      <h3 class="text-xs font-semibold uppercase tracking-wide text-muted">Available</h3>
      {#each availableArtifacts as artifact (artifact.id)}
        {@render availableRow(artifact)}
      {/each}
    </section>
  {/if}
</div>

{#snippet installedRow(row: InstalledRow)}
  {@const artifact = row.artifact}
  {@const parsedImport =
    !artifact && row.installed.importPath
      ? parseModelIdentityFromPath(row.installed.importPath, row.installed.runtime)
      : null}
  {@const isActive = isActiveCapability(settings, row.installed.artifactId, row.capability)}
  <div
    id="model-card-{row.installed.artifactId}"
    class="rounded-xl border p-3 {isActive
      ? 'bg-success/5 border-success/30 ring-1 ring-success/20'
      : 'bg-elevated'}"
  >
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-1.5">
          <p
            class="truncate text-sm font-semibold"
            title={parsedImport?.baseWithoutExtension ?? row.installed.artifactId}
          >
            {artifact?.label ??
              parsedImport?.displayName ??
              row.installed.importPath ??
              row.installed.artifactId}
          </p>
          <span
            class="inline-flex items-center rounded-full border px-2 py-0.5 text-[0.625rem] font-medium {runtimeBadgeClass(
              row.installed.runtime
            )}">{runtimeBadge(row.installed.runtime)}</span
          >
          {#if artifact}
            {@const badge = bestForBadge(artifact)}
            {#if badge}
              <span
                class="inline-flex items-center rounded-full border px-2 py-0.5 text-[0.625rem] font-semibold {badge.cls}"
                >{badge.label}</span
              >
            {/if}
          {/if}
          {#if isActive}
            <span
              class="inline-flex items-center gap-1 rounded-full bg-success px-2 py-0.5 text-[0.625rem] font-semibold text-white"
              ><Check size={10} aria-hidden="true" /> Active</span
            >
          {/if}
          {#if !row.installed.available}
            <span
              class="inline-flex items-center gap-1 rounded-full bg-danger px-2 py-0.5 text-[0.625rem] font-semibold text-white"
              title={row.installed.unavailableReason ?? 'The model path no longer exists.'}
              ><X size={10} aria-hidden="true" /> Not found</span
            >
          {/if}
        </div>
        {#if artifact?.description}
          <p class="mt-1 text-xs leading-relaxed text-muted">{artifact.description}</p>
        {/if}
        {#if !artifact && row.installed.importPath}
          <p
            class="mt-1 truncate font-mono text-[0.6875rem] text-dimmed"
            title={row.installed.importPath}
          >
            {row.installed.importPath}
          </p>
        {/if}
        {#if artifact}
          <p class="mt-1.5 flex flex-wrap items-center gap-2 text-[0.6875rem] text-dimmed">
            <span>{(artifact.byteSize / 1_048_576).toFixed(0)} MB</span>
            <span class="opacity-40">·</span>
            <span>{artifact.license}</span>
            {#if artifact.languages.length}
              <span class="opacity-40">·</span>
              <span>{artifact.languages.join(', ')}</span>
            {/if}
          </p>
        {/if}
        {#if row.installed.available}
          {#if artifact}
            <a
              href={artifact.sourcePageUrl}
              target="_blank"
              rel="noreferrer"
              class="mt-1 inline-flex items-center gap-1 text-[0.6875rem] text-primary hover:underline"
            >
              Hugging Face <ExternalLink size={10} aria-hidden="true" />
            </a>
          {/if}
        {:else}
          <p class="mt-1 text-[0.6875rem] text-amber-600">
            {row.installed.unavailableReason ?? 'The model runtime is unavailable.'}
          </p>
        {/if}
      </div>
      <div class="flex shrink-0 items-center gap-1.5">
        {#if !isActive && row.installed.available}
          <button
            type="button"
            class="inline-flex items-center gap-1 rounded-md border bg-primary/10 px-2 py-1 text-[0.6875rem] font-medium text-primary hover:bg-primary/15"
            title="Make {artifact?.label ?? row.installed.artifactId} active"
            aria-label="Make {artifact?.label ?? row.installed.artifactId} active"
            onclick={() =>
              setActive(modelSubTabForCapability(row.capability), row.installed.artifactId)}
          >
            <Star size={11} aria-hidden="true" /> Set Active
          </button>
        {/if}
        {#if !isActive || !row.installed.available}
          <button
            type="button"
            class="flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-danger/10 hover:text-danger"
            title="Remove {artifact?.label ?? row.installed.artifactId}"
            aria-label="Remove {artifact?.label ?? row.installed.artifactId}"
            onclick={() => removeInstalled(row)}
          >
            <Trash2 size={14} aria-hidden="true" />
          </button>
        {/if}
      </div>
    </div>
  </div>
{/snippet}

{#snippet availableRow(artifact: SpeechModelArtifact)}
  {@const download = speech.downloads[artifact.id]}
  {@const badge = bestForBadge(artifact)}
  {@const isRetired = artifact.qualification.status === 'retired'}
  {@const downloadLabel = isRetired ? `${artifact.label} is retired` : `Download ${artifact.label}`}
  {@const busy =
    download?.state === 'downloading' ||
    download?.state === 'verifying' ||
    download?.state === 'queued'}
  <div id="model-card-{artifact.id}" class="rounded-xl border bg-elevated p-3">
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0 flex-1">
        <div class="flex flex-wrap items-center gap-1.5">
          <p class="truncate text-sm font-semibold">{artifact.label}</p>
          <span
            class="inline-flex items-center rounded-full border px-2 py-0.5 text-[0.625rem] font-medium {runtimeBadgeClass(
              artifact.runtime
            )}">{runtimeBadge(artifact.runtime)}</span
          >
          {#if badge}
            <span
              class="inline-flex items-center rounded-full border px-2 py-0.5 text-[0.625rem] font-semibold {badge.cls}"
              >{badge.label}</span
            >
          {/if}
        </div>
        <p class="mt-1 text-xs leading-relaxed text-muted">{artifact.description}</p>
        <p class="mt-1.5 flex flex-wrap items-center gap-2 text-[0.6875rem] text-dimmed">
          <span>{(artifact.byteSize / 1_048_576).toFixed(0)} MB</span>
          <span class="opacity-40">·</span>
          <span>{artifact.license}</span>
          {#if artifact.languages.length}
            <span class="opacity-40">·</span>
            <span>{artifact.languages.join(', ')}</span>
          {/if}
        </p>
        <a
          href={artifact.sourcePageUrl}
          target="_blank"
          rel="noreferrer"
          class="mt-1 inline-flex items-center gap-1 text-[0.6875rem] text-primary hover:underline"
        >
          Hugging Face <ExternalLink size={10} aria-hidden="true" />
        </a>
      </div>
      <div class="flex shrink-0 items-center gap-1.5">
        {#if busy}
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
            onclick={() => void downloadAndActivate(artifact)}
            ><Download size={14} aria-hidden="true" /></button
          >
        {/if}
      </div>
    </div>
    {#if busy}
      {@const pct =
        download.state === 'queued'
          ? 0
          : download.state === 'verifying'
            ? 100
            : downloadPercent(download)}
      {@const isVerifying = download.state === 'verifying'}
      {@const isQueued = download.state === 'queued'}
      <div class="mt-3">
        <DownloadProgress
          percent={pct}
          label={isVerifying
            ? 'Verifying…'
            : isQueued
              ? 'Queued…   waiting to start'
              : 'Downloading…'}
          detail={download.state === 'downloading'
            ? `${formatBytes(download.bytesReceived)} / ${formatBytes(download.totalBytes)}`
            : isVerifying
              ? `${formatBytes(download.bytesReceived)} · checksum`
              : `Position ${download.position}`}
          tone={isVerifying ? 'verifying' : 'default'}
          ariaLabel={`Download progress ${pct}%`}
          onCancel={() => void speech.cancelDownload(artifact.id)}
          cancelLabel={`Cancel ${artifact.label} download`}
          hint={download.state === 'downloading'
            ? 'Large models can take a few minutes   you can keep using the app.'
            : undefined}
        />
      </div>
    {/if}
    {#if download?.state === 'failed'}
      <div
        class="mt-3 flex items-start justify-between gap-2 rounded-lg border border-danger/20 bg-danger/5 px-3 py-2"
      >
        <p class="text-[0.6875rem] leading-snug text-danger">
          Download failed{download.error?.message ? `: ${download.error.message}` : '.'}
        </p>
        <button
          type="button"
          class="shrink-0 rounded-md border bg-elevated px-2 py-1 text-[0.6875rem] font-medium text-foreground hover:bg-surface"
          onclick={() => void downloadAndActivate(artifact)}>Retry</button
        >
      </div>
    {/if}
    {#if download?.state === 'cancelled'}
      <p class="mt-3 rounded-lg border bg-muted/10 px-3 py-2 text-[0.6875rem] text-muted">
        Download cancelled.
      </p>
    {/if}
  </div>
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
