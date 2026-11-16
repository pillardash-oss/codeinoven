<script lang="ts">
  import CioArchive from '@pdslng/cio-icon/CioArchive.svelte'
  import CioCookie from '@pdslng/cio-icon/CioCookie.svelte'
  import CioDisk from '@pdslng/cio-icon/CioDisk.svelte'
  import CioFileText from '@pdslng/cio-icon/CioFileText.svelte'
  import CioFolder from '@pdslng/cio-icon/CioFolder.svelte'
  import CioFolderOpen from '@pdslng/cio-icon/CioFolderOpen.svelte'
  import CioMic from '@pdslng/cio-icon/CioMic.svelte'
  import CioPackage from '@pdslng/cio-icon/CioPackage.svelte'
  import CioProjects from '@pdslng/cio-icon/CioProjects.svelte'
  import CioRefresh from '@pdslng/cio-icon/CioRefresh.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import { toast } from 'svelte-sonner'
  import type { Component } from 'svelte'
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { formatBytes } from '$lib/format/bytes'
  import { reportError } from '$lib/stores/app-errors.svelte'
  import { cioCleanupStore } from '$lib/stores/cio-cleanup.svelte'
  import type { StorageArea, StorageAreaId, StorageClearTarget, StorageUsage } from '$shared/types'

  interface Props {
    open: boolean
    onClose: () => void
  }

  let { open, onClose }: Props = $props()

  /** The last measurement, kept on screen while a refresh runs. */
  let usage = $state<StorageUsage | null>(null)
  /** True only during the first measurement or an explicit refresh. */
  let checking = $state(false)
  let error = $state('')
  /**
   * How old a served measurement may be before reopening the surface measures
   * again in the background. The cache is shown immediately either way; this
   * only stops a quick close-and-reopen from walking a multi-gigabyte root for
   * a number that is seconds old.
   */
  const STALE_AFTER_MS = 30_000

  /** The area whose delete is waiting for confirmation. */
  let clearTarget = $state<StorageClearTarget | null>(null)
  /** True while the conversation-workspace cleanup is waiting for confirmation. */
  let cleanupConfirm = $state(false)
  /**
   * The clears this surface started, so they fade the instant they are
   * confirmed instead of waiting for the next measurement to say so.
   *
   * Main is what actually tracks a clear (it survives this component), and its
   * snapshot carries the areas it is removing; this list only bridges the
   * moment between the click and that snapshot.
   */
  let startedClears = $state<StorageClearTarget[]>([])
  let compacting = $state(false)

  /** The mark each area wears, so a row is recognisable before it is read. */
  const AREA_ICONS: Record<StorageAreaId, Component> = {
    database: CioDisk,
    models: CioPackage,
    recordings: CioMic,
    caches: CioCookie,
    logs: CioFileText,
    workspaces: CioFolder,
    projects: CioProjects,
    'app-data': CioArchive
  }

  /**
   * Share-bar colours. Two of these are deliberately quiet: project data and
   * app data are the parts the user keeps, so they must not compete with the
   * parts that can be handed back.
   */
  const AREA_COLORS: Record<StorageAreaId, string> = {
    database: 'var(--color-primary)',
    models: 'var(--color-info)',
    recordings: 'var(--color-accent)',
    caches: 'var(--color-warning)',
    logs: 'var(--color-muted)',
    workspaces: 'var(--color-success)',
    projects: 'var(--color-border-strong)',
    'app-data': 'var(--color-dimmed)'
  }

  /** Everything one confirmation says, per area. Nothing here is generic copy. */
  const CLEAR_COPY: Record<
    StorageClearTarget,
    { title: string; confirmLabel: string; body: string; note: string }
  > = {
    models: {
      title: 'Delete local models?',
      confirmLabel: 'Delete models',
      body: 'Speech, search, video and local AI models downloaded onto this machine are removed. Any model a feature needs is downloaded again when it is next used, which needs a connection.',
      note: 'This cannot be undone.'
    },
    recordings: {
      title: 'Delete recordings?',
      confirmLabel: 'Delete recordings',
      body: 'Every dictation and meeting recording stored by the app is removed. Transcripts and notes stay where they are; only the audio goes.',
      note: 'This cannot be undone.'
    },
    caches: {
      title: 'Clear caches?',
      confirmLabel: 'Clear caches',
      body: 'Browser caches, the search index, prepared playback copies and build scratch are removed. Sites reload their assets, the search index is rebuilt on the next search, and audio is prepared again when played.',
      note: 'Nothing here is the only copy of anything, so clearing it cannot lose work.'
    },
    logs: {
      title: 'Delete logs?',
      confirmLabel: 'Delete logs',
      body: 'Diagnostic logs the app wrote for past days are removed. New logs start again in a fresh folder as soon as the app writes its next line.',
      note: 'Past logs are what a support report is built from, so keep them if you are still chasing a problem.'
    }
  }

  const areas = $derived(usage?.areas ?? [])
  const total = $derived(usage?.totalBytes ?? 0)
  const reclaimable = $derived(usage?.reclaimableBytes ?? 0)
  const measuredAreas = $derived(areas.filter((area) => area.bytes > 0))
  const clearCopy = $derived(clearTarget ? CLEAR_COPY[clearTarget] : null)
  /** The CIO Cleanup retention, which is the only thing a cleanup may remove under. */
  const retentionDays = $derived(cioCleanupStore.state.retentionDays)
  const measuredAtLabel = $derived(
    usage && usage.measuredAt > 0
      ? new Date(usage.measuredAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : ''
  )

  /**
   * What a row says about itself.
   *
   * The workspaces row is the one that removes nothing on its own: it hands the
   * folder to CIO Cleanup, so it states the retention that sweep runs under
   * instead of implying a wipe.
   */
  function rowDetail(area: StorageArea): string {
    if (area.id !== 'workspaces') return area.detail
    return retentionDays > 0
      ? `${area.detail} Only what is older than the ${retentionDays}-day retention you set is removed.`
      : area.detail
  }

  /** This area's slice of the whole, as a percentage with a sensible precision. */
  function sharePercent(area: StorageArea): number {
    if (total <= 0) return 0
    return Math.max(0, Math.min(100, (area.bytes / total) * 100))
  }

  function shareLabel(area: StorageArea): string {
    const percent = sharePercent(area)
    return percent >= 10 ? `${percent.toFixed(0)}%` : `${percent.toFixed(1)}%`
  }

  function filesLabel(area: StorageArea): string {
    return `${area.files.toLocaleString()} file${area.files === 1 ? '' : 's'}`
  }

  async function load(force = false): Promise<void> {
    checking = true
    error = ''
    try {
      usage = await invoke('storageManager:usage', force)
    } catch (loadError: unknown) {
      reportError(loadError, 'The app data could not be measured.')
      error = loadError instanceof Error ? loadError.message : 'The app data could not be measured.'
    } finally {
      checking = false
    }
  }

  // Initial load on open. The measurement walks the data root, so it starts
  // after the panel is on screen rather than holding the open gesture. Nothing
  // the request writes is read here, so a completed measurement cannot retrigger
  // it.
  $effect(() => {
    if (!open) return
    // Subscribing is what tells this surface the retention the cleanup runs
    // under; it is the same store the settings page and the dock read.
    cioCleanupStore.listen()
    queueMicrotask(() => {
      if (open) void openSurface()
    })
  })

  /**
   * What an open does: the cached measurement now, a fresh one behind it.
   *
   * The first call is answered from main's cache whenever one exists, so
   * reopening the surface paints the previous numbers instead of an empty
   * panel. The second call is a real measurement, and it is what puts the
   * Refresh control in its loading state while the latest sizes come in. A
   * measurement that was interrupted by closing the surface still finished in
   * main and filled that cache, which is exactly what the next open serves.
   */
  async function openSurface(): Promise<void> {
    await load()
    const served = usage
    if (!served || !open) return
    if (Date.now() - served.measuredAt < STALE_AFTER_MS) return
    void load(true)
  }

  /** Whether an area is one main allows clearing, which narrows its id. */
  function isClearTarget(id: StorageAreaId): id is StorageClearTarget {
    return id === 'models' || id === 'recordings' || id === 'caches' || id === 'logs'
  }

  /** Run the area's one action, asking for confirmation when it destroys data. */
  function runAction(area: StorageArea): void {
    if (area.action === 'delete' && isClearTarget(area.id)) {
      clearTarget = area.id
      return
    }
    if (area.action === 'vacuum') {
      void compact()
      return
    }
    if (area.action === 'cleanup') {
      // The sweep follows the user's own retention and stays out of scopes an
      // agent is working in, so it gets its own explanation before it starts.
      cleanupConfirm = true
    }
  }

  /** Start the sweep, then step aside: its progress lives in the app's dock. */
  function startCleanup(): void {
    cleanupConfirm = false
    void cioCleanupStore.runNow()
    onClose()
  }

  /** Show one area's folder in the OS file manager, decided by main. */
  async function reveal(area: StorageAreaId | 'root'): Promise<void> {
    try {
      const opened = await invoke('storageManager:reveal', area)
      if (!opened) {
        toast.info('Nothing to show yet', {
          description: 'That folder has not been created on disk.'
        })
      }
    } catch (revealError: unknown) {
      reportError(revealError, 'The folder could not be shown.')
    }
  }

  /**
   * Confirm a clear: close the prompt at once, then work in the background.
   *
   * The dialog is a decision, not a progress view. Once the decision is made it
   * has no reason to hold the window, so it goes immediately, the row marks
   * itself busy, and the removal runs in the main process's worker. The result
   * lands as a toast, whether or not this surface is still on screen.
   */
  function confirmClear(): void {
    const target = clearTarget
    clearTarget = null
    if (!target || isClearing(target)) return
    startedClears = [...startedClears, target]
    void runClear(target)
  }

  /** Write a cleared area back as empty, so the panel answers the action at once. */
  function markAreaEmptied(target: StorageClearTarget): void {
    const current = usage
    if (!current) return
    const areas = current.areas.map((area) =>
      area.id === target ? { ...area, bytes: 0, files: 0 } : area
    )
    usage = {
      ...current,
      areas,
      reclaimableBytes: areas.reduce(
        (total, area) => (area.action === 'delete' ? total + area.bytes : total),
        0
      )
    }
  }

  /** Whether an area's removal is in flight, here or in another open of this surface. */
  function isClearing(target: StorageClearTarget): boolean {
    if (startedClears.includes(target)) return true
    return usage?.clearing.includes(target) ?? false
  }

  async function runClear(target: StorageClearTarget): Promise<void> {
    try {
      const result = await invoke('storageManager:clear', target)
      if (result.removedFiles === 0) {
        toast.info(`Nothing to remove from ${areaLabel(target)}`)
      } else {
        toast.success(`Freed ${formatBytes(result.freedBytes)}`, {
          description: `${result.removedFiles.toLocaleString()} files removed from ${areaLabel(target)}.`
        })
      }
      // The row that was cleared is empty now, so it says so immediately
      // instead of offering its button again until the new measurement lands.
      markAreaEmptied(target)
      void load(true)
    } catch (clearError: unknown) {
      reportError(clearError, 'The storage could not be cleared.')
    } finally {
      startedClears = startedClears.filter((entry) => entry !== target)
    }
  }

  /**
   * Hand the database's free pages back.
   *
   * Not destructive, so it needs no confirmation: it removes no row, and a
   * compaction that finds nothing to do costs nothing.
   */
  async function compact(): Promise<void> {
    compacting = true
    try {
      const result = await invoke('storageManager:vacuum')
      if (!result.ok) {
        reportError(
          new Error(result.error ?? 'The database could not be compacted.'),
          'The database could not be compacted.'
        )
        return
      }
      if (result.freedBytes > 0) {
        toast.success(`Handed back ${formatBytes(result.freedBytes)}`, {
          description: 'The database was compacted.'
        })
      } else {
        toast.info('The database is already compact')
      }
      void load(true)
    } catch (compactError: unknown) {
      reportError(compactError, 'The database could not be compacted.')
    } finally {
      compacting = false
    }
  }

  /** Label for the pending confirmation, read from the measured rows. */
  function areaLabel(target: StorageClearTarget): string {
    return areas.find((area) => area.id === target)?.label ?? 'this area'
  }
</script>

<Modal {open} title="Storage" {onClose} size="lg" contentClass="p-0">
  <div class="flex max-h-[75dvh] flex-col overflow-hidden">
    {#if error}
      <div class="shrink-0 border-b border-border px-5 py-2" role="alert">
        <p class="truncate text-xs text-danger" title={error}>{error}</p>
      </div>
    {/if}

    {#if checking && usage === null}
      <div class="flex h-64 flex-col items-center justify-center gap-3" aria-live="polite">
        <!-- The shared working mark, spun by the app's own `animate-spin`
          utility. A component-scoped keyframe here would not animate at all:
          the modal is projected into a native dialog window that receives the
          compiled stylesheet but not Svelte's per-component style blocks. -->
        <CioSpinner
          size={20}
          class="animate-spin text-primary"
          role="status"
          aria-label="Measuring app data"
        />
        <p class="text-xs text-dimmed">Measuring app data…</p>
      </div>
    {:else if areas.length === 0}
      <div class="flex h-64 items-center justify-center px-8 text-center">
        <div class="max-w-64">
          <CioDisk size={20} class="mx-auto text-muted" />
          <p class="mt-3 text-sm font-semibold text-foreground">No measurement yet</p>
          <p class="mt-1 text-xs leading-relaxed text-dimmed">
            Refresh to measure how the app's data folder is being used.
          </p>
        </div>
      </div>
    {:else}
      <div class="shrink-0 border-b border-border px-5 pt-4 pb-4">
        <div class="flex items-end justify-between gap-4">
          <div class="min-w-0">
            <p class="text-[0.625rem] tracking-wide text-dimmed uppercase">App data</p>
            <p class="mt-0.5 text-2xl font-semibold text-foreground tabular-nums">
              {formatBytes(total)}
            </p>
          </div>
          <div class="flex shrink-0 items-end gap-3">
            <div class="text-right">
              <p class="text-[0.625rem] tracking-wide text-dimmed uppercase">Reclaimable</p>
              <p class="mt-0.5 text-sm font-semibold text-foreground tabular-nums">
                {formatBytes(reclaimable)}
              </p>
            </div>
            <button
              type="button"
              class="flex h-7 w-7 items-center justify-center border border-border bg-elevated text-muted transition-colors hover:bg-overlay hover:text-foreground"
              title="Open the app data folder in the file manager"
              aria-label="Open the app data folder in the file manager"
              onclick={() => void reveal('root')}
            >
              <CioFolderOpen size={14} />
            </button>
          </div>
        </div>
        <!-- One bar for the whole folder, split by area. The rows below carry
               the same colour, so the bar reads as a legend rather than as a
               chart with its own separate key. -->
        <div
          class="mt-3 flex h-2 w-full gap-px overflow-hidden bg-raised"
          role="img"
          aria-label="Share of the app data folder by area"
        >
          {#each measuredAreas as area (area.id)}
            <span
              class="h-full"
              style="width: {sharePercent(area)}%; background: {AREA_COLORS[area.id]}"
              title={`${area.label}: ${formatBytes(area.bytes)}`}
            ></span>
          {/each}
        </div>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto">
        <ul>
          {#each areas as area (area.id)}
            {@const Icon = AREA_ICONS[area.id]}
            <!-- A row with nothing in it offers nothing to clear: a delete
                 button on an empty area would only ever report zero. A row
                 whose removal is running keeps its place but goes quiet: no
                 button, faded, until the toast says what was handed back. -->
            {@const busy =
              area.action === 'delete' && isClearTarget(area.id) && isClearing(area.id)}
            {@const clearable = area.bytes > 0 && !busy}
            <li
              class="flex items-start gap-3 border-b border-border px-5 py-3 transition-opacity last:border-b-0 {busy
                ? 'opacity-40'
                : ''}"
            >
              <span
                class="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center bg-raised"
                style="color: {AREA_COLORS[area.id]}"
              >
                <Icon size={15} />
              </span>
              <div class="min-w-0 flex-1">
                <div class="flex items-baseline justify-between gap-3">
                  <p class="truncate text-sm font-semibold text-foreground">{area.label}</p>
                  <p class="shrink-0 text-sm text-foreground tabular-nums">
                    {formatBytes(area.bytes)}
                  </p>
                </div>
                <p class="mt-1 text-xs leading-relaxed text-dimmed">{rowDetail(area)}</p>
                <div class="mt-1.5 flex items-center gap-2">
                  <span class="h-1 w-24 shrink-0 bg-raised" aria-hidden="true">
                    <span
                      class="block h-full"
                      style="width: {sharePercent(area)}%; background: {AREA_COLORS[area.id]}"
                    ></span>
                  </span>
                  <span class="text-[0.625rem] text-dimmed tabular-nums">
                    {shareLabel(area)} · {filesLabel(area)}
                  </span>
                </div>
              </div>
              <div class="mt-0.5 flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  class="flex h-7 w-7 items-center justify-center border border-transparent text-muted transition-colors hover:border-border hover:bg-overlay hover:text-foreground"
                  title={`Show the ${area.label} folder in the file manager`}
                  aria-label={`Show the ${area.label} folder in the file manager`}
                  onclick={() => void reveal(area.id)}
                >
                  <CioFolderOpen size={14} />
                </button>
                {#if area.action && area.actionLabel && clearable}
                  <button
                    type="button"
                    class="inline-flex h-7 shrink-0 items-center gap-1.5 border px-2 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 {area.action ===
                    'delete'
                      ? 'border-border text-danger hover:bg-danger/10'
                      : 'border-border bg-elevated text-muted hover:bg-overlay hover:text-foreground'}"
                    disabled={compacting}
                    title={`${area.actionLabel}: ${area.detail}`}
                    aria-label={`${area.actionLabel} for ${area.label}`}
                    onclick={() => runAction(area)}
                  >
                    {#if area.action === 'vacuum' && compacting}
                      <CioSpinner size={12} class="animate-spin" />
                    {/if}
                    {area.actionLabel}
                  </button>
                {/if}
              </div>
            </li>
          {/each}
        </ul>
      </div>
    {/if}
  </div>

  {#snippet footer()}
    <div class="flex w-full items-center justify-between gap-4">
      <div class="flex min-w-0 items-center gap-2">
        <button
          type="button"
          class="inline-flex h-8 items-center border border-border bg-elevated px-2.5 text-xs font-medium text-muted transition-colors hover:bg-overlay hover:text-foreground"
          title="Close the Storage manager"
          aria-label="Close the Storage manager"
          data-modal-dismiss
          onclick={onClose}
        >
          Close
        </button>
        <p class="min-w-0 truncate text-xs text-dimmed tabular-nums">
          {#if measuredAtLabel}
            {areas.length} areas · measured at {measuredAtLabel}
          {:else}
            Nothing measured yet
          {/if}
        </p>
      </div>
      <div class="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          class="inline-flex h-8 items-center gap-1.5 border border-border bg-elevated px-2.5 text-xs font-medium text-muted transition-colors hover:bg-overlay hover:text-foreground disabled:opacity-50"
          disabled={checking || compacting}
          title="Measure the data folder again"
          aria-label="Measure the data folder again"
          onclick={() => void load(true)}
        >
          {#if checking}
            <CioSpinner size={13} class="animate-spin" />
          {:else}
            <CioRefresh size={13} />
          {/if}
          Refresh
        </button>
      </div>
    </div>
  {/snippet}
</Modal>

<ConfirmDialog
  open={cleanupConfirm}
  title="Clean up conversation workspaces?"
  confirmLabel="Start cleanup"
  note="Cleanup follows your retention and your folder exclusions, and never touches a scope an agent is working in. Its progress shows in the app while it runs."
  onCancel={() => (cleanupConfirm = false)}
  onConfirm={startCleanup}
>
  <p>
    CIO Cleanup sweeps the scratch folders held for chats, assistants and browser tabs, and removes
    only what is older than the retention set in Settings{#if retentionDays > 0}&nbsp;({retentionDays}
      days){/if}.
  </p>
</ConfirmDialog>

<ConfirmDialog
  open={clearTarget !== null}
  title={clearCopy?.title ?? 'Delete this data?'}
  confirmLabel={clearCopy?.confirmLabel ?? 'Delete'}
  note={clearCopy?.note}
  onCancel={() => (clearTarget = null)}
  onConfirm={confirmClear}
>
  {#if clearCopy && clearTarget}
    <p>{clearCopy.body}</p>
    <p class="mt-2 font-medium text-foreground tabular-nums">
      {areaLabel(clearTarget)}: {formatBytes(
        areas.find((area) => area.id === clearTarget)?.bytes ?? 0
      )}
    </p>
  {/if}
</ConfirmDialog>
