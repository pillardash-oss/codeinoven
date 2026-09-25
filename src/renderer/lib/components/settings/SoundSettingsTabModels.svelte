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
  import { parseModelIdentityFromPath } from '../../../../lib/speech/model-path-validation'
  import type {
    SpeechCapability,
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
    isActiveArtifact,
    isImportedForCapability,
    labelForInstalled,
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
  const importedForTab = $derived(
    installedArtifacts.filter(
      (item) => item.source === 'import' && isImportedForCapability(item, pasteCapability)
    )
  )

  function setActive(sub: ModelSubTab, artifactId: string): void {
    if (sub === 'asr') patch({ asrArtifactId: artifactId })
    else if (sub === 'tts') patch({ ttsArtifactId: artifactId })
    else patch({ cleanupArtifactId: artifactId })
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

  function removeImported(artifactId: string, importPath: string): void {
    onRequestDelete({
      action: 'model',
      targetId: artifactId,
      label: `imported model ${importPath}`,
      isImported: true
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
  {#if !activeIdFor(settings, activeModelSubTab)}
    <p class="rounded-lg border border-dashed px-3 py-2 text-xs text-dimmed">
      No active model import or download one and set it active.
    </p>
  {/if}

  {#if importedForTab.length > 0}
    <div class="space-y-2">
      <p class="text-xs font-semibold uppercase tracking-wide text-muted">
        Imported · {activeModelSubTab.toUpperCase()}
        {importedForTab.length} model{importedForTab.length === 1 ? '' : 's'}
      </p>
      {#each importedForTab as artifact (artifact.artifactId)}
        {@const parsedImp = artifact.importPath
          ? parseModelIdentityFromPath(artifact.importPath, artifact.runtime)
          : null}
        {@const impDetails = parsedImp
          ? parsedImp.details.filter((d) => d.label !== 'Family' && d.label !== 'Runtime')
          : []}
        <div
          id="model-card-{artifact.artifactId}"
          class="flex items-start gap-3 rounded-xl border px-3 py-3 {isActiveArtifact(
            settings,
            artifact.artifactId,
            activeModelSubTab
          )
            ? 'bg-success/[0.04] border-success/25'
            : 'bg-elevated border-border/70'}"
        >
          <div class="min-w-0 flex-1">
            {#if parsedImp}
              <div class="flex flex-wrap items-center gap-1.5">
                <p
                  class="truncate text-sm font-semibold leading-none"
                  title={parsedImp.baseWithoutExtension}
                >
                  {parsedImp.displayName}
                </p>
                <span
                  class="inline-flex items-center rounded-full border px-2 py-0.5 text-[0.625rem] font-medium {runtimeBadgeClass(
                    artifact.runtime
                  )}">{runtimeBadge(artifact.runtime)}</span
                >
                <span class="text-[0.625rem] text-dimmed">· external</span>
                {#if !artifact.available}
                  <span
                    class="inline-flex items-center gap-1 rounded-full bg-danger px-2 py-0.5 text-[0.625rem] font-semibold text-white"
                    title={artifact.unavailableReason ??
                      'The imported model path no longer exists.'}
                    ><X size={10} aria-hidden="true" /> Not found</span
                  >
                {/if}
                {#if isActiveArtifact(settings, artifact.artifactId, activeModelSubTab)}
                  <span
                    class="inline-flex items-center gap-1 rounded-full bg-success px-2 py-0.5 text-[0.625rem] font-semibold text-white"
                    ><Check size={10} aria-hidden="true" /> Active</span
                  >
                {/if}
              </div>
              <p
                class="mt-1 truncate font-mono text-[0.6875rem] leading-none text-dimmed"
                title={artifact.importPath}
              >
                {artifact.importPath}
              </p>
              {#if impDetails.length}
                <p
                  class="mt-1.5 flex flex-wrap items-center gap-x-1 text-[0.6875rem] leading-none text-muted"
                >
                  {#each impDetails as d, i (d.label)}
                    <span class="font-medium">{d.value}</span>{#if i < impDetails.length - 1}<span
                        class="mx-0.5 opacity-30">·</span
                      >{/if}
                  {/each}
                </p>
              {/if}
              {#if parsedImp.tokens.length}
                <p class="mt-1 font-mono text-[0.625rem] leading-none text-dimmed/80">
                  {parsedImp.tokens.join(' · ')}
                </p>
              {/if}
            {:else}
              <p class="truncate text-sm font-medium">{artifact.importPath}</p>
              <p class="mt-1 inline-flex items-center gap-1.5 text-[0.625rem] text-dimmed">
                <span
                  class="inline-flex rounded-full border px-2 py-0.5 text-[0.625rem] font-medium {runtimeBadgeClass(
                    artifact.runtime
                  )}">{runtimeBadge(artifact.runtime)}</span
                >
                <span>· external</span>
                {#if !artifact.available}
                  <span
                    class="inline-flex items-center gap-1 rounded-full bg-danger px-2 py-0.5 text-[0.625rem] font-semibold text-white"
                    title={artifact.unavailableReason ??
                      'The imported model path no longer exists.'}
                    ><X size={10} aria-hidden="true" /> Not found</span
                  >
                {/if}
              </p>
            {/if}
          </div>
          <div class="flex shrink-0 items-center gap-1">
            {#if !isActiveArtifact(settings, artifact.artifactId, activeModelSubTab) && artifact.available}
              <button
                type="button"
                class="inline-flex items-center gap-1 rounded-lg bg-primary px-2.5 py-1 text-xs font-medium text-on-primary hover:bg-primary/90"
                title="Make this imported model active"
                aria-label="Make imported {artifact.importPath} active"
                onclick={() => setActive(activeModelSubTab, artifact.artifactId)}
                ><Star size={11} aria-hidden="true" /> Set Active</button
              >
            {/if}
            {#if !isActiveArtifact(settings, artifact.artifactId, activeModelSubTab) || !artifact.available}<button
                type="button"
                class="flex h-7 w-7 items-center justify-center rounded-lg border border-transparent text-dimmed hover:border-border hover:bg-surface hover:text-muted"
                title={`Unregister ${artifact.importPath}`}
                aria-label={`Unregister ${artifact.importPath}`}
                onclick={() => removeImported(artifact.artifactId, artifact.importPath ?? '')}
                ><Trash2 size={12} aria-hidden="true" /></button
              >{/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}

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

  <!-- Catalog models - no max-height, expands naturally; imported already at top -->
  <div class="space-y-3">
    {#each visibleArtifacts as artifact (artifact.id)}
      {@const installed = installedArtifacts.find((item) => item.artifactId === artifact.id)}
      {@const active =
        isActiveArtifact(settings, artifact.id, activeModelSubTab) && installed?.available}
      {@const selectedUnavailable =
        isActiveArtifact(settings, artifact.id, activeModelSubTab) &&
        installed &&
        !installed.available}
      {@const download = speech.downloads[artifact.id]}
      {@const badge = bestForBadge(artifact)}
      {@const isRetired = artifact.qualification.status === 'retired'}
      {@const downloadLabel = isRetired
        ? `${artifact.label} is retired`
        : `Download ${artifact.label}`}
      <div
        id="model-card-{artifact.id}"
        class="rounded-xl border p-3 {active
          ? 'bg-success/5 border-success/30 ring-1 ring-success/20'
          : 'bg-elevated'}"
      >
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
              {#if active}
                <span
                  class="inline-flex items-center gap-1 rounded-full bg-success px-2 py-0.5 text-[0.625rem] font-semibold text-white border-success"
                  ><Check size={10} aria-hidden="true" /> Active</span
                >
              {:else if selectedUnavailable}
                <span
                  class="inline-flex items-center rounded-full border border-amber-600/30 bg-amber-600/10 px-2 py-0.5 text-[0.625rem] font-semibold text-amber-600"
                  >Selected · unavailable</span
                >
              {/if}
            </div>
            <p class="mt-1 text-xs leading-relaxed text-muted">{artifact.description}</p>
            <p class="mt-1.5 flex flex-wrap items-center gap-2 text-[0.6875rem] text-dimmed">
              <span>{(artifact.byteSize / 1_048_576).toFixed(0)} MB</span>
              <span class="opacity-40">·</span>
              <span>{artifact.license}</span>
              <span class="opacity-40">·</span>
              <span
                class={artifact.qualification.status === 'qualified'
                  ? 'text-success'
                  : 'text-amber-600'}>{artifact.qualification.status}</span
              >
              {#if artifact.languages.length}
                <span class="opacity-40">·</span>
                <span>{artifact.languages.join(', ')}</span>
              {/if}
            </p>
            {#if installed && !installed.available}
              <p class="mt-1 text-[0.6875rem] text-amber-600">
                {installed.unavailableReason ?? 'The model runtime is unavailable.'}
              </p>
            {/if}
            <a
              href={artifact.sourcePageUrl}
              target="_blank"
              rel="noreferrer"
              class="mt-1 inline-flex items-center gap-1 text-[0.6875rem] text-primary hover:underline"
            >
              Hugging Face <ExternalLink size={10} aria-hidden="true" />
            </a>
          </div>
          <div class="flex shrink-0 flex-col items-end gap-1.5">
            {#if installed}
              {#if !isActiveArtifact(settings, artifact.id, activeModelSubTab)}
                <button
                  type="button"
                  class="flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-danger/10 hover:text-danger"
                  title={`Delete ${artifact.label}`}
                  aria-label={`Delete ${artifact.label}`}
                  onclick={() =>
                    onRequestDelete({
                      action: 'model',
                      targetId: artifact.id,
                      label: artifact.label
                    })}><Trash2 size={14} aria-hidden="true" /></button
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
              onclick={() => void speech.download(artifact.id)}>Retry</button
            >
          </div>
        {/if}
        {#if download?.state === 'cancelled'}
          <p class="mt-3 rounded-lg border bg-muted/10 px-3 py-2 text-[0.6875rem] text-muted">
            Download cancelled.
          </p>
        {/if}
        <div class="mt-3 flex items-center gap-1.5 border-t pt-3">
          {#if installed}
            {#if isActiveArtifact(settings, artifact.id, activeModelSubTab)}
              <span
                class="inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-[0.6875rem] font-semibold text-success border border-success/20"
              >
                <Check size={11} aria-hidden="true" /> Active
              </span>
            {:else}
              <button
                type="button"
                class="inline-flex items-center gap-1 rounded-md border bg-primary/10 px-2 py-1 text-[0.6875rem] font-medium text-primary hover:bg-primary/15"
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
            class="inline-flex items-center gap-1 rounded-md border bg-surface px-2 py-1 text-[0.6875rem] text-muted hover:text-foreground disabled:opacity-50"
            title="Import a local model file for this family"
            aria-label="Import for {artifact.label}"
            disabled={importing}
            onclick={() => void pickImport()}
          >
            <Upload size={11} aria-hidden="true" /> Import
          </button>
          <button
            type="button"
            class="inline-flex items-center gap-1 rounded-md border bg-surface px-2 py-1 text-[0.6875rem] text-muted hover:text-foreground"
            title="Paste a filesystem path for this family"
            aria-label="Paste path for {artifact.label}"
            onclick={() => (pasteOpen = true)}
          >
            <ClipboardPaste size={11} aria-hidden="true" /> Paste Path
          </button>
        </div>
      </div>
    {/each}
    {#if visibleArtifacts.length === 0}
      <p class="py-8 text-center text-sm text-dimmed">No models in this category.</p>
    {/if}
  </div>
</div>

<PasteModelPathModal
  open={pasteOpen}
  capability={pasteCapability}
  onClose={() => (pasteOpen = false)}
  onImported={() => void speech.load()}
/>
